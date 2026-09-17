import { describe, expect, it } from 'vitest';
import {
  capFrameBody,
  chunkFrame,
  decodeFrameBody,
  encodeFrameBody,
  type FrameBody,
  FrameBodyError,
  frameBodyBytes,
  joinFrameParts,
  MAX_LIVE_FRAME_BYTES,
  splitUtf8,
  TERMINAL_HEAD_BYTES,
  TERMINAL_OUTPUT_CAP_BYTES,
  TERMINAL_TAIL_BYTES,
} from './frames.js';
import { MAX_SEAL_BODY_BYTES } from './seal.js';

const assistant = (text: string): FrameBody => ({ kind: 'assistant', text });
const terminal = (stdout: string, stderr = ''): FrameBody => ({
  kind: 'terminal',
  command: 'pnpm test',
  stdout,
  stderr,
  exitCode: 0,
  interrupted: false,
});

describe('frame bodies', () => {
  it('round-trips every kind through the codec', () => {
    const bodies: FrameBody[] = [
      assistant('hello'),
      { kind: 'thinking', text: 'hmm' },
      { kind: 'user', text: 'do the thing', images: 2 },
      {
        kind: 'tool_call',
        toolCallId: 'toolu_1',
        toolName: 'Bash',
        toolKind: 'execute',
        title: 'pnpm test',
        input: { command: 'pnpm test', timeout: 120 },
      },
      { kind: 'tool_result', toolCallId: 'toolu_1', content: 'ok', isError: false },
      {
        kind: 'diff',
        path: 'src/a.ts',
        changeKind: 'update',
        oldText: 'a',
        newText: 'b',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      },
      terminal('out', 'err'),
      {
        kind: 'question',
        questions: [
          {
            question: 'Which one?',
            header: 'Pick',
            multiSelect: false,
            options: [{ label: 'A', description: 'the first' }, { label: 'B' }],
          },
        ],
      },
      { kind: 'approval_preview', preview: 'rm -rf /tmp/x', suggestions: ['allow_once'] },
      { kind: 'system', subtype: 'init', text: 'session started' },
    ];
    for (const body of bodies) expect(decodeFrameBody(encodeFrameBody(body))).toEqual(body);
  });

  it('encodes canonically, so field order never changes the bytes', () => {
    const a: FrameBody = { kind: 'user', text: 'hi', images: 1 };
    const b = { images: 1, text: 'hi', kind: 'user' } as FrameBody;
    expect(Buffer.from(encodeFrameBody(a)).toString()).toBe(
      Buffer.from(encodeFrameBody(b)).toString(),
    );
  });

  it('refuses bytes that are not a frame body', () => {
    expect(() => decodeFrameBody('not json')).toThrow(FrameBodyError);
    expect(() => decodeFrameBody('{"kind":"imessage","text":"hi"}')).toThrow(/not a frame body/);
    expect(() => decodeFrameBody('{"kind":"assistant"}')).toThrow(FrameBodyError);
  });
});

describe('live caps', () => {
  it('leaves a small body alone and reports its real size', () => {
    const body = assistant('short');
    const capped = capFrameBody(body);
    expect(capped.truncated).toBe(false);
    expect(capped.body).toEqual(body);
    expect(capped.bytes).toBe(frameBodyBytes(body));
  });

  it('tail-biases command output past 64 KiB to the first 8 KiB and the last 56 KiB', () => {
    const head = 'H'.repeat(TERMINAL_HEAD_BYTES);
    const middle = 'M'.repeat(400 * 1024);
    const tail = 'T'.repeat(TERMINAL_TAIL_BYTES);
    const full = `${head}${middle}${tail}`;
    const capped = capFrameBody(terminal(full));
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBe(frameBodyBytes(terminal(full)));
    const out = capped.body.kind === 'terminal' ? capped.body.stdout : '';
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain('bytes omitted');
    expect(out).not.toContain('MMM');
    // Head + tail + the marker, and nothing like the original size.
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(TERMINAL_OUTPUT_CAP_BYTES + 200);
  });

  it('caps stderr as well as stdout', () => {
    const capped = capFrameBody(terminal('fine', 'E'.repeat(300 * 1024)));
    expect(capped.truncated).toBe(true);
    const err = capped.body.kind === 'terminal' ? capped.body.stderr : '';
    expect(Buffer.byteLength(err, 'utf8')).toBeLessThan(TERMINAL_OUTPUT_CAP_BYTES + 200);
  });

  it('clips any body over 512 KiB head-first and says so', () => {
    const body = assistant('x'.repeat(800 * 1024));
    const capped = capFrameBody(body);
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeGreaterThan(MAX_LIVE_FRAME_BYTES);
    expect(frameBodyBytes(capped.body)).toBeLessThanOrEqual(MAX_LIVE_FRAME_BYTES);
    const text = capped.body.kind === 'assistant' ? capped.body.text : '';
    expect(text.startsWith('xxx')).toBe(true);
    expect(text).toContain('bytes omitted');
  });

  it('replaces an oversized tool input rather than producing invalid JSON', () => {
    const capped = capFrameBody({
      kind: 'tool_call',
      toolCallId: 't1',
      toolName: 'Write',
      toolKind: 'edit',
      title: 'write a file',
      input: { content: 'y'.repeat(900 * 1024) },
    });
    expect(capped.truncated).toBe(true);
    expect(frameBodyBytes(capped.body)).toBeLessThanOrEqual(MAX_LIVE_FRAME_BYTES);
    expect(decodeFrameBody(encodeFrameBody(capped.body))).toEqual(capped.body);
  });

  it('never cuts a multi-byte character in half', () => {
    // 4-byte characters, so every naive byte boundary lands mid-character.
    const body = assistant('🐝'.repeat(200 * 1024));
    const capped = capFrameBody(body);
    const text = capped.body.kind === 'assistant' ? capped.body.text : '';
    expect(text).not.toContain('�');
  });
});

describe('chunkFrame', () => {
  it('leaves a body that fits as a single part with no chunk metadata', () => {
    const plan = chunkFrame(assistant('small'));
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]?.chunk).toBeUndefined();
    expect(plan.kind).toBe('assistant');
    expect(plan.truncated).toBe(false);
    expect(joinFrameParts(plan.parts)).toEqual(assistant('small'));
  });

  it('splits a large body into 160 KiB chunks that reassemble exactly', () => {
    const body = assistant('z'.repeat(400 * 1024));
    const plan = chunkFrame(body, { group: 'grp1' });
    expect(plan.parts.length).toBeGreaterThan(1);
    for (const [i, part] of plan.parts.entries()) {
      expect(part.body.byteLength).toBeLessThanOrEqual(MAX_SEAL_BODY_BYTES);
      expect(part.chunk).toEqual({ group: 'grp1', index: i, total: plan.parts.length });
    }
    expect(joinFrameParts(plan.parts)).toEqual(body);
  });

  it('reassembles whatever order the parts arrive in', () => {
    const body = assistant('q'.repeat(400 * 1024));
    const plan = chunkFrame(body, { group: 'g' });
    expect(joinFrameParts([...plan.parts].reverse())).toEqual(body);
  });

  it('splits at UTF-8 boundaries, so each part is valid UTF-8 on its own', () => {
    const body = assistant('🌍'.repeat(60 * 1024));
    const plan = chunkFrame(body, { maxSealedBytes: 20_000, group: 'g' });
    expect(plan.parts.length).toBeGreaterThan(1);
    for (const part of plan.parts) {
      const text = Buffer.from(part.body).toString('utf8');
      expect(text).not.toContain('�');
      expect(Buffer.byteLength(text, 'utf8')).toBe(part.body.byteLength);
    }
    expect(joinFrameParts(plan.parts)).toEqual(body);
  });

  it('reports the pre-cap size and the truncation flag for FrameMeta', () => {
    const full = 'W'.repeat(900 * 1024);
    const plan = chunkFrame(terminal(full));
    expect(plan.bytes).toBe(frameBodyBytes(terminal(full)));
    expect(plan.truncated).toBe(true);
    // Capped first, so a huge command output does not become a 6-chunk group.
    expect(plan.parts).toHaveLength(1);
  });

  it('generates a distinct group id per call', () => {
    const body = assistant('z'.repeat(400 * 1024));
    const a = chunkFrame(body).parts[0]?.chunk?.group;
    const b = chunkFrame(body).parts[0]?.chunk?.group;
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('splitUtf8 never returns an empty piece or loses a byte', () => {
    const buf = Buffer.from('é'.repeat(1000), 'utf8');
    const pieces = splitUtf8(buf, 7);
    expect(pieces.every((p) => p.byteLength > 0)).toBe(true);
    expect(Buffer.concat(pieces).equals(buf)).toBe(true);
  });
});
