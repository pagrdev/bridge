import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent } from '@pagr/bridge-core';
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from './index.js';
import { describeMockAttachments, MockCodexAdapter } from './mock.js';

const SES = 'ses_00000000000000000000000000000001';
const PROJ = 'proj_0000000000000000000000000000000a';
const project = { projectId: PROJ, path: '/tmp/x', displayName: 'x' };

function collect(adapter: MockCodexAdapter) {
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const until = (pred: (e: AdapterEvent) => boolean, ms = 2000) =>
    new Promise<AdapterEvent>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const hit = events.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - start > ms) return reject(new Error('timeout'));
        setTimeout(tick, 5);
      };
      tick();
    });
  return { events, until };
}

describe('MockCodexAdapter', () => {
  it('createCodexAdapter({mock:true}) returns the mock', () => {
    expect(createCodexAdapter({ mock: true })).toBeInstanceOf(MockCodexAdapter);
  });

  it('scripts started → progress → completed for a plain instruction', async () => {
    const a = new MockCodexAdapter({ delayMs: 30 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: false,
    });
    const done = await c.until((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(done).toMatchObject({ summary: 'All 12 tests pass.' });
    const types = c.events
      .filter((e) => e.kind === 'session_event')
      .map((e) => (e.kind === 'session_event' ? e.type : ''));
    expect(types).toEqual(['started', 'progress', 'agent_message', 'completed']);
    expect(c.events.some((e) => e.kind === 'approval_requested')).toBe(false);
    await a.shutdown();
  });

  it('asks for approval when the instruction mentions migrate and honours the decision', async () => {
    const a = new MockCodexAdapter({ delayMs: 30 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'migrate the db',
      localImagePaths: [],
      readOnly: false,
    });
    const req = await c.until((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    expect(req.preview).toBe('npm run db:migrate');
    expect((await a.getStatus(SES))?.status).toBe('waiting_for_approval');
    await a.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'allow',
    });
    const done = await c.until((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(done).toMatchObject({ summary: 'All 12 tests pass.' });
    await a.shutdown();
  });

  it('completes with the linter script when the instruction mentions lint', async () => {
    const a = new MockCodexAdapter({ delayMs: 30 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'run the linter',
      localImagePaths: [],
      readOnly: false,
    });
    const done = await c.until((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(done).toMatchObject({ summary: 'Linter clean: 0 problems.' });
    await a.shutdown();
  });

  it('records the delivered attachments and names them in that turn’s completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagr-mock-att-'));
    const img = join(dir, 'att_0123.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const a = new MockCodexAdapter({ delayMs: 30 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'fix the button spacing',
      localImagePaths: [img],
      readOnly: false,
    });
    expect(a.deliveredImages.get(SES)).toEqual([img]);
    const done = await c.until((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(done).toMatchObject({
      summary: 'All 12 tests pass. 📎 1 screenshot (8 bytes: att_0123.png) received.',
    });
    // The note belongs to that turn only — the next one is unadorned.
    await a.sendInstruction({
      sessionId: SES,
      instruction: 'again',
      mode: 'auto',
      localImagePaths: [],
    });
    await new Promise((r) => setTimeout(r, 300));
    const completions = c.events.flatMap((e) =>
      e.kind === 'session_event' && e.type === 'completed' ? [e.summary] : [],
    );
    expect(completions).toEqual([
      'All 12 tests pass. 📎 1 screenshot (8 bytes: att_0123.png) received.',
      'All 12 tests pass.',
    ]);
    await a.shutdown();
  });

  it('reports attachments the dispatcher already deleted instead of pretending', () => {
    expect(describeMockAttachments([])).toBeNull();
    expect(describeMockAttachments(['/nope/att_1.png'])).toBe(
      '📎 1 attachment(s) missing on disk.',
    );
  });

  it('honours steer, queue and stop', async () => {
    const a = new MockCodexAdapter({ delayMs: 200 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'run tests',
      localImagePaths: [],
      readOnly: false,
    });
    expect(
      await a.sendInstruction({
        sessionId: SES,
        instruction: 'x',
        mode: 'steer',
        localImagePaths: [],
      }),
    ).toEqual({ delivered: 'steered' });
    expect(
      await a.sendInstruction({
        sessionId: SES,
        instruction: 'y',
        mode: 'queue',
        localImagePaths: [],
      }),
    ).toEqual({ delivered: 'queued' });
    await a.stopSession(SES);
    expect((await a.getStatus(SES))?.status).toBe('stopped');
    await new Promise((r) => setTimeout(r, 300));
    expect(c.events.some((e) => e.kind === 'session_event' && e.type === 'completed')).toBe(false);
    expect(
      await a.sendInstruction({
        sessionId: SES,
        instruction: 'z',
        mode: 'auto',
        localImagePaths: [],
      }),
    ).toEqual({ delivered: 'new_turn' });
    await a.shutdown();
  });
});
