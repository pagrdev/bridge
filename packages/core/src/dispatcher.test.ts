import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentRef, DeviceEvent, Provider } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { sha256Hex } from './approvals.js';
import { Dispatcher } from './dispatcher.js';
import { ProjectRegistry } from './projects.js';
import { SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(20, 7),
]);

describe('Dispatcher', () => {
  const t = useTempHome('pagr-disp-');
  const deviceId = ids.dev();
  let codex: FakeAdapter;
  let claude: FakeAdapter;
  let registry: ProjectRegistry;
  let sessions: SessionStore;
  let events: DeviceEvent[];
  let d: Dispatcher;
  let projectId: string;
  let now: Date;
  let fetched: string[];

  beforeEach(() => {
    now = new Date('2026-08-24T12:00:00Z');
    codex = new FakeAdapter('codex');
    claude = new FakeAdapter('claude');
    claude.canSteer = false;
    const home = join(t.home, 'home');
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(join(home, 'repo')).projectId;
    sessions = new SessionStore();
    events = [];
    fetched = [];
    d = new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>([
        ['codex', codex],
        ['claude', claude],
      ]),
      registry,
      sessions,
      emit: (e) => {
        DeviceEventSchema.parse(e); // every emitted event must be schema-valid
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      now: () => now,
      osVersion: '25.0.0',
      fetch: async (url) => {
        fetched.push(url);
        return new Response(PNG, { status: 200 });
      },
    });
  });

  const body = <T extends Parameters<typeof makeBody>[0]>(
    type: T,
    payload: Parameters<typeof makeBody<T>>[1],
  ) => makeBody(type, payload, { deviceId, now });
  const acks = () => events.filter((e) => e.type === 'command.ack');
  const ofType = (type: DeviceEvent['type']) => events.filter((e) => e.type === type);

  it('device.probe returns hello-shaped result and acks', async () => {
    const b = body('device.probe', {});
    const ack = await d.handle(b);
    expect(ack.type).toBe('command.ack');
    expect(ack.inReplyTo).toBe(b.commandId);
    const p = ack.payload as {
      status: string;
      result: { agents: unknown[]; projects: unknown[]; platform: string };
    };
    expect(p.status).toBe('completed');
    expect(p.result.platform).toBe('darwin');
    expect(p.result.agents).toHaveLength(2);
    expect(p.result.projects).toHaveLength(1);
    expect(JSON.stringify(p.result)).not.toContain(t.home);
  });

  it('project.list / project.remove', async () => {
    const list = await d.handle(body('project.list', {}));
    expect((list.payload as { result: { projects: unknown[] } }).result.projects).toHaveLength(1);
    await d.handle(body('project.remove', { projectId }));
    expect(registry.list()).toEqual([]);
    expect(ofType('project.removed')).toHaveLength(1);
    const again = await d.handle(body('project.remove', { projectId }));
    expect(again.payload).toMatchObject({ status: 'failed', errorCode: 'unknown_project' });
  });

  it('agent.start_session fetches attachments, starts, records, emits session.updated, cleans tmp', async () => {
    const sessionId = ids.ses();
    const ref: AttachmentRef = {
      attachmentId: ids.att(),
      downloadUrl: 'https://cdn.example/att',
      sha256: createHash('sha256').update(PNG).digest('hex'),
      sizeBytes: PNG.length,
      mimeType: 'image/png',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    const ack = await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'fix it',
        sessionId,
        attachments: [ref],
        readOnly: false,
        displayName: 'Fix',
      }),
    );
    expect(ack.payload).toMatchObject({ status: 'completed' });
    const call = codex.calls.find((c) => c.method === 'startSession')?.args as {
      localImagePaths: string[];
      project: { path: string };
    };
    expect(call.localImagePaths).toHaveLength(1);
    expect(call.project.path).toMatch(/repo$/);
    expect(existsSync(call.localImagePaths[0] ?? '')).toBe(false); // cleaned up
    expect(fetched).toEqual(['https://cdn.example/att']);
    expect(sessions.get(sessionId)).toMatchObject({
      provider: 'codex',
      projectId,
      status: 'working',
    });
    expect(ofType('session.updated')).toHaveLength(1);
    expect(ofType('attachment.consumed')[0]?.payload).toMatchObject({ ok: true });
    expect(readdirSync(join(t.home, 'home', '.pagr', 'tmp'))).toEqual([]);
  });

  it('agent.start_session fails cleanly on bad attachment and unknown adapter', async () => {
    const ref: AttachmentRef = {
      attachmentId: ids.att(),
      downloadUrl: 'https://cdn.example/att',
      sha256: 'f'.repeat(64),
      sizeBytes: PNG.length,
      mimeType: 'image/png',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    const ack = await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'x',
        sessionId: ids.ses(),
        attachments: [ref],
        readOnly: false,
      }),
    );
    expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'invalid_payload' });
    expect(codex.calls.find((c) => c.method === 'startSession')).toBeUndefined();
    expect(ofType('attachment.consumed')[0]?.payload).toMatchObject({ ok: false });
    codex.failNext = new Error('codex exploded');
    const ack2 = await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'x',
        sessionId: ids.ses(),
        attachments: [],
        readOnly: false,
      }),
    );
    expect(ack2.payload).toMatchObject({
      status: 'failed',
      errorCode: 'provider_error',
      message: 'codex exploded',
    });
  });

  it('agent.send_instruction auto → steer when capable+active, queue otherwise (emits queued_followup)', async () => {
    const s1 = ids.ses();
    const s2 = ids.ses();
    await d.handle(body('device.probe', {}));
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'a',
        sessionId: s1,
        attachments: [],
        readOnly: false,
      }),
    );
    await d.handle(
      body('agent.start_session', {
        provider: 'claude',
        projectId,
        instruction: 'b',
        sessionId: s2,
        attachments: [],
        readOnly: false,
      }),
    );
    const a1 = await d.handle(
      body('agent.send_instruction', {
        sessionId: s1,
        instruction: 'more',
        mode: 'auto',
        attachments: [],
      }),
    );
    expect((a1.payload as { result: unknown }).result).toMatchObject({
      mode: 'steer',
      delivered: 'steered',
    });
    const a2 = await d.handle(
      body('agent.send_instruction', {
        sessionId: s2,
        instruction: 'later',
        mode: 'auto',
        attachments: [],
      }),
    );
    expect((a2.payload as { result: unknown }).result).toMatchObject({
      mode: 'queue',
      delivered: 'queued',
    });
    expect(
      ofType('session.event').filter(
        (e) => (e.payload as { kind: string }).kind === 'queued_followup',
      ),
    ).toHaveLength(1);
    // codex idle → queue even though capable
    codex.sessions.set(s1, {
      ...(codex.sessions.get(s1) as NonNullable<ReturnType<typeof codex.sessions.get>>),
      activeTurn: false,
    });
    const a3 = await d.handle(
      body('agent.send_instruction', {
        sessionId: s1,
        instruction: 'z',
        mode: 'auto',
        attachments: [],
      }),
    );
    expect((a3.payload as { result: unknown }).result).toMatchObject({ mode: 'queue' });
    const bad = await d.handle(
      body('agent.send_instruction', {
        sessionId: ids.ses(),
        instruction: 'z',
        mode: 'auto',
        attachments: [],
      }),
    );
    expect(bad.payload).toMatchObject({ status: 'failed', errorCode: 'unknown_session' });
  });

  it('agent.stop_session and agent.get_status', async () => {
    const s1 = ids.ses();
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'a',
        sessionId: s1,
        attachments: [],
        readOnly: true,
      }),
    );
    const st = await d.handle(body('agent.get_status', { sessionId: s1 }));
    expect((st.payload as { result: { sessions: unknown[] } }).result.sessions).toHaveLength(1);
    await d.handle(body('agent.stop_session', { sessionId: s1 }));
    expect(sessions.get(s1)?.status).toBe('stopped');
    const all = await d.handle(body('agent.get_status', {}));
    expect(
      (all.payload as { result: { sessions: { status: string }[] } }).result.sessions[0]?.status,
    ).toBe('stopped');
  });

  it('settings.sync_public_policy stores locally and drives approval timeout', async () => {
    await d.handle(
      body('settings.sync_public_policy', {
        smartApprovalsTierA: true,
        approvalTimeoutSeconds: 45,
      }),
    );
    expect(d.policy).toEqual({ smartApprovalsTierA: true, approvalTimeoutSeconds: 45 });
    expect(d.approvalTimeoutMs).toBe(45_000);
    expect(existsSync(join(t.home, 'home', '.pagr', 'policy.json'))).toBe(true);
  });

  it('adapter approval flow: request → cloud allow with matching previewHash → adapter told; single-use', async () => {
    const s1 = ids.ses();
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'a',
        sessionId: s1,
        attachments: [],
        readOnly: false,
      }),
    );
    const approvalId = ids.apr();
    codex.push({
      kind: 'approval_requested',
      approvalId,
      sessionId: s1,
      projectId,
      providerRequestId: 'req-1',
      actionType: 'command_execution',
      preview: 'rm -rf build',
      hints: { destructive: true },
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    });
    await vi.waitFor(() => expect(ofType('approval.requested')).toHaveLength(1));
    const req = ofType('approval.requested')[0]?.payload as {
      previewHash: string;
      hints: Record<string, boolean>;
      expiresAt: string;
    };
    expect(req.previewHash).toBe(sha256Hex('rm -rf build'));
    expect(req.hints).toMatchObject({ destructive: true, gitPush: false });
    expect(req.expiresAt).toBe(new Date(now.getTime() + 600_000).toISOString()); // policy default 600 s wins
    // wrong hash rejected
    const bad = await d.handle(
      body('agent.respond_to_approval', {
        approvalId,
        sessionId: s1,
        providerRequestId: 'req-1',
        previewHash: 'a'.repeat(64),
        decision: 'allow',
      }),
    );
    expect(bad.payload).toMatchObject({ status: 'failed', errorCode: 'invalid_payload' });
    expect(codex.calls.find((c) => c.method === 'respondToApproval')).toBeUndefined();
    const ok = await d.handle(
      body('agent.respond_to_approval', {
        approvalId,
        sessionId: s1,
        providerRequestId: 'req-1',
        previewHash: req.previewHash,
        decision: 'allow',
      }),
    );
    expect(ok.payload).toMatchObject({ status: 'completed' });
    expect(codex.calls.find((c) => c.method === 'respondToApproval')?.args).toEqual({
      approvalId,
      providerRequestId: 'req-1',
      decision: 'allow',
    });
    expect(ofType('approval.resolved_locally')[0]?.payload).toMatchObject({
      approvalId,
      resolution: 'allowed',
    });
    // single-use
    const again = await d.handle(
      body('agent.respond_to_approval', {
        approvalId,
        sessionId: s1,
        providerRequestId: 'req-1',
        previewHash: req.previewHash,
        decision: 'allow',
      }),
    );
    expect(again.payload).toMatchObject({ status: 'failed' });
  });

  it('approval timeout → timed_out event and adapter told deny', async () => {
    vi.useFakeTimers({ now });
    try {
      const s1 = ids.ses();
      await d.handle(
        body('agent.start_session', {
          provider: 'codex',
          projectId,
          instruction: 'a',
          sessionId: s1,
          attachments: [],
          readOnly: false,
        }),
      );
      await d.handle(
        body('settings.sync_public_policy', {
          smartApprovalsTierA: false,
          approvalTimeoutSeconds: 30,
        }),
      );
      const approvalId = ids.apr();
      codex.push({
        kind: 'approval_requested',
        approvalId,
        sessionId: s1,
        projectId,
        providerRequestId: 'r',
        actionType: 'file_change',
        preview: 'edit x',
        hints: {},
        expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(ofType('approval.resolved_locally')[0]?.payload).toMatchObject({
        approvalId,
        resolution: 'timed_out',
      });
      expect(codex.calls.find((c) => c.method === 'respondToApproval')?.args).toMatchObject({
        decision: 'deny',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('provider-side resolution does not call back into the adapter', async () => {
    const s1 = ids.ses();
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'a',
        sessionId: s1,
        attachments: [],
        readOnly: false,
      }),
    );
    const approvalId = ids.apr();
    codex.push({
      kind: 'approval_requested',
      approvalId,
      sessionId: s1,
      projectId,
      providerRequestId: 'r',
      actionType: 'other',
      preview: 'p',
      hints: {},
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    });
    codex.push({ kind: 'approval_resolved_locally', approvalId, resolution: 'denied' });
    await vi.waitFor(() => expect(ofType('approval.resolved_locally')).toHaveLength(1));
    expect(codex.calls.find((c) => c.method === 'respondToApproval')).toBeUndefined();
    expect(d.approvals.get(approvalId)).toBeNull();
  });

  it('translates session and session_event adapter events', async () => {
    const s1 = ids.ses();
    const at = now.toISOString();
    codex.push({
      kind: 'session',
      session: {
        sessionId: s1,
        projectId,
        provider: 'codex',
        status: 'completed',
        activeTurn: false,
        startedAt: at,
        updatedAt: at,
      },
    });
    codex.push({
      kind: 'session_event',
      sessionId: s1,
      projectId,
      type: 'completed',
      summary: 'done',
      providerEventId: 'pe1',
    });
    await vi.waitFor(() => expect(ofType('session.event')).toHaveLength(1));
    expect(sessions.get(s1)?.status).toBe('completed');
    expect(ofType('session.event')[0]?.payload).toMatchObject({
      kind: 'completed',
      provider: 'codex',
      providerEventId: 'pe1',
    });
    expect(d.activeSessionCount()).toBe(0);
  });

  it('shutdown cancels pending approvals and shuts adapters down', async () => {
    const s1 = ids.ses();
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'a',
        sessionId: s1,
        attachments: [],
        readOnly: false,
      }),
    );
    let resolution = '';
    d.requestApproval({
      sessionId: s1,
      projectId,
      provider: 'claude',
      providerRequestId: 'hook-1',
      actionType: 'tool_use',
      preview: 'Bash(ls)',
      onDecision: (_d, r) => {
        resolution = r;
      },
    });
    await d.shutdown();
    expect(resolution).toBe('canceled');
    expect(codex.calls.at(-1)?.method).toBe('shutdown');
    expect(acks().length).toBeGreaterThan(0);
  });
});
