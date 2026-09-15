import {
  installLaunchAgent,
  nodeLauncherPath,
  readPlistFacts,
  writeNodeLauncher,
} from '@pagr/bridge-core';
import type { CliContext } from './context.js';

/**
 * Exactly what this CLI would install right now. `connect`, `daemon install` and `doctor` all
 * read it from here, so the staleness check can never drift from what the installer writes.
 *
 * `programArguments[0]` is the generated shell launcher, not `process.execPath`: a plist that
 * names a version-qualified Node (Homebrew, nvm, mise) dies the moment that Node is upgraded,
 * and launchd then loops on a missing binary. The launcher resolves Node at every launch.
 */
export interface LaunchAgentPlan {
  launcherPath: string;
  programArguments: string[];
  env: Record<string, string>;
}

export function launchAgentPlan(ctx: CliContext): LaunchAgentPlan {
  return {
    launcherPath: nodeLauncherPath(ctx.home),
    programArguments: [nodeLauncherPath(ctx.home), ctx.binPath, 'daemon', 'run'],
    env: { PAGR_HOME: ctx.home, ...(ctx.env.PATH ? { PATH: ctx.env.PATH } : {}) },
  };
}

/** Write the Node launcher, then write + bootstrap the plist. Returns the plist path. */
export function installAgent(ctx: CliContext, logsDir: string): string {
  const plan = launchAgentPlan(ctx);
  writeNodeLauncher(ctx.home, process.execPath);
  return installLaunchAgent({
    programArguments: plan.programArguments,
    logsDir,
    env: plan.env,
    exec: (f, a) => void ctx.exec(f, a),
    hasLaunchctl: () => ctx.hasLaunchctl(),
    ...(ctx.launchAgentsDir ? { launchAgentsDir: ctx.launchAgentsDir } : {}),
  });
}

// ---------------------------------------------------------------------------
// Provider credentials that only exist in the user's shell
// ---------------------------------------------------------------------------

/**
 * Environment variables that decide whether `claude` and `codex` consider themselves signed in
 * (or where they look). launchd gives a launch agent a minimal environment — nothing from
 * `.zshrc`/`.zprofile` — so an agent authenticated by one of these works in the user's terminal
 * and looks signed out from their phone, with nothing on screen to explain it.
 *
 * Pagr does NOT copy them into the launch agent. The plist is a plain file that every process
 * on the Mac can read, and "the bridge never touches your provider credentials" is a promise
 * worth more than the convenience. So: detect, name, and explain. `secret: false` marks the
 * ones that are only settings — those are safe to add to the agent by hand.
 */
export interface AgentEnvVar {
  name: string;
  secret: boolean;
  agent: 'claude' | 'codex' | 'both';
}

export const AGENT_ENV_VARS: readonly AgentEnvVar[] = [
  { name: 'ANTHROPIC_API_KEY', secret: true, agent: 'claude' },
  { name: 'ANTHROPIC_AUTH_TOKEN', secret: true, agent: 'claude' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', secret: true, agent: 'claude' },
  { name: 'ANTHROPIC_BASE_URL', secret: false, agent: 'claude' },
  { name: 'CLAUDE_CODE_USE_BEDROCK', secret: false, agent: 'claude' },
  { name: 'CLAUDE_CODE_USE_VERTEX', secret: false, agent: 'claude' },
  { name: 'AWS_PROFILE', secret: false, agent: 'claude' },
  { name: 'AWS_ACCESS_KEY_ID', secret: true, agent: 'claude' },
  { name: 'GOOGLE_APPLICATION_CREDENTIALS', secret: false, agent: 'claude' },
  { name: 'OPENAI_API_KEY', secret: true, agent: 'codex' },
  { name: 'OPENAI_BASE_URL', secret: false, agent: 'codex' },
  { name: 'CODEX_HOME', secret: false, agent: 'codex' },
  { name: 'CODEX_API_KEY', secret: true, agent: 'codex' },
] as const;

export interface EnvGap {
  name: string;
  secret: boolean;
  agent: 'claude' | 'codex' | 'both';
}

/**
 * Variables this shell has that the launch agent does not. `agentEnv` is the plist's
 * `EnvironmentVariables` dict (empty when there is no plist yet).
 */
export function agentEnvGaps(
  shellEnv: NodeJS.ProcessEnv,
  agentEnv: Record<string, string>,
): EnvGap[] {
  const gaps: EnvGap[] = [];
  for (const v of AGENT_ENV_VARS) {
    const value = shellEnv[v.name];
    if (value === undefined || value === '') continue;
    if (agentEnv[v.name] !== undefined) continue;
    gaps.push({ name: v.name, secret: v.secret, agent: v.agent });
  }
  return gaps;
}

/** The installed agent's environment, or `null` when no plist is installed. */
export function installedAgentEnv(plistPath: string): Record<string, string> | null {
  return readPlistFacts(plistPath)?.env ?? null;
}

/** One line naming the gaps — never their values. */
export function describeEnvGaps(gaps: EnvGap[]): string {
  return gaps.map((g) => g.name).join(', ');
}

export const ENV_GAP_FIX =
  'the background daemon runs under launchd and never sees your shell profile. Sign the agent in on disk instead (`claude setup-token` / `codex login`), or, for non-secret settings only, add them yourself with `launchctl setenv NAME value` — pagr will not copy credentials into the launch agent (see docs/TROUBLESHOOTING.md)';
