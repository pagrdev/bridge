import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent, FrameBody } from '@pagr/bridge-core';
import {
  Dispatcher,
  decodeFrameBody,
  generateRecipientKeyPair,
  JournalStore,
  OutboxCursors,
  openFrame,
  ProjectRegistry,
  SessionStore,
  sealAadFor,
} from '@pagr/bridge-core';
import type { DeviceEvent, EventPayload, Provider } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';
import { transcriptPathFor } from './diffs.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
const hex32 = () => randomBytes(16).toString('hex');
type FramePayload = EventPayload<'session.frame'>;
type FrameEvent = Extract<AdapterEvent, { kind: 'frame' }>;

const until = async (pred: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * MOB-033 end to end: one scripted Claude turn, and what the phone can actually read afterwards.
 *
 * The fake binary replays the exact line shapes Claude Code 2.1.220 emits under `--verbose` —
 * thinking and two tool calls in a single assistant message, a Bash result with its streams split
 * in `tool_use_result`, an Edit result carrying `structuredPatch` and `originalFile`. What is
 * asserted is the whole sequence, in order, including the two frames that exist only because the
 * bridge knows what the call was: the terminal block and the diff.
 */
describe('Claude frames', () => {
  let home: string;
  let project: string;
  let adapter: ClaudeAdapter;
  let frames: FrameEvent[];
  let unsubscribe: () => void;

  const proj = () => ({ projectId: PROJ, path: project, displayName: 'demo' });
  const SES = `ses_${hex32()}`;
  const PROJ = `proj_${hex32()}`;

  beforeEach(() => {
    // realpath: the child's `process.cwd()` is the resolved path, and the previews the frames
    // carry are relative to the project, so the two have to be the same string.
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-frames-')));
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-')));
    adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      approvalTimeoutMs: 400,
      // Every diff in this file comes off the wire; nothing here may reach for a transcript.
      transcriptLookupMs: 0,
      env: { HOME: home },
    });
    frames = [];
    unsubscribe = adapter.subscribe((e) => {
      if (e.kind === 'frame') frames.push(e);
    });
  });
  afterEach(async () => {
    unsubscribe();
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const runFramesTurn = async () => {
    await adapter.startSession({
      sessionId: SES,
      project: proj(),
      instruction: 'frames please',
      localImagePaths: [],
      readOnly: false,
    });
    await until(() => frames.some((f) => f.body.kind === 'assistant'));
  };

  it('emits one frame per block, with results, terminal output and the diff joined to their call', async () => {
    await runFramesTurn();

    const bash = frames.find(
      (f) => f.body.kind === 'tool_call' && f.body.toolName === 'Bash',
    ) as FrameEvent;
    const edit = frames.find(
      (f) => f.body.kind === 'tool_call' && f.body.toolName === 'Edit',
    ) as FrameEvent;
    const bashId = bash.body.kind === 'tool_call' ? bash.body.toolCallId : '';
    const editId = edit.body.kind === 'tool_call' ? edit.body.toolCallId : '';

    expect(frames.map((f) => [f.body.kind, f.meta.parentFrameId ?? null, f.meta.source])).toEqual([
      ['thinking', null, 'stdio'],
      ['tool_call', bashId, 'stdio'],
      ['tool_call', editId, 'stdio'],
      ['tool_result', bashId, 'stdio'],
      ['terminal', bashId, 'stdio'],
      ['tool_result', editId, 'stdio'],
      ['diff', editId, 'stdio'],
      ['assistant', null, 'stdio'],
    ]);

    // The unknown block in the same assistant message produced no frame, and invented nothing.
    expect(frames.filter((f) => f.body.kind === 'tool_call')).toHaveLength(2);
  });

  it('carries the whole tool call, not a clipped preview of it', async () => {
    await runFramesTurn();
    const call = frames.find((f) => f.body.kind === 'tool_call' && f.body.toolName === 'Edit')
      ?.body as Extract<FrameBody, { kind: 'tool_call' }>;
    expect(call).toMatchObject({
      kind: 'tool_call',
      toolName: 'Edit',
      toolKind: 'edit',
      title: 'Edit t.txt',
      input: { old_string: 'bravo', new_string: 'BRAVO', replace_all: false },
    });
    const bash = frames.find((f) => f.body.kind === 'tool_call' && f.body.toolName === 'Bash')
      ?.body as Extract<FrameBody, { kind: 'tool_call' }>;
    expect(bash).toMatchObject({
      toolKind: 'execute',
      title: '$ ls -a',
      input: { command: 'ls -a' },
    });
  });

  it("splits Bash output the way Claude's own result does", async () => {
    await runFramesTurn();
    const terminal = frames.find((f) => f.body.kind === 'terminal')?.body;
    expect(terminal).toEqual({
      kind: 'terminal',
      command: 'ls -a',
      stdout: '.\n..\nt.txt',
      stderr: 'ls: nope: No such file',
      interrupted: false,
    });
  });

  it("uses Claude's own structuredPatch for the diff, unmarked", async () => {
    await runFramesTurn();
    const diff = frames.find((f) => f.body.kind === 'diff')?.body as Extract<
      FrameBody,
      { kind: 'diff' }
    >;
    expect(diff).toMatchObject({
      kind: 'diff',
      path: path.join(project, 't.txt'),
      changeKind: 'update',
      oldText: 'alpha\nbravo\ncharlie\n',
      newText: 'alpha\nBRAVO\ncharlie\n',
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [' alpha', '-bravo', '+BRAVO', ' charlie'],
        },
      ],
    });
    expect(diff.approx).toBeUndefined();
  });

  it('gives every frame a record id, so the same block is never journaled twice', async () => {
    await runFramesTurn();
    const ids = frames.map((f) => f.providerRecordId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the clipped session events flowing for v1 clouds and iMessage', async () => {
    const events: AdapterEvent[] = [];
    const off = adapter.subscribe((e) => events.push(e));
    await runFramesTurn();
    off();
    const summaries = events
      .filter((e) => e.kind === 'session_event')
      .map((e) => (e.kind === 'session_event' ? [e.type, e.summary] : []));
    expect(summaries).toContainEqual(['progress', '$ ls -a']);
    expect(summaries).toContainEqual(['agent_message', 'Fixed the typo. DONE']);
  });
});

/**
 * The same edit, with `tool_use_result` withheld: what the bridge does when Claude did not put its
 * own patch on the wire. Its transcript still has it — and when even that does not arrive in time,
 * the frame says so rather than passing a reconstruction off as Claude's.
 */
describe('Claude diffs without the sidecar', () => {
  let home: string;
  let project: string;
  let adapter: ClaudeAdapter | null;
  const SES = `ses_${hex32()}`;
  const PROJ = `proj_${hex32()}`;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-bare-')));
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-')));
    adapter = null;
  });
  afterEach(async () => {
    await adapter?.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const start = async (transcriptLookupMs: number, onFrame?: (e: FrameEvent) => void) => {
    const a = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      transcriptLookupMs,
      env: { HOME: home },
    });
    adapter = a;
    const got: FrameEvent[] = [];
    let claudeSessionId = '';
    a.subscribe((e) => {
      if (e.kind === 'session_event' && e.type === 'started')
        claudeSessionId = e.providerEventId ?? '';
      if (e.kind !== 'frame') return;
      got.push(e);
      onFrame?.(e);
    });
    await a.startSession({
      sessionId: SES,
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction: 'bare edit please',
      localImagePaths: [],
      readOnly: false,
    });
    return { frames: got, claudeSessionId: () => claudeSessionId };
  };

  it('marks a diff it had to reconstruct itself', async () => {
    const { frames } = await start(0);
    await until(() => frames.some((f) => f.body.kind === 'diff'));
    const diff = frames.find((f) => f.body.kind === 'diff')?.body as Extract<
      FrameBody,
      { kind: 'diff' }
    >;
    expect(diff).toEqual({
      kind: 'diff',
      path: path.join(project, 't.txt'),
      changeKind: 'update',
      approx: true,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-bravo', '+BRAVO'] }],
    });
  });

  it("prefers Claude's own patch when the transcript has it", async () => {
    let planted = false;
    const state = await start(2000, (e) => {
      // The transcript record lands a moment after the result line; the lookup is waiting for it.
      if (planted || e.body.kind !== 'tool_result') return;
      planted = true;
      const file = transcriptPathFor(home, project, state.claudeSessionId());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: e.body.toolCallId }],
          },
          toolUseResult: {
            filePath: path.join(project, 't.txt'),
            oldString: 'bravo',
            newString: 'BRAVO',
            originalFile: 'alpha\nbravo\ncharlie\n',
            replaceAll: false,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 3,
                lines: [' alpha', '-bravo', '+BRAVO', ' charlie'],
              },
            ],
          },
        })}\n`,
      );
    });
    await until(() => state.frames.some((f) => f.body.kind === 'diff'));
    const diff = state.frames.find((f) => f.body.kind === 'diff')?.body as Extract<
      FrameBody,
      { kind: 'diff' }
    >;
    expect(diff.approx).toBeUndefined();
    expect(diff.oldText).toBe('alpha\nbravo\ncharlie\n');
    expect(diff.hunks?.[0]?.lines).toEqual([' alpha', '-bravo', '+BRAVO', ' charlie']);
  });
});

/**
 * The same turn, seen from the far end: journaled on this Mac, sealed on the wire, and readable
 * only with the phone's key.
 */
describe('Claude frames through the dispatcher', () => {
  let home: string;
  let project: string;
  let adapter: ClaudeAdapter;
  let events: DeviceEvent[];
  let dispatcher: Dispatcher;
  const phone = generateRecipientKeyPair();
  const SES = `ses_${hex32()}`;

  let projectId: string;
  let journalDir: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-claude-disp-')));
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-proj-')));
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      transcriptLookupMs: 0,
      env: { HOME: home },
    });
    const registry = new ProjectRegistry({ home, pagrHome: path.join(home, '.pagr') });
    projectId = registry.add(project).projectId;
    journalDir = path.join(home, 'journal');
    events = [];
    dispatcher = new Dispatcher({
      deviceId: `dev_${hex32()}`,
      adapters: new Map<Provider, ClaudeAdapter>([['claude', adapter]]),
      registry,
      sessions: new SessionStore(),
      emit: (e) => events.push(e),
      tmpDir: path.join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: path.join(home, '.pagr', 'policy.json'),
      frames: {
        journal: new JournalStore({ dir: journalDir }),
        cursors: new OutboxCursors({ file: path.join(journalDir, 'outbox.json'), writeDelayMs: 0 }),
        recipientKeys: () => ({ [phone.kid]: phone.publicKeyB64u }),
        protocolVersion: () => 2,
      },
    });
  });
  afterEach(async () => {
    await dispatcher.shutdown?.();
    await adapter.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('numbers, journals and seals every frame of the turn', async () => {
    await adapter.startSession({
      sessionId: SES,
      project: { projectId, path: project, displayName: 'demo' },
      instruction: 'frames please',
      localImagePaths: [],
      readOnly: false,
    });
    const payloads = (): FramePayload[] =>
      events.filter((e) => e.type === 'session.frame').map((e) => e.payload as FramePayload);
    await until(() => payloads().some((p) => p.kind === 'assistant'));

    const got = payloads();
    expect(got.map((p) => p.kind)).toEqual([
      'thinking',
      'tool_call',
      'tool_call',
      'tool_result',
      'terminal',
      'tool_result',
      'diff',
      'assistant',
    ]);
    expect(got.map((p) => p.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Nothing the person wrote or Claude ran is legible in the event itself.
    const wire = JSON.stringify(got);
    expect(wire).not.toContain('BRAVO');
    expect(wire).not.toContain('ls -a');
    expect(wire).not.toContain('Fixed the typo');

    const opened = got.map((p) =>
      decodeFrameBody(
        openFrame(
          p.sealed,
          sealAadFor({ sessionId: SES, seq: p.seq, kind: p.kind }),
          phone.privateKeyRaw,
        ),
      ),
    );
    expect(opened.find((b) => b.kind === 'terminal')).toMatchObject({
      command: 'ls -a',
      stderr: 'ls: nope: No such file',
    });
    expect(opened.find((b) => b.kind === 'diff')).toMatchObject({ changeKind: 'update' });
    expect(opened.find((b) => b.kind === 'assistant')).toEqual({
      kind: 'assistant',
      text: 'Fixed the typo. DONE',
    });

    // …and the whole thing is on this Mac's disk, in order, for a backfill.
    const lines = fs
      .readFileSync(path.join(journalDir, `${SES}.log`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { seq: number; kind: string });
    expect(lines.map((l) => l.kind)).toEqual(got.map((p) => p.kind));
  });
});
