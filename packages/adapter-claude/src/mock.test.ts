import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterEvent } from '@pagr/bridge-core';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from './index.js';
import { describeMockAttachments, MockClaudeAdapter } from './mock.js';

const SES = 'ses_00000000000000000000000000000001';
const project = {
  projectId: 'proj_0000000000000000000000000000000a',
  path: '/tmp/x',
  displayName: 'x',
};

function collect(adapter: MockClaudeAdapter) {
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

describe('MockClaudeAdapter', () => {
  it('createClaudeAdapter({mock:true}) returns the mock', () => {
    expect(createClaudeAdapter({ mock: true })).toBeInstanceOf(MockClaudeAdapter);
  });

  it('scripts started → progress → completed', async () => {
    const a = new MockClaudeAdapter({ delayMs: 30 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'implement auth',
      localImagePaths: [],
      readOnly: false,
    });
    const done = await c.until((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(done).toMatchObject({ summary: 'Auth flow implemented, 68 tests pass.' });
    const types = c.events.flatMap((e) => (e.kind === 'session_event' ? [e.type] : []));
    expect(types).toEqual(['started', 'progress', 'agent_message', 'completed']);
    await a.shutdown();
  });

  it('records the delivered attachments and names them in that turn’s completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pagr-mock-att-'));
    const img = join(dir, 'att_0123.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const a = new MockClaudeAdapter({ delayMs: 30 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'match this mockup',
      localImagePaths: [img],
      readOnly: false,
    });
    expect(a.deliveredImages.get(SES)).toEqual([img]);
    const done = await c.until((e) => e.kind === 'session_event' && e.type === 'completed');
    expect(done).toMatchObject({
      summary:
        'Auth flow implemented, 68 tests pass. 📎 1 screenshot (8 bytes: att_0123.png) received.',
    });
    await a.shutdown();
  });

  it('reports attachments the dispatcher already deleted instead of pretending', () => {
    expect(describeMockAttachments([])).toBeNull();
    expect(describeMockAttachments(['/nope/att_1.png'])).toBe(
      '📎 1 attachment(s) missing on disk.',
    );
  });

  it('never steers: follow-ups are queued then delivered; approvals work', async () => {
    const a = new MockClaudeAdapter({ delayMs: 30 });
    const c = collect(a);
    await a.startSession({
      sessionId: SES,
      project,
      instruction: 'write auth.ts',
      localImagePaths: [],
      readOnly: false,
    });
    expect(
      await a.sendInstruction({
        sessionId: SES,
        instruction: 'also tests',
        mode: 'steer',
        localImagePaths: [],
      }),
    ).toEqual({ delivered: 'queued' });
    const req = await c.until((e) => e.kind === 'approval_requested');
    if (req.kind !== 'approval_requested') throw new Error('unreachable');
    expect(req.actionType).toBe('file_change');
    await a.respondToApproval({
      approvalId: req.approvalId,
      providerRequestId: req.providerRequestId,
      decision: 'allow',
    });
    await c.until((e) => e.kind === 'session_event' && e.type === 'followup_delivered');
    await c.until(
      (e) =>
        c.events.filter((x) => x.kind === 'session_event' && x.type === 'completed').length >= 2 &&
        e.kind === 'session_event',
    );
    expect((await a.getStatus(SES))?.status).toBe('completed');
    await a.stopSession(SES);
    expect((await a.getStatus(SES))?.status).toBe('stopped');
    await a.shutdown();
  });
});
