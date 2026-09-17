import path from 'node:path';

/**
 * Where Claude Code keeps what it wrote down, and how those names are spelled.
 *
 * Every function here is pure and takes `home` explicitly. Nothing in the transcript mirror is
 * allowed to reach for `os.homedir()` on its own: the tests run against a synthetic `~/.claude`
 * in a temp directory, and a single implicit `homedir()` anywhere would have them reading the
 * user's real sessions.
 */

/**
 * Claude's directory name for a working tree: `/`, space and `.` all become `-`.
 *
 * It is one-way — `-Users-me-my-app` could have been half a dozen paths — so the bridge only ever
 * encodes, never decodes. When the cwd matters (and it always does: it decides which project a
 * session belongs to) it is taken from the record's own `cwd` field, never from this name.
 *
 * Verified 2026-09-17: cwd `/private/tmp/mob033-verify` produced
 * `~/.claude/projects/-private-tmp-mob033-verify/<session id>.jsonl`.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/ .]/g, '-');
}

/** `~/.claude/projects` — the root every transcript and every spill file must live under. */
export function projectsDir(home: string): string {
  return path.join(home, '.claude', 'projects');
}

/**
 * `~/.claude/sessions` — one `<pid>.json` per live Claude process (mode 0644).
 *
 * The sibling `<pid>.<hash>.key` files are 0600 and are Claude's own messaging secrets. The
 * mirror never opens them; `readPidFile` refuses anything that is not `<digits>.json`.
 */
export function sessionsDir(home: string): string {
  return path.join(home, '.claude', 'sessions');
}

/** `~/.claude/sessions/<pid>.json` — what Claude Code writes for every interactive process. */
export function pidSessionFile(home: string, pid: number): string {
  return path.join(sessionsDir(home), `${pid}.json`);
}

export function projectDirFor(home: string, cwd: string): string {
  return path.join(projectsDir(home), encodeProjectDir(cwd));
}

/** The session's own transcript: `~/.claude/projects/<encoded cwd>/<session id>.jsonl`. */
export function sessionFile(home: string, cwd: string, claudeSessionId: string): string {
  return path.join(projectDirFor(home, cwd), `${claudeSessionId}.jsonl`);
}

/** Where a tool output too large for the transcript is spilled. */
export function spillDir(home: string, cwd: string, claudeSessionId: string): string {
  return path.join(projectDirFor(home, cwd), claudeSessionId, 'tool-results');
}

/** Where a session's subagents keep their own transcripts (`agent-<id>.jsonl`). */
export function subagentsDir(home: string, cwd: string, claudeSessionId: string): string {
  return path.join(projectDirFor(home, cwd), claudeSessionId, 'subagents');
}

/** `agent-<id>.jsonl` → `agent-<id>.meta.json`, verified on this Mac 2026-09-17. */
export function subagentMetaFile(transcriptFile: string): string {
  return transcriptFile.replace(/\.jsonl$/, '.meta.json');
}

/**
 * A transcript file name, live or superseded, and the session it belongs to.
 *
 * Claude leaves `<session>.jsonl.superseded-<timestamp>` behind when it rewrites a transcript,
 * and orphaned variants of the same shape turn up too. All of them are the SAME session as far as
 * the mirror is concerned — which is why the name is only a hint: the records inside carry
 * `sessionId`, and that is what decides where their frames go.
 */
export function sessionIdOfTranscript(fileName: string): string | null {
  const m = /^([0-9a-fA-F-]{8,})\.jsonl(?:\.superseded-.+)?$/.exec(fileName);
  return m?.[1] ?? null;
}

/** True for `<session>.jsonl` exactly — the file Claude is appending to right now. */
export function isLiveTranscriptName(fileName: string): boolean {
  return /^[0-9a-fA-F-]{8,}\.jsonl$/.test(fileName);
}

/** `agent-<id>.jsonl` → `<id>`; anything else → null. */
export function subagentIdOfFile(fileName: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(fileName);
  return m?.[1] ?? null;
}

/** `<pid>.json` → the pid. Never matches a `.key` file, whose name carries a hash segment. */
export function pidOfSessionFile(fileName: string): number | null {
  const m = /^(\d+)\.json$/.exec(fileName);
  if (!m?.[1]) return null;
  const pid = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
