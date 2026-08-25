import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'dev.pagr.bridge';

export interface LaunchAgentOptions {
  /** Program + args to run, e.g. [process.execPath, '/path/to/pagr.js', 'daemon', 'run']. */
  programArguments: string[];
  logsDir: string;
  /** `~/Library/LaunchAgents` by default. */
  launchAgentsDir?: string;
  env?: Record<string, string>;
  uid?: number;
  exec?: (file: string, args: string[]) => void;
}

const defaultExec = (file: string, args: string[]) => {
  execFileSync(file, args, { stdio: 'ignore' });
};

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

/** Write the plist and `launchctl bootstrap gui/$UID <plist>`. Re-bootstraps if already loaded. */
export function installLaunchAgent(o: LaunchAgentOptions): string {
  const exec = o.exec ?? defaultExec;
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const plist = launchAgentPlistPath(o.launchAgentsDir);
  mkdirSync(join(plist, '..'), { recursive: true });
  mkdirSync(o.logsDir, { recursive: true, mode: 0o700 });
  writeFileSync(plist, renderPlist(o), { mode: 0o644 });
  try {
    exec('/bin/launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    // not loaded yet
  }
  exec('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist]);
  return plist;
}

export function uninstallLaunchAgent(
  o: Pick<LaunchAgentOptions, 'launchAgentsDir' | 'uid' | 'exec'> = {},
): boolean {
  const exec = o.exec ?? defaultExec;
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const plist = launchAgentPlistPath(o.launchAgentsDir);
  try {
    exec('/bin/launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    // not loaded
  }
  if (!existsSync(plist)) return false;
  unlinkSync(plist);
  return true;
}
