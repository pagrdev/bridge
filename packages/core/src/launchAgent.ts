import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'dev.pagr.bridge';
export const LAUNCHCTL = '/bin/launchctl';

export interface LaunchAgentOptions {
  /**
   * Program + args to run. The first element must still exist at LAUNCH time, every time —
   * see `renderNodeLauncher`: baking a version-qualified Node path here is what `brew upgrade
   * node` deletes out from under launchd.
   */
  programArguments: string[];
  logsDir: string;
  /** `~/Library/LaunchAgents` by default. */
  launchAgentsDir?: string;
  env?: Record<string, string>;
  uid?: number;
  exec?: (file: string, args: string[]) => void;
  /** Test seam: whether `/bin/launchctl` exists. */
  hasLaunchctl?: () => boolean;
  /** Seconds launchd waits between (re)starts. Also the floor of the crash-loop backoff. */
  throttleIntervalSeconds?: number;
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
  | 'bootout'
  /** `pagr daemon start`/`stop` with no plist on disk. */
  | 'not_installed';

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

/**
 * launchd restarts the daemon when it exits 0 (a clean, self-requested restart) or dies on a
 * crash signal, and REFUSES to restart it after any non-zero exit. That is deliberate: a start
 * failure that cannot resolve itself — a denied Keychain, an unusable device key, an unparsable
 * config — used to be restarted every ~10s forever, and every attempt could raise its own
 * Keychain dialog. The other half of that contract lives in the daemon: it must exit non-zero
 * ONLY for failures a restart cannot fix, and never for a transient one (see DAEMON_EXIT).
 */
const KEEP_ALIVE = `    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <true/>
      <key>Crashed</key>
      <true/>
    </dict>`;

/** Seconds between launchd (re)starts — the floor of any restart loop. */
export const DEFAULT_THROTTLE_SECONDS = 30;

/**
 * The exit-code contract between the daemon and the `KeepAlive` policy above. Shared so the two
 * halves cannot drift.
 */
export const DAEMON_EXIT = {
  /** Clean stop. launchd starts it again after `ThrottleInterval` (used for self-restarts). */
  ok: 0,
  /**
   * Unrecoverable start failure: launchd will NOT restart. Everything that needs a human —
   * Keychain locked/denied, no device key, corrupt config, not paired, a live daemon already
   * holding the lock. `EX_CONFIG` from sysexits.h, which is also what launchd logs as
   * "Service could not initialize".
   */
  unrecoverable: 78,
} as const;

export function renderPlist(o: LaunchAgentOptions): string {
  const args = o.programArguments.map((a) => `      <string>${xml(a)}</string>`).join('\n');
  const env = Object.entries(o.env ?? {})
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  const throttle = Math.max(1, Math.round(o.throttleIntervalSeconds ?? DEFAULT_THROTTLE_SECONDS));
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
${KEEP_ALIVE}
    <key>ThrottleInterval</key>
    <integer>${throttle}</integer>
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

// ---------------------------------------------------------------------------
// Node launcher
// ---------------------------------------------------------------------------

/** The generated shell launcher that resolves Node at launch time. Lives under PAGR_HOME. */
export function nodeLauncherPath(home: string): string {
  return join(home, 'bin', 'pagr-node');
}

/**
 * Node candidates tried in order, resolved EVERY time launchd starts the job. A Homebrew or
 * nvm Node lives at a version-qualified path (`/opt/homebrew/Cellar/node/22.11.0/bin/node`,
 * `~/.nvm/versions/node/v22.11.0/bin/node`); baking one into the plist means `brew upgrade
 * node` deletes the binary launchd is holding, and the job then fails forever with no
 * explanation. The version-managed *symlinks* below survive those upgrades, and `command -v`
 * re-reads the PATH the plist carries, so an upgrade is picked up on the next launch.
 */
const NODE_CANDIDATES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
  '$home/.local/share/mise/shims/node',
  '$home/.asdf/shims/node',
  '$home/.volta/bin/node',
  '$home/.nvm/current/bin/node',
  '$home/.nvm/alias/default/bin/node',
  '$home/n/bin/node',
  '$home/.local/bin/node',
];

/** Node major the daemon needs; only used in the launcher's error message. */
const NODE_HINT_VERSION = 22;

/**
 * A tiny `/bin/sh` shim the launch agent runs instead of a hard-coded Node path. It execs the
 * first Node it can find, so a Node upgrade cannot strand the daemon, and it exits
 * `DAEMON_EXIT.unrecoverable` when there is none — which the KeepAlive policy above will not
 * restart, so a machine with no Node logs one clear line instead of looping forever.
 *
 * `fallbackNode` is the interpreter running the installer, tried LAST: it is the most likely
 * path to disappear, but it is better than nothing on an unusual install.
 */
export function renderNodeLauncher(fallbackNode?: string): string {
  const shq = (v: string) => `"${v.replace(/(["$`\\])/g, '\\$1')}"`;
  const candidates = [
    ...NODE_CANDIDATES.map((c) => `  "${c}" \\`),
    ...(fallbackNode ? [`  ${shq(fallbackNode)} \\`] : []),
  ].join('\n');
  return `#!/bin/sh
# Generated by 'pagr daemon install'. Do not edit — it is rewritten on every install.
#
# Resolves Node AT LAUNCH TIME. launchd keeps whatever path the plist names, so a plist that
# named a version-qualified Node (Homebrew, nvm, mise) broke the moment that Node was upgraded.
# Order: $PAGR_NODE, then the PATH the launch agent carries, then the usual absolute paths.
set -u

if [ -n "\${PAGR_NODE:-}" ] && [ -x "\${PAGR_NODE}" ]; then
  exec "\${PAGR_NODE}" "$@"
fi

home="\${HOME:-}"
node_bin=$(command -v node 2>/dev/null || true)
if [ -n "\${node_bin}" ] && [ -x "\${node_bin}" ]; then
  exec "\${node_bin}" "$@"
fi

for candidate in \\
${candidates}
  ; do
  if [ -x "\${candidate}" ]; then
    exec "\${candidate}" "$@"
  fi
done

echo "pagr: no usable node binary found (tried \\$PAGR_NODE, PATH=\${PATH:-}, and the usual install paths)." >&2
echo "pagr: install Node ${NODE_HINT_VERSION}+ (https://nodejs.org), or set PAGR_NODE, then run 'pagr daemon install' again." >&2
exit ${DAEMON_EXIT.unrecoverable}
`;
}

/**
 * Write (or rewrite) the launcher, 0700 under PAGR_HOME. Returns its path. Never throws a raw
 * fs error: a launcher that cannot be written is a `plist_write`-class install failure.
 */
export function writeNodeLauncher(home: string, fallbackNode?: string): string {
  const file = nodeLauncherPath(home);
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, renderNodeLauncher(fallbackNode), { mode: 0o700 });
    // writeFileSync honours umask on an existing file; make sure it stays executable.
    chmodSync(file, 0o700);
  } catch (err) {
    throw new LaunchAgentError('plist_write', `could not write ${file}`, {
      detail: err instanceof Error ? err.message : String(err),
      hint: `check that you own ${home} (\`ls -ld ${home}\`)`,
      cause: err,
    });
  }
  return file;
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
  // Both the thing launchd execs and the script it is handed have to be there at LAUNCH time.
  // A plist from before the node launcher names a version-qualified Node here, which is exactly
  // what `brew upgrade node` / `nvm install` deletes — launchd then loops on a missing binary.
  const program = facts.programArguments[0];
  if (program && !existsSync(program))
    return `it runs ${program}, which no longer exists (a Node upgrade, or an older install)`;
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

/** launchctl's ways of saying "no such job here". */
const NOT_LOADED =
  /could not find service|no such process|not find|not loaded|failed:\s*(3|113)\b/i;

export interface LaunchctlOptions {
  launchAgentsDir?: string;
  uid?: number;
  exec?: (file: string, args: string[]) => void;
  /** Test seam: whether `/bin/launchctl` exists. */
  hasLaunchctl?: () => boolean;
}

const NO_LAUNCHCTL = new LaunchAgentError('no_launchctl', `${LAUNCHCTL} is missing`, {
  hint: 'launchd only exists on macOS — run `pagr daemon run` in the foreground instead',
});

/**
 * Stop the running daemon and LEAVE the launch agent installed: `bootout` unloads the job now,
 * and because the plist stays in `~/Library/LaunchAgents` launchd loads it again at the next
 * login. `uninstallLaunchAgent` is the destructive one.
 */
export function stopLaunchAgent(
  o: LaunchctlOptions = {},
): 'stopped' | 'not_loaded' | 'not_installed' {
  if (!(o.hasLaunchctl ?? (() => existsSync(LAUNCHCTL)))()) throw NO_LAUNCHCTL;
  const exec = o.exec ?? defaultExec;
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const plist = launchAgentPlistPath(o.launchAgentsDir);
  try {
    exec(LAUNCHCTL, ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  } catch (err) {
    const detail = execDetail(err);
    if (!NOT_LOADED.test(detail))
      throw new LaunchAgentError('bootout', 'launchctl would not stop the pagr launch agent', {
        detail,
        hint: `run \`launchctl bootout gui/${uid}/${LAUNCH_AGENT_LABEL}\` yourself to see why`,
        cause: err,
      });
    return existsSync(plist) ? 'not_loaded' : 'not_installed';
  }
  return existsSync(plist) ? 'stopped' : 'not_installed';
}

/** Start (or restart) the installed launch agent without rewriting anything. */
export function startLaunchAgent(o: LaunchctlOptions = {}): 'started' | 'restarted' {
  if (!(o.hasLaunchctl ?? (() => existsSync(LAUNCHCTL)))()) throw NO_LAUNCHCTL;
  const exec = o.exec ?? defaultExec;
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const plist = launchAgentPlistPath(o.launchAgentsDir);
  if (!existsSync(plist))
    throw new LaunchAgentError('not_installed', `there is no launch agent at ${plist}`, {
      hint: 'run `pagr daemon install` first',
    });
  try {
    exec(LAUNCHCTL, ['bootstrap', `gui/${uid}`, plist]);
    return 'started';
  } catch (err) {
    const detail = execDetail(err);
    if (!ALREADY_BOOTSTRAPPED.test(detail))
      throw new LaunchAgentError('bootstrap', 'launchctl refused to start the pagr launch agent', {
        detail,
        hint: 'run `pagr daemon logs -n 50`, then `pagr daemon install` to rewrite the plist',
        cause: err,
      });
    // Already loaded: make sure it is actually RUNNING (a job can be loaded and stopped).
    try {
      exec(LAUNCHCTL, ['kickstart', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
      return 'restarted';
    } catch (kickErr) {
      throw new LaunchAgentError('bootstrap', 'the pagr launch agent is loaded but would not run', {
        detail: execDetail(kickErr),
        hint: `run \`launchctl bootout gui/${uid}/${LAUNCH_AGENT_LABEL}\` and then \`pagr daemon install\``,
        cause: kickErr,
      });
    }
  }
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
