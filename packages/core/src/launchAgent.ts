import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'dev.pagr.bridge';
export const LAUNCHCTL = '/bin/launchctl';

export interface LaunchAgentOptions {
  /** Program + args to run, e.g. [process.execPath, '/path/to/pagr.js', 'daemon', 'run']. */
  programArguments: string[];
  logsDir: string;
  /** `~/Library/LaunchAgents` by default. */
  launchAgentsDir?: string;
  env?: Record<string, string>;
  uid?: number;
  exec?: (file: string, args: string[]) => void;
  /** Test seam: whether `/bin/launchctl` exists. */
  hasLaunchctl?: () => boolean;
}

const defaultExec = (file: string, args: string[]) => {
  execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
};

export type LaunchAgentErrorCode =
  /** No `/bin/launchctl`: not macOS, or a stripped container. */
  | 'no_launchctl'
  /** The plist could not be written (permissions / read-only home). */
  | 'plist_write'
  /** `launchctl bootstrap` refused. */
  | 'bootstrap'
  /** `launchctl bootout` refused while something still held the service. */
  | 'bootout';

export class LaunchAgentError extends Error {
  readonly hint: string | undefined;
  readonly detail: string | undefined;
  constructor(
    readonly code: LaunchAgentErrorCode,
    message: string,
    o: { hint?: string; detail?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'LaunchAgentError';
    this.hint = o.hint;
    this.detail = o.detail;
    if (o.cause !== undefined) this.cause = o.cause;
  }
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderPlist(o: LaunchAgentOptions): string {
  const args = o.programArguments.map((a) => `      <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries(o.env ?? {})
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(join(o.logsDir, 'launchd.out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(o.logsDir, 'launchd.err.log'))}</string>
${env ? `    <key>EnvironmentVariables</key>\n    <dict>\n${env}\n    </dict>\n` : ''}  </dict>
</plist>
`;
}

export function launchAgentPlistPath(
  launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents'),
): string {
  return join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
}

/** Very small plist reader: enough to tell a stale agent from a current one. */
export function readPlistFacts(plistPath: string): {
  programArguments: string[];
  env: Record<string, string>;
} | null {
  let text: string;
  try {
    text = readFileSync(plistPath, 'utf8');
  } catch {
    return null;
  }
  const unxml = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  const arrayBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const programArguments = arrayBlock?.[1]
    ? [...arrayBlock[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1] ?? ''))
    : [];
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
  const env: Record<string, string> = {};
  if (envBlock?.[1])
    for (const m of envBlock[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g))
      env[unxml(m[1] ?? '')] = unxml(m[2] ?? '');
  return { programArguments, env };
}

/**
 * A plist written by an older install (different binary path, different PAGR_HOME, or a
 * `pagr` binary that no longer exists) keeps launchd restarting the wrong thing forever.
 */
export function launchAgentStaleReason(
  plistPath: string,
  expected: { programArguments: string[]; env?: Record<string, string> },
): string | null {
  const facts = readPlistFacts(plistPath);
  if (!facts) return null;
  const binPath = facts.programArguments[1];
  if (binPath && !existsSync(binPath))
    return `it runs ${binPath}, which no longer exists (an older or removed install)`;
  const expectedHome = expected.env?.PAGR_HOME;
  const actualHome = facts.env.PAGR_HOME;
  if (expectedHome && actualHome && expectedHome !== actualHome)
    return `it points at PAGR_HOME=${actualHome}, but this CLI uses ${expectedHome}`;
  if (
    facts.programArguments.length > 0 &&
    !sameArgs(facts.programArguments, expected.programArguments)
  )
    return 'its ProgramArguments differ from what this CLI would install';
  return null;
}

const sameArgs = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const execDetail = (err: unknown): string => {
  const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
  const stdout = String((err as { stdout?: unknown }).stdout ?? '').trim();
  return (stderr || stdout || (err instanceof Error ? err.message : String(err))).slice(0, 300);
};

/** launchd's several ways of saying "that job is already there" (errno 37 = EBUSY-ish). */
const ALREADY_BOOTSTRAPPED =
  /already bootstrapped|already loaded|operation already in progress|failed:\s*37\b/i;

/**
 * Write the plist and `launchctl bootstrap gui/$UID <plist>`. Re-bootstraps if already loaded.
 * Failures come back as `LaunchAgentError` with launchctl's own words plus a fix.
 */
export function installLaunchAgent(o: LaunchAgentOptions): string {
  const exec = o.exec ?? defaultExec;
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const plist = launchAgentPlistPath(o.launchAgentsDir);
  if (!(o.hasLaunchctl ?? (() => existsSync(LAUNCHCTL)))())
    throw new LaunchAgentError('no_launchctl', `${LAUNCHCTL} is missing`, {
      hint: 'the background daemon needs launchd (macOS). Run `pagr daemon run` in the foreground, or re-run `pagr connect --no-daemon`',
    });
  try {
    mkdirSync(join(plist, '..'), { recursive: true });
    mkdirSync(o.logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(plist, renderPlist(o), { mode: 0o644 });
  } catch (err) {
    throw new LaunchAgentError('plist_write', `could not write ${plist}`, {
      detail: err instanceof Error ? err.message : String(err),
      hint: `check that you own ~/Library/LaunchAgents (\`ls -ld ~/Library/LaunchAgents\`)`,
      cause: err,
    });
  }
  try {
    exec(LAUNCHCTL, ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    // not loaded yet — expected on a first install
  }
  try {
    exec(LAUNCHCTL, ['bootstrap', `gui/${uid}`, plist]);
  } catch (err) {
    const detail = execDetail(err);
    // A service that survived `bootout` (e.g. a wedged job) is already running the right plist;
    // kick it so it picks up the file we just wrote rather than failing the whole install.
    if (ALREADY_BOOTSTRAPPED.test(detail)) {
      try {
        exec(LAUNCHCTL, ['kickstart', '-k', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
        return plist;
      } catch (kickErr) {
        throw new LaunchAgentError(
          'bootstrap',
          'the pagr launch agent is already loaded and would not restart',
          {
            detail: execDetail(kickErr),
            hint: `run \`launchctl bootout gui/${uid}/${LAUNCH_AGENT_LABEL}\` and then \`pagr daemon install\` again`,
            cause: kickErr,
          },
        );
      }
    }
    throw new LaunchAgentError('bootstrap', 'launchctl refused to start the pagr launch agent', {
      detail,
      hint: `check ${join(o.logsDir, 'launchd.err.log')}, then retry \`pagr daemon install\`. Foreground fallback: \`pagr daemon run\``,
      cause: err,
    });
  }
  return plist;
}

export function uninstallLaunchAgent(
  o: Pick<LaunchAgentOptions, 'launchAgentsDir' | 'uid' | 'exec'> = {},
): boolean {
  const exec = o.exec ?? defaultExec;
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const plist = launchAgentPlistPath(o.launchAgentsDir);
  try {
    exec(LAUNCHCTL, ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    // not loaded
  }
  if (!existsSync(plist)) return false;
  unlinkSync(plist);
  return true;
}
