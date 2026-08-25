import fs from 'node:fs';
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

/**
 * Resolve symlinks for containment checks. For not-yet-existing paths the nearest existing
 * ancestor is resolved, so `/tmp/x/new.ts` and `/private/tmp/x/new.ts` compare equal on macOS.
 */
function realpathNearest(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return path.join(cur, ...tail);
  }
}

/** True when `p` is `root` or lives under it, after realpath resolution of both sides. */
export function isInside(p: string, root: string): boolean {
  const rel = path.relative(realpathNearest(root), realpathNearest(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Rewrite absolute paths that live inside the project root (in any alias form: symlinked or
 * realpath, e.g. `/tmp/x` vs `/private/tmp/x`) as project-relative so previews never carry
 * the user's local directory layout to the cloud. The root itself becomes `.`; paths that merely
 * share a prefix (`/root-other`) or lie outside are left untouched.
 */
export function relativizePaths(text: string, projectPath?: string): string {
  if (!projectPath) return text;
  const root = realpathNearest(projectPath);
  return text.replace(/(^|[\s="'(:,])(\/[^\s"'():,]+)/g, (m, lead: string, p: string) => {
    if (!isInside(p, projectPath)) return m;
    const rel = path.relative(root, realpathNearest(p));
    return `${lead}${rel === '' ? '.' : rel}`;
  });
}

/** Truncate for user-facing previews/summaries. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
