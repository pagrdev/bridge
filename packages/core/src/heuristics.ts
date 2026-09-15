import fs from 'node:fs';
import path from 'node:path';

/**
 * Deterministic, local risk analysis of what an agent is about to do.
 *
 * Everything in this file runs on the Mac, on data the bridge read itself. Nothing here is ever
 * influenced by the cloud: the cloud sends opaque project ids and instruction text, never paths,
 * commands or verdicts. The adapters use it to annotate approval previews (`Hints`); the device
 * floor (`deviceFloor.ts`) extends it into the classification that decides what a cloud `allow`
 * is allowed to do.
 *
 * It used to live in duplicate inside each adapter package. One copy, in core, so there is one
 * place to audit and one place for the floor to build on.
 */

export interface Hints {
  touchesOutsideProject?: boolean;
  networkAccess?: boolean;
  destructive?: boolean;
  gitPush?: boolean;
  packageInstall?: boolean;
  secretsTouch?: boolean;
  productionHint?: boolean;
}

export const NETWORK = /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|http[s]?:\/\/)\b/i;
export const DESTRUCTIVE =
  /\b(rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)|rm\s+-r|rmdir|mkfs|dd\s+if=|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|branch\s+-D)|drop\s+(table|database)|truncate\s+table|db:(reset|drop))\b/i;
export const GIT_PUSH = /\bgit\s+push\b/i;
export const PKG_INSTALL =
  /\b(npm\s+(i|install|add)|pnpm\s+(i|install|add)|yarn\s+(add|install)|pip3?\s+install|brew\s+install|cargo\s+(add|install)|gem\s+install|apt(-get)?\s+install)\b/i;
/**
 * Credential and key material.
 *
 * Anchored on path shapes, not on the bare words `secret` / `token` / `credentials` appearing
 * anywhere. It used to match those as substrings, which was tolerable while this only tinted a
 * preview — but the device floor refuses on it now, and `src/auth/token.ts` is an ordinary source
 * file. Matching it would have made editing one require a config change.
 */
export const SECRETS =
  /(^|[/\s"'=(])\.env(\.[\w-]+)?($|[/\s"')])|(^|\/)(\.aws|\.ssh|\.gnupg|\.npmrc|\.netrc|\.pgpass|\.authinfo|\.git-credentials|credentials|id_(rsa|dsa|ecdsa|ed25519))($|[/\s"':])|\.(pem|p12|pfx|jks|keystore)($|[/\s"':])|\bkeychain\b|\bsecurity\s+(find|add|delete|dump)-(generic|internet)-password\b|(?:^|[^A-Za-z])(access|api|secret|private|service)[_-]?(key|token|role)(?![A-Za-z])/i;
export const PRODUCTION =
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

/** Absolute paths mentioned anywhere in a shell command. */
export function absolutePathsIn(command: string): string[] {
  return (command.match(/(?:^|\s|=|["'])(\/[^\s"']+)/g) ?? []).map((m) =>
    m.replace(/^[\s="']+/, ''),
  );
}

/**
 * Resolve symlinks for containment checks. For not-yet-existing paths the nearest existing
 * ancestor is resolved, so `/tmp/x/new.ts` and `/private/tmp/x/new.ts` compare equal on macOS.
 */
export function realpathNearest(p: string): string {
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
