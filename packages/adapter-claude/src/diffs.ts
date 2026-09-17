import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiffHunk, FrameBody } from '@pagr/bridge-core';

/**
 * Diffs and terminal output for Claude's frames — from Claude's own record of what it did.
 *
 * The bridge does not re-read the file and diff it: by the time a frame is built the file has
 * moved on, and a diff computed after the fact would show whatever else has happened since.
 * Claude already writes down exactly what it changed, twice:
 *
 *   - on the `user` stream-json line as `tool_use_result` (verified 2026-09-17 on Claude Code
 *     2.1.220 with `--verbose`, which the bridge already passes — so this is the normal path and
 *     no file is read);
 *   - in the session transcript as `toolUseResult` (same object, camelCase), which is the fallback
 *     for a CLI that does not put it on the wire, and the only source for a terminal session the
 *     bridge is mirroring rather than driving (B5).
 *
 * Last resort, when neither has it: a hunk reconstructed from `old_string`/`new_string`, marked
 * `approx` so the phone never presents a guess as Claude's own patch.
 */

/** Tools whose result is a file change. `MultiEdit` is not a 2.1.220 tool; older installs have it. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Claude's `toolUseResult`, as much of it as the bridge reads. Every field is optional on purpose:
 * this is another program's record format, and a missing field is a fallback, never a crash.
 */
export interface ClaudeToolUseResult {
  /** `create` for a Write that made a new file. */
  type?: string;
  filePath?: string;
  content?: string;
  originalFile?: string | null;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  structuredPatch?: unknown;
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  /** Where a large Bash output was spilled, under `<transcript dir>/<session>/tool-results/`. */
  persistedOutputPath?: string;
  persistedOutputSize?: number;
}

/** Narrow the sidecar to an object, or null. Strings (`"User rejected tool use"`) are not results. */
export function asToolUseResult(v: unknown): ClaudeToolUseResult | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as ClaudeToolUseResult) : null;
}

// ---------- diffs ----------

type DiffBody = Extract<FrameBody, { kind: 'diff' }>;

/** Claude's hunks, kept only where they are actually shaped like hunks. */
export function normalizeHunks(v: unknown): DiffHunk[] {
  if (!Array.isArray(v)) return [];
  const out: DiffHunk[] = [];
  for (const h of v) {
    if (!h || typeof h !== 'object') continue;
    const o = h as Record<string, unknown>;
    if (!Array.isArray(o.lines)) continue;
    out.push({
      oldStart: int(o.oldStart),
      oldLines: int(o.oldLines),
      newStart: int(o.newStart),
      newLines: int(o.newLines),
      lines: o.lines.map((l) => String(l)),
    });
  }
  return out;
}

const int = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

/**
 * A unified hunk built from a replacement alone: every old line removed, every new line added.
 *
 * There is no context and no true line number to be had — the replacement strings say what changed
 * but not where — so the hunk starts at 1 and the body that carries it is marked `approx`. It is
 * the honest shape of what the bridge actually knows.
 */
export function unifiedFromReplace(oldString: string, newString: string): DiffHunk[] {
  const oldLines = splitLines(oldString);
  const newLines = splitLines(newString);
  if (oldLines.length === 0 && newLines.length === 0) return [];
  return [
    {
      oldStart: 1,
      oldLines: oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)],
    },
  ];
}

const splitLines = (s: string): string[] => {
  if (!s) return [];
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Apply Claude's own replacement so the frame can carry the resulting text, not just hunks. */
function applyReplace(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | undefined {
  if (!oldString || !original.includes(oldString)) return undefined;
  return replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);
}

export interface DiffSourceInput {
  toolName: string;
  /** The `tool_use` block's own input, for the paths and strings a result may not carry. */
  input: Record<string, unknown>;
  result: ClaudeToolUseResult | null;
}

/**
 * The `diff` body for one file-changing tool call, or null when there is nothing to show.
 *
 * `hunks` are Claude's when Claude supplied them. `oldText`/`newText` are the whole file before and
 * after, which is what lets the phone render a real side-by-side rather than a patch — and they are
 * only ever filled from the record, never re-read from disk.
 */
export function diffBodyFor({ toolName, input, result }: DiffSourceInput): DiffBody | null {
  if (!EDIT_TOOLS.has(toolName)) return null;
  const file =
    result?.filePath ?? str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? '';
  if (!file) return null;

  const hunks = normalizeHunks(result?.structuredPatch);
  const original = typeof result?.originalFile === 'string' ? result.originalFile : undefined;

  if (toolName === 'Write') {
    const content = result?.content ?? str(input.content) ?? '';
    // `type: 'create'` and a null `originalFile` are the same fact said twice; either is enough.
    const created = result?.type === 'create' || result?.originalFile === null;
    const body: DiffBody = {
      kind: 'diff',
      path: file,
      changeKind: created || original === undefined ? 'add' : 'update',
      newText: content,
      ...(original !== undefined ? { oldText: original } : {}),
      ...(hunks.length ? { hunks } : {}),
    };
    return body;
  }

  const oldString = result?.oldString ?? str(input.old_string) ?? '';
  const newString = result?.newString ?? str(input.new_string) ?? '';
  const replaceAll = result?.replaceAll === true || input.replace_all === true;

  if (hunks.length || original !== undefined) {
    const after =
      original !== undefined ? applyReplace(original, oldString, newString, replaceAll) : undefined;
    return {
      kind: 'diff',
      path: file,
      changeKind: 'update',
      ...(original !== undefined ? { oldText: original } : {}),
      ...(after !== undefined ? { newText: after } : {}),
      ...(hunks.length ? { hunks } : {}),
    };
  }

  // Nothing from Claude: reconstruct what we can and say that we did.
  const fallback = multiEditHunks(toolName, input, oldString, newString);
  if (!fallback.length) return null;
  return { kind: 'diff', path: file, changeKind: 'update', hunks: fallback, approx: true };
}

/** `MultiEdit` carries a list of replacements; every other edit tool carries exactly one. */
function multiEditHunks(
  toolName: string,
  input: Record<string, unknown>,
  oldString: string,
  newString: string,
): DiffHunk[] {
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.flatMap((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      return unifiedFromReplace(str(o.old_string) ?? '', str(o.new_string) ?? '');
    });
  }
  const newSource = newString || (str(input.new_source) ?? '');
  const oldSource = oldString || (str(input.old_source) ?? '');
  return unifiedFromReplace(oldSource, newSource);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---------- terminal ----------

type TerminalBody = Extract<FrameBody, { kind: 'terminal' }>;

/**
 * The `terminal` body for a Bash call: the command as issued, and its streams kept apart.
 *
 * With `tool_use_result` the split is Claude's own. Without it, all there is is the combined blob
 * the model was shown, and it goes to the stream the `is_error` flag says it came from — guessing
 * a split out of one string would invent structure that is not there.
 */
export function terminalBodyFor(input: {
  command: string;
  content: string;
  isError: boolean;
  result: ClaudeToolUseResult | null;
  /** Full spilled output, when `persistedOutputPath` pointed somewhere readable. */
  spilled?: string | null;
}): TerminalBody {
  const { command, content, isError, result, spilled } = input;
  if (!result) {
    return {
      kind: 'terminal',
      command,
      stdout: isError ? '' : content,
      stderr: isError ? content : '',
      interrupted: false,
    };
  }
  return {
    kind: 'terminal',
    command,
    stdout: spilled ?? result.stdout ?? '',
    stderr: result.stderr ?? '',
    interrupted: result.interrupted === true,
  };
}

// ---------- spilled output ----------

/** Most of a spill file the bridge will take into a frame body. */
export const MAX_PERSISTED_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Read a `persistedOutputPath`, but only from inside Claude's own transcript tree.
 *
 * The path comes out of another program's JSON, so it is a value from outside this process and is
 * treated as one: it is resolved through `realpath` (symlinks and `..` included) and refused
 * unless it lands under `~/.claude/projects`. Anything else — `/etc/…`, a symlink out of the tree,
 * a path on another volume — reads as absent rather than as a file the bridge will seal and send.
 *
 * Over the cap it is the TAIL that is kept: a 40 MiB test run ends with the failure.
 */
export function readPersistedOutput(
  filePath: string,
  opts: { home?: string; maxBytes?: number } = {},
): string | null {
  const home = opts.home ?? os.homedir();
  const max = opts.maxBytes ?? MAX_PERSISTED_OUTPUT_BYTES;
  let root: string;
  let real: string;
  try {
    root = fs.realpathSync(path.join(home, '.claude', 'projects'));
    real = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  try {
    const size = fs.statSync(real).size;
    if (size <= max) return fs.readFileSync(real, 'utf8');
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.allocUnsafe(max);
      fs.readSync(fd, buf, 0, max, size - max);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ---------- transcript fallback ----------

/**
 * Claude's directory name for a working tree: `/`, space and `.` all become `-`.
 *
 * It is one-way — `-Users-me-my-app` could have been half a dozen paths — so the bridge only ever
 * encodes, never decodes. Verified 2026-09-17: cwd `/private/tmp/mob033-verify` produced
 * `~/.claude/projects/-private-tmp-mob033-verify/<session id>.jsonl`.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/ .]/g, '-');
}

/** Where a bridge-spawned session's transcript lives. The bridge chose the session id, so it knows. */
export function transcriptPathFor(home: string, cwd: string, claudeSessionId: string): string {
  return path.join(home, '.claude', 'projects', encodeProjectDir(cwd), `${claudeSessionId}.jsonl`);
}

/** How much of the tail of a transcript is scanned for a result. */
export const TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024;

export interface TranscriptLookupOptions {
  /** `$HOME`; tests point this at a temp directory holding a synthetic transcript. */
  home: string;
  cwd: string;
  claudeSessionId: string;
  /** Longest to wait for the record to appear. */
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Find Claude's own `toolUseResult` for a tool call in the session's transcript.
 *
 * Only needed when the result did not ride on the stream-json line. The record is written when the
 * tool finishes, which can be a moment after the bridge has seen the `tool_result` block, so the
 * lookup waits — but briefly and with a hard ceiling, because a diff that never arrives must cost
 * a less precise diff, never a stalled transcript.
 */
export class TranscriptResultLookup {
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly opts: TranscriptLookupOptions) {
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.pollMs = opts.pollMs ?? 50;
  }

  get filePath(): string {
    return transcriptPathFor(this.opts.home, this.opts.cwd, this.opts.claudeSessionId);
  }

  async find(toolUseId: string): Promise<ClaudeToolUseResult | null> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const hit = this.scan(toolUseId);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** One pass over the tail of the transcript, newest record first. */
  scan(toolUseId: string): ClaudeToolUseResult | null {
    const text = this.readTail();
    if (!text) return null;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line?.includes(toolUseId)) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a half-written tail line; the next poll sees the whole of it
      }
      const sidecar = asToolUseResult(o.toolUseResult ?? o.tool_use_result);
      if (!sidecar) continue;
      const content = (o.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      const matches = content.some(
        (b) =>
          b && typeof b === 'object' && (b as { tool_use_id?: unknown }).tool_use_id === toolUseId,
      );
      if (matches) return sidecar;
    }
    return null;
  }

  private readTail(): string | null {
    try {
      const size = fs.statSync(this.filePath).size;
      if (size <= TRANSCRIPT_SCAN_BYTES) return fs.readFileSync(this.filePath, 'utf8');
      const fd = fs.openSync(this.filePath, 'r');
      try {
        const buf = Buffer.allocUnsafe(TRANSCRIPT_SCAN_BYTES);
        fs.readSync(fd, buf, 0, TRANSCRIPT_SCAN_BYTES, size - TRANSCRIPT_SCAN_BYTES);
        return buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }
}
