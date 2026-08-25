import path from 'node:path';

export interface Hints {
  touchesOutsideProject?: boolean;
  networkAccess?: boolean;
  destructive?: boolean;
  gitPush?: boolean;
  packageInstall?: boolean;
  secretsTouch?: boolean;
  productionHint?: boolean;
}

const NETWORK = /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|http[s]?:\/\/)\b/i;
const DESTRUCTIVE =
  /\b(rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)|rm\s+-r|rmdir|mkfs|dd\s+if=|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|branch\s+-D)|drop\s+(table|database)|truncate\s+table|db:(reset|drop))\b/i;
const GIT_PUSH = /\bgit\s+push\b/i;
const PKG_INSTALL =
  /\b(npm\s+(i|install|add)|pnpm\s+(i|install|add)|yarn\s+(add|install)|pip3?\s+install|brew\s+install|cargo\s+(add|install)|gem\s+install|apt(-get)?\s+install)\b/i;
const SECRETS =
  /(\.env(\.|\b)|credentials|secret|token|\.pem\b|\.key\b|id_rsa|keychain|\.npmrc|\.netrc)/i;
const PRODUCTION =
  /\b(prod|production|--prod\b|release|deploy|migrate|db:migrate|main\b.*push|live)\b/i;

/** Deterministic, conservative risk hints for a shell command. */
export function hintsForCommand(command: string, cwd?: string, projectPath?: string): Hints {
  const h: Hints = {};
  if (NETWORK.test(command)) h.networkAccess = true;
  if (DESTRUCTIVE.test(command)) h.destructive = true;
  if (GIT_PUSH.test(command)) h.gitPush = true;
  if (PKG_INSTALL.test(command)) h.packageInstall = true;
  if (SECRETS.test(command)) h.secretsTouch = true;
  if (PRODUCTION.test(command)) h.productionHint = true;
  if (projectPath) {
    const outside = absolutePathsIn(command).some((p) => !isInside(p, projectPath));
    if (outside || (cwd && !isInside(cwd, projectPath))) h.touchesOutsideProject = true;
  }
  return h;
}

/** Hints for a set of file paths about to be changed. */
export function hintsForFiles(files: string[], projectPath?: string): Hints {
  const h: Hints = {};
  for (const f of files) {
    if (SECRETS.test(f)) h.secretsTouch = true;
    if (projectPath && path.isAbsolute(f) && !isInside(f, projectPath)) {
      h.touchesOutsideProject = true;
    }
  }
  return h;
}

function absolutePathsIn(command: string): string[] {
  return (command.match(/(?:^|\s|=|["'])(\/[^\s"']+)/g) ?? []).map((m) =>
    m.replace(/^[\s="']+/, ''),
  );
}

function isInside(p: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Truncate for user-facing previews/summaries. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
