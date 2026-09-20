import { randomBytes } from 'node:crypto';
import { canonicalize, type FrameChunk, type FrameKind } from '@pagr/protocol';
import { z } from 'zod';
import { MAX_SEAL_BODY_BYTES } from './seal.js';

/**
 * Frame bodies — the half of a transcript frame that is sealed.
 *
 * A `session.frame` event is two halves: plaintext routing metadata the cloud indexes on
 * (`sessionId`, `seq`, `kind`, `FrameMeta`) and a body the cloud cannot read. The metadata lives
 * in `@pagr/protocol`, because the gateway parses it. The BODY lives here, because nothing
 * outside this Mac and the user's phones ever parses it: the cloud stores `ct` opaque.
 *
 * This module owns three things:
 *
 *   - the `FrameBody` union and its codec (`encodeFrameBody` / `decodeFrameBody`);
 *   - the live caps — a frame is a live view, not the archive, so oversized output is clipped for
 *     the wire while the journal keeps the whole thing (`chunkFrame` reports what it clipped);
 *   - chunking, because a sealed body is capped at `MAX_SEAL_BODY_BYTES` and a 300 KiB assistant
 *     message still has to reach the phone.
 *
 * `imessage` is a frame KIND but never a body produced here: those lines travelled in the clear
 * through the iMessage thread and the cloud injects them into the app's stream unsealed.
 */

// ---------- the union ----------

/**
 * ACP tool kinds. What a tool call is *doing*, so the phone can draw the right glyph without
 * knowing the tool's name — `Bash` and `KillShell` are both `execute`.
 */
export const ToolKind = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKind>;

/** One hunk of a structured patch, as Claude's own transcript records it. */
export const DiffHunk = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

/** One question in an `AskUserQuestion`-shaped ask. */
export const FrameQuestion = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string().optional(),
      preview: z.string().optional(),
    }),
  ),
});
export type FrameQuestion = z.infer<typeof FrameQuestion>;

/**
 * Every body shape, tagged by the frame kind it belongs to.
 *
 * Two fields are spelled differently from the shared contract's table, and only because a
 * discriminated union cannot carry two `kind`s: the ACP tool kind is `toolKind` and the diff's
 * add/update/delete is `changeKind`. The outer frame kind is the discriminant, so a body is
 * self-describing in the journal and `encodeFrameBody` never needs to be told what it is holding.
 */
export const FrameBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assistant'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({
    kind: z.literal('user'),
    text: z.string(),
    /** How many images rode along. The bytes are never journaled or sealed. */
    images: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('tool_call'),
    toolCallId: z.string(),
    toolName: z.string(),
    toolKind: ToolKind,
    title: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    kind: z.literal('diff'),
    path: z.string(),
    changeKind: z.enum(['add', 'update', 'delete']),
    oldText: z.string().optional(),
    newText: z.string().optional(),
    hunks: z.array(DiffHunk).optional(),
    /**
     * True when the bridge computed these hunks itself instead of reading the agent's own.
     *
     * Claude records a `structuredPatch` for every edit it makes and that is what a diff frame
     * normally carries. When it is missing — an older CLI, a tool that does not produce one — the
     * bridge reconstructs a hunk from the replacement strings alone, which has no surrounding
     * context and no true line numbers. The phone is told, rather than shown a diff that looks
     * authoritative and is not.
     */
    approx: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('terminal'),
    command: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().optional(),
    interrupted: z.boolean(),
  }),
  z.object({ kind: z.literal('question'), questions: z.array(FrameQuestion) }),
  z.object({
    kind: z.literal('approval_preview'),
    preview: z.string(),
    suggestions: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal('system'), subtype: z.string(), text: z.string() }),
  /**
   * v2, `handoff.v1`. A finished review report, sealed, so the phone can read the findings the
   * verdict line only summarises.
   *
   * The whole of `review.md` travels here and nowhere else: `review.completed` carries one line
   * in the clear so the cloud can text it, and everything the reviewer actually wrote — file
   * names, line numbers, quoted code — is inside the seal. `verdict` and `summary` are repeated
   * in the body so a phone reading its journal offline does not have to pair the frame with an
   * event it may never have received.
   */
  z.object({
    kind: z.literal('review'),
    reviewId: z.string(),
    verdict: z.enum(['approve', 'comment', 'block']),
    summary: z.string(),
    /** The report exactly as the reviewer wrote it, first line included. */
    text: z.string(),
  }),
]);
export type FrameBody = z.infer<typeof FrameBody>;

/** Frame kinds this Mac can produce. `imessage` is injected by the cloud, never sealed here. */
export type FrameBodyKind = FrameBody['kind'];

export function isFrameBodyKind(kind: FrameKind): kind is FrameBodyKind {
  return kind !== 'imessage';
}

// ---------- codec ----------

/**
 * The exact bytes that get sealed: `canonicalize(body)` in UTF-8.
 *
 * Canonical rather than `JSON.stringify` so the same body always produces the same ciphertext
 * length and the same journal line, whatever order the fields were built in — which is what makes
 * the known-answer vectors and the journal's byte offsets reproducible.
 */
export function encodeFrameBody(body: FrameBody): Uint8Array {
  return Buffer.from(canonicalize(body), 'utf8');
}

export class FrameBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameBodyError';
  }
}

/** Parse bytes back into a body. Throws `FrameBodyError` on anything that is not one. */
export function decodeFrameBody(bytes: Uint8Array | string): FrameBody {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new FrameBodyError(
      `frame body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = FrameBody.safeParse(json);
  if (!parsed.success)
    throw new FrameBodyError(`not a frame body: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

/** Bytes of a body as it would be sealed, without keeping the buffer. */
export const frameBodyBytes = (body: FrameBody): number =>
  Buffer.byteLength(canonicalize(body), 'utf8');

// ---------- live caps ----------

/**
 * Ceiling for one frame on the wire, after which the body is clipped and `meta.truncated` says
 * so. The frame is the LIVE view; the journal keeps the whole body and `session.backfill` serves
 * it, so nothing is lost — the cap exists so one `cat` of a log file cannot push 40 MiB through
 * a phone's cellular connection.
 */
export const MAX_LIVE_FRAME_BYTES = 512 * 1024;

/** Command output past this is tail-biased rather than sent whole. */
export const TERMINAL_OUTPUT_CAP_BYTES = 64 * 1024;
/** Kept from the start of clipped output: the command's own preamble is usually here. */
export const TERMINAL_HEAD_BYTES = 8 * 1024;
/** Kept from the end: the error, the summary line, the stack trace. */
export const TERMINAL_TAIL_BYTES = 56 * 1024;

const omissionMark = (omitted: number): string =>
  `\n… ${omitted} bytes omitted from this view; the whole thing is on your Mac …\n`;

/** Cut `text` to at most `budget` bytes, keeping the head, at a UTF-8 boundary. */
function clipHead(text: string, budget: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= budget) return text;
  const mark = omissionMark(buf.byteLength - budget);
  const room = Math.max(0, budget - Buffer.byteLength(mark, 'utf8'));
  return `${utf8Slice(buf, 0, room)}${mark}`;
}

/**
 * Keep the first `head` bytes and the last `tail` bytes of `text`, both at UTF-8 boundaries.
 *
 * The bias is deliberate and comes from what people actually look for in a failed command: the
 * invocation and the first few lines, then the end, where the error and the exit summary are. The
 * middle of a 9 MiB test run is the part nobody reads on a phone.
 */
export function tailBias(text: string, head: number, tail: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= head + tail) return text;
  const omitted = buf.byteLength - head - tail;
  return `${utf8Slice(buf, 0, head)}${omissionMark(omitted)}${utf8Slice(buf, buf.byteLength - tail, tail)}`;
}

/**
 * Slice `count` bytes from `at`, backing off so the slice never ends (or starts) inside a
 * multi-byte character. Node would hand back a U+FFFD replacement instead, which is a silent
 * corruption of the user's own text.
 */
function utf8Slice(buf: Buffer, at: number, count: number): string {
  let start = Math.max(0, Math.min(at, buf.byteLength));
  let end = Math.max(start, Math.min(start + count, buf.byteLength));
  // A continuation byte is 10xxxxxx; walk back to the lead byte of its character.
  while (start > 0 && start < buf.byteLength && ((buf[start] as number) & 0xc0) === 0x80) start--;
  while (end > start && end < buf.byteLength && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return buf.toString('utf8', start, end);
}

/**
 * Apply the live caps to a body. Returns the body to SEAL plus the size of the original, so
 * `FrameMeta.bytes` reports what the frame really is and `truncated` is never a guess.
 *
 * Terminal output is capped first and tail-biased; anything else that is still too big has its
 * largest text field clipped head-first, because prose reads from the top.
 */
export function capFrameBody(
  body: FrameBody,
  maxBytes: number = MAX_LIVE_FRAME_BYTES,
): { body: FrameBody; bytes: number; truncated: boolean } {
  const bytes = frameBodyBytes(body);
  let next = body;
  let truncated = false;

  if (next.kind === 'terminal') {
    const stdout = tailBias(next.stdout, TERMINAL_HEAD_BYTES, TERMINAL_TAIL_BYTES);
    const stderr = tailBias(next.stderr, TERMINAL_HEAD_BYTES, TERMINAL_TAIL_BYTES);
    if (stdout !== next.stdout || stderr !== next.stderr) {
      next = { ...next, stdout, stderr };
      truncated = true;
    }
  }

  // Everything else (and a terminal frame with a pathological `command`) is clipped field by
  // field, largest first, until the encoded body fits. Bounded: each pass strictly shrinks the
  // largest field, and there are at most a handful of fields.
  for (let pass = 0; pass < 8 && frameBodyBytes(next) > maxBytes; pass++) {
    const over = frameBodyBytes(next) - maxBytes;
    const slot = largestTextSlot(next);
    if (!slot) break;
    const clipped = clipHead(slot.value, Math.max(0, Buffer.byteLength(slot.value, 'utf8') - over));
    if (clipped === slot.value) break;
    next = slot.replace(clipped);
    truncated = true;
  }

  return { body: next, bytes, truncated };
}

interface TextSlot {
  value: string;
  replace(v: string): FrameBody;
}

/** The longest clippable string in a body, with the way to put a shorter one back. */
function largestTextSlot(body: FrameBody): TextSlot | null {
  const slots: TextSlot[] = [];
  const add = (value: string, replace: (v: string) => FrameBody) => slots.push({ value, replace });
  switch (body.kind) {
    case 'assistant':
    case 'thinking':
      add(body.text, (text) => ({ ...body, text }));
      break;
    case 'user':
      add(body.text, (text) => ({ ...body, text }));
      break;
    case 'system':
      add(body.text, (text) => ({ ...body, text }));
      break;
    case 'tool_call':
      // `input` is arbitrary JSON; clipping it structurally is not possible, so it is replaced
      // wholesale by a note rather than turned into invalid JSON.
      add(JSON.stringify(body.input ?? null), () => ({
        ...body,
        input: { pagrOmitted: 'the tool input was too large for a live frame' },
      }));
      add(body.title, (title) => ({ ...body, title }));
      break;
    case 'tool_result':
      add(body.content, (content) => ({ ...body, content }));
      break;
    case 'diff':
      add(body.newText ?? '', (newText) => ({ ...body, newText }));
      add(body.oldText ?? '', (oldText) => ({ ...body, oldText }));
      break;
    case 'terminal':
      add(body.stdout, (stdout) => ({ ...body, stdout }));
      add(body.stderr, (stderr) => ({ ...body, stderr }));
      add(body.command, (command) => ({ ...body, command }));
      break;
    case 'approval_preview':
      add(body.preview, (preview) => ({ ...body, preview }));
      break;
    case 'review':
      // The report, not the verdict line: `summary` is what the phone shows when the findings
      // are too long to send live, so clipping it would leave the frame saying nothing.
      add(body.text, (text) => ({ ...body, text }));
      break;
    case 'question':
      // Question text is short by construction and is the whole point of the frame; clipping it
      // would produce an unanswerable prompt, so it is left alone and the seal's own oversize
      // error is the honest outcome.
      break;
  }
  let best: TextSlot | null = null;
  for (const s of slots)
    if (!best || Buffer.byteLength(s.value, 'utf8') > Buffer.byteLength(best.value, 'utf8'))
      best = s;
  return best && Buffer.byteLength(best.value, 'utf8') > 0 ? best : null;
}

// ---------- chunking ----------

/** One sealable piece of a body. `chunk` is absent when the body fitted in one. */
export interface FramePart {
  /** Plaintext to hand to `sealFrame`. */
  body: Uint8Array;
  chunk?: FrameChunk;
}

export interface ChunkedFrame {
  kind: FrameBodyKind;
  /** Size of the WHOLE body before the live caps — what `FrameMeta.bytes` reports. */
  bytes: number;
  /** Whether the caps clipped anything — what `FrameMeta.truncated` reports. */
  truncated: boolean;
  parts: FramePart[];
}

export interface ChunkFrameOptions {
  /** Largest plaintext one envelope may carry. Defaults to the seal module's own ceiling. */
  maxSealedBytes?: number;
  /** Live cap before chunking. Defaults to `MAX_LIVE_FRAME_BYTES`. */
  maxBodyBytes?: number;
  /** Group id for the parts; generated when absent. Tests pin it. */
  group?: string;
  /** Randomness for the group id. */
  random?: (bytes: number) => Uint8Array;
}

/** Group ids only have to be unique among the frames a phone is reassembling at once. */
export const newFrameGroupId = (random: (b: number) => Uint8Array = randomBytes): string =>
  Buffer.from(random(8)).toString('hex');

/**
 * Cap, encode and split a body into the pieces that will be sealed.
 *
 * The split is at UTF-8 boundaries so a part is always valid UTF-8 on its own — it costs nothing
 * and it means a part can be logged, diffed or eyeballed without decoding tricks. The pieces are
 * JSON FRAGMENTS, not JSON: the phone concatenates a group by `index` and parses once, which is
 * why `total` is carried on every part rather than only the last.
 */
export function chunkFrame(body: FrameBody, opts: ChunkFrameOptions = {}): ChunkedFrame {
  const maxSealed = opts.maxSealedBytes ?? MAX_SEAL_BODY_BYTES;
  if (maxSealed <= 0) throw new FrameBodyError('maxSealedBytes must be positive');
  const capped = capFrameBody(body, opts.maxBodyBytes ?? MAX_LIVE_FRAME_BYTES);
  const encoded = Buffer.from(encodeFrameBody(capped.body));

  if (encoded.byteLength <= maxSealed)
    return {
      kind: capped.body.kind,
      bytes: capped.bytes,
      truncated: capped.truncated,
      parts: [{ body: encoded }],
    };

  const pieces = splitUtf8(encoded, maxSealed);
  const group = opts.group ?? newFrameGroupId(opts.random ?? randomBytes);
  const total = pieces.length;
  return {
    kind: capped.body.kind,
    bytes: capped.bytes,
    truncated: capped.truncated,
    parts: pieces.map((piece, index) => ({ body: piece, chunk: { group, index, total } })),
  };
}

/** Split into ≤`max`-byte pieces without cutting a multi-byte character in half. */
export function splitUtf8(buf: Buffer, max: number): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  while (at < buf.byteLength) {
    let end = Math.min(at + max, buf.byteLength);
    while (end > at && end < buf.byteLength && ((buf[end] as number) & 0xc0) === 0x80) end--;
    // A single character longer than `max` cannot happen (4 bytes max), but never loop forever.
    if (end === at) end = Math.min(at + max, buf.byteLength);
    out.push(buf.subarray(at, end));
    at = end;
  }
  return out;
}

/** Put a group back together, in `index` order, and parse it. The phone does this; so do tests. */
export function joinFrameParts(parts: readonly FramePart[]): FrameBody {
  const ordered = [...parts].sort((a, b) => (a.chunk?.index ?? 0) - (b.chunk?.index ?? 0));
  return decodeFrameBody(Buffer.concat(ordered.map((p) => Buffer.from(p.body))));
}
