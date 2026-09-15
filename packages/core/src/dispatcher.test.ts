import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
  const attachment = (): AttachmentRef => ({
    attachmentId: ids.att(),
    downloadUrl: 'https://cdn.example/att',
    sha256: createHash('sha256').update(PNG).digest('hex'),
    sizeBytes: PNG.length,
    mimeType: 'image/png',
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  const withShot = (sessionId: string) =>
    ({
      provider: 'codex',
      projectId,
      instruction: 'look at this',
      sessionId,
      attachments: [attachment()],
      readOnly: false,
    }) as Parameters<typeof makeBody<'agent.start_session'>>[1];
  const startArgs = (sessionId: string) =>
    codex.calls.find(
      (c) =>
        c.method === 'startSession' && (c.args as { sessionId: string }).sessionId === sessionId,
    )?.args as { localImagePaths: string[] };
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

  describe('concurrent sessions', () => {
    const start = (over: {
      provider?: Provider;
      projectId?: string;
      sessionId?: string;
      readOnly?: boolean;
    }) =>
      d.handle(
        body('agent.start_session', {
          provider: over.provider ?? 'codex',
          projectId: over.projectId ?? projectId,
          instruction: 'go',
          sessionId: over.sessionId ?? ids.ses(),
          attachments: [],
          readOnly: over.readOnly ?? false,
        }),
      );

    const extraProject = (name: string) => {
      const p = join(t.home, 'home', name);
      mkdirSync(join(p, '.git'), { recursive: true });
      return registry.add(p).projectId;
    };

    it('allows two sessions in different projects', async () => {
      const other = extraProject('repo2');
      expect((await start({})).payload).toMatchObject({ status: 'completed' });
      expect((await start({ projectId: other })).payload).toMatchObject({ status: 'completed' });
    });

    it('allows two Codex sessions in two different projects', async () => {
      const other = extraProject('repo2');
      await start({ provider: 'codex' });
      expect((await start({ provider: 'codex', projectId: other })).payload).toMatchObject({
        status: 'completed',
      });
    });

    it('refuses a Claude session in a project a Codex session already holds', async () => {
      const first = ids.ses();
      await start({ provider: 'codex', sessionId: first });
      const ack = await start({ provider: 'claude' });
      expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'capability_unsupported' });
      expect((ack.payload as { message: string }).message).toContain(first);
      expect((ack.payload as { message: string }).message).toMatch(/working tree/);
      expect(claude.calls.filter((c) => c.method === 'startSession')).toHaveLength(0);
    });

    it('refuses a second write-capable session of the same provider in one project', async () => {
      await start({ provider: 'codex' });
      expect((await start({ provider: 'codex' })).payload).toMatchObject({
        status: 'failed',
        errorCode: 'capability_unsupported',
      });
    });

    it('allows a read-only session alongside a writer', async () => {
      await start({ provider: 'codex' });
      expect((await start({ provider: 'claude', readOnly: true })).payload).toMatchObject({
        status: 'completed',
      });
    });

    it('frees the working tree once the holder stops', async () => {
      const first = ids.ses();
      await start({ provider: 'codex', sessionId: first });
      await d.handle(body('agent.stop_session', { sessionId: first }));
      expect((await start({ provider: 'claude' })).payload).toMatchObject({ status: 'completed' });
    });

    it('enforces a per-provider process budget', async () => {
      const roots = ['a', 'b', 'c', 'd', 'e'].map((n) => extraProject(`r-${n}`));
      for (const pid of roots.slice(0, 4))
        expect((await start({ provider: 'claude', projectId: pid })).payload).toMatchObject({
          status: 'completed',
        });
      const ack = await start({ provider: 'claude', projectId: roots[4] as string });
      expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'capability_unsupported' });
      expect((ack.payload as { message: string }).message).toMatch(/limit of 4/);
      // the other provider still has room
      expect(
        (await start({ provider: 'codex', projectId: roots[4] as string })).payload,
      ).toMatchObject({ status: 'completed' });
    });

    it('does not hold a working tree it can no longer name', async () => {
      const other = extraProject('repo2');
      await start({ provider: 'codex', projectId: other });
      registry.remove(other);
      // The tree rule cannot apply to an unnameable path…
      expect((await start({ provider: 'codex' })).payload).toMatchObject({ status: 'completed' });
    });

    it('still counts an unregistered project’s session against the budget', async () => {
      const roots = ['a', 'b', 'c', 'd'].map((n) => extraProject(`b-${n}`));
      for (const pid of roots)
        expect((await start({ provider: 'claude', projectId: pid })).payload).toMatchObject({
          status: 'completed',
        });
      for (const pid of roots) registry.remove(pid);
      const ack = await start({ provider: 'claude' });
      expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'capability_unsupported' });
      expect((ack.payload as { message: string }).message).toMatch(/limit of 4/);
    });

    it('refuses the second of two starts issued in the same tick', async () => {
      // Commands are dispatched fire-and-forget, so the guard must claim the tree before its
      // first await — otherwise both of these see an empty set of live sessions.
      codex.startSession = async (input) => {
        await new Promise((r) => setTimeout(r, 20));
        const ts = now.toISOString();
        return {
          sessionId: input.sessionId,
          projectId: input.project.projectId,
          provider: 'codex' as const,
          status: 'working' as const,
          activeTurn: true,
          startedAt: ts,
          updatedAt: ts,
        };
      };
      const [first, second] = await Promise.all([
        start({ provider: 'codex' }),
        start({ provider: 'codex' }),
      ]);
      const statuses = [first, second].map((a) => (a.payload as { status: string }).status).sort();
      expect(statuses).toEqual(['completed', 'failed']);
      const failed = [first, second].find(
        (a) => (a.payload as { status: string }).status === 'failed',
      );
      expect(failed?.payload).toMatchObject({ errorCode: 'capability_unsupported' });
      expect(sessions.list().filter((s) => s.status !== 'stopped')).toHaveLength(1);
    });

    it('drops the reservation when the provider fails to start', async () => {
      const sessionId = ids.ses();
      codex.failNext = new Error('codex exploded');
      const ack = await start({ provider: 'codex', sessionId });
      expect(ack.payload).toMatchObject({ status: 'failed' });
      // A record left at `starting` would hold this tree — and a slot in the budget — forever.
      expect(sessions.get(sessionId)).toBeNull();
      expect(d.activeSessionCount()).toBe(0);
      expect((await start({ provider: 'claude' })).payload).toMatchObject({ status: 'completed' });
    });

    it('keeps holding the tree of a session whose project was re-registered', async () => {
      const repo = join(t.home, 'home', 'repo');
      await start({ provider: 'codex' });
      registry.remove(projectId);
      const readded = registry.add(repo).projectId;
      const ack = await start({ provider: 'claude', projectId: readded });
      expect(ack.payload).toMatchObject({
        status: 'failed',
        errorCode: 'capability_unsupported',
      });
    });

    it('remembers that a session is read-only across status updates', async () => {
      const sessionId = ids.ses();
      await start({ provider: 'codex', sessionId, readOnly: true });
      codex.push({
        kind: 'session',
        session: {
          sessionId,
          projectId,
          provider: 'codex',
          status: 'working',
          activeTurn: true,
          startedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      });
      expect(sessions.get(sessionId)?.readOnly).toBe(true);
    });
  });

  it('never resurrects a turn that finished while send_instruction was in flight', async () => {
    const sessionId = ids.ses();
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'go',
        sessionId,
        attachments: [],
        readOnly: false,
      }),
    );
    // A provider fast enough to finish the whole turn before `sendInstruction` resolves: the
    // adapter reports `completed`, so the store must not be stamped back to `working`.
    const finished = {
      sessionId,
      projectId,
      provider: 'codex' as const,
      status: 'completed' as const,
      activeTurn: false,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    codex.sendInstruction = async () => {
      codex.sessions.set(sessionId, finished);
      codex.push({ kind: 'session', session: finished });
      return { delivered: 'new_turn' as const };
    };
    const ack = await d.handle(
      body('agent.send_instruction', {
        sessionId,
        instruction: 'more',
        mode: 'queue',
        attachments: [],
      }),
    );
    expect((ack.payload as { result: unknown }).result).toMatchObject({ delivered: 'new_turn' });
    expect(sessions.get(sessionId)?.status).toBe('completed');
    expect(d.activeSessionCount()).toBe(0);
    const last = ofType('session.updated').at(-1)?.payload as { status: string };
    expect(last.status).toBe('completed');
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
    // The adapter resolves when the turn is written to the agent, NOT when the agent has read the
    // image — so the file must still be there (and still be the screenshot) for the whole turn.
    const shot = call.localImagePaths[0] ?? '';
    expect(existsSync(shot)).toBe(true);
    expect(fetched).toEqual(['https://cdn.example/att']);
    expect(sessions.get(sessionId)).toMatchObject({
      provider: 'codex',
      projectId,
      status: 'working',
    });
    expect(ofType('session.updated')).toHaveLength(1);
    expect(ofType('attachment.consumed')[0]?.payload).toMatchObject({ ok: true });
    // ...and it is gone once the turn that referenced it finishes.
    codex.push({
      kind: 'session_event',
      sessionId,
      projectId,
      type: 'completed',
      summary: 'done',
    });
    await vi.waitFor(() => expect(existsSync(shot)).toBe(false));
    expect(readdirSync(join(t.home, 'home', '.pagr', 'tmp'))).toEqual([]);
  });

  it('an agent that reads the attachment mid-turn still finds it', async () => {
    const sessionId = ids.ses();
    const ack = await d.handle(body('agent.start_session', withShot(sessionId)));
    expect(ack.payload).toMatchObject({ status: 'completed' });
    const shot = startArgs(sessionId).localImagePaths[0] ?? '';
    // Several ticks after the dispatch call resolved — this is the model finally running `Read`.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(readFileSync(shot)).toEqual(PNG);
    expect(d.leasedAttachments(sessionId)).toEqual([shot]);
    codex.push({
      kind: 'session',
      session: {
        sessionId,
        projectId,
        provider: 'codex',
        status: 'completed',
        activeTurn: false,
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
    await vi.waitFor(() => expect(existsSync(shot)).toBe(false));
    expect(d.leasedAttachments(sessionId)).toEqual([]);
  });

  it('a follow-up queued behind a running turn keeps its own images until its own turn ends', async () => {
    const sessionId = ids.ses();
    await d.handle(body('agent.start_session', withShot(sessionId)));
    const first = startArgs(sessionId).localImagePaths[0] ?? '';
    // The session is mid-turn, so this instruction (with its own screenshot) is queued.
    const ack = await d.handle(
      body('agent.send_instruction', {
        sessionId,
        instruction: 'and this one',
        mode: 'queue',
        attachments: [attachment()],
      }),
    );
    expect((ack.payload as { result: { delivered: string } }).result.delivered).toBe('queued');
    const sent = codex.calls.find((c) => c.method === 'sendInstruction')?.args as {
      localImagePaths: string[];
    };
    const second = sent.localImagePaths[0] as string;
    expect(first).not.toBe(second);
    const end = () =>
      codex.push({ kind: 'session_event', sessionId, projectId, type: 'completed', summary: 'x' });
    end();
    await vi.waitFor(() => expect(existsSync(first)).toBe(false));
    expect(existsSync(second)).toBe(true); // the queued turn has not run yet
    codex.push({ kind: 'session_event', sessionId, projectId, type: 'started', summary: 'x' });
    end();
    await vi.waitFor(() => expect(existsSync(second)).toBe(false));
  });

  it('frees the attachment when the turn never starts, and sweeps one whose turn never ends', async () => {
    const dead = ids.ses();
    codex.failNext = new Error('codex exploded');
    const ack = await d.handle(body('agent.start_session', withShot(dead)));
    expect(ack.payload).toMatchObject({ status: 'failed' });
    expect(readdirSync(join(t.home, 'home', '.pagr', 'tmp'))).toEqual([]);

    const wedged = ids.ses();
    await d.handle(body('agent.start_session', withShot(wedged)));
    const shot = startArgs(wedged).localImagePaths[0] ?? '';
    expect(existsSync(shot)).toBe(true);
    expect(d.sweepAttachmentLeases()).toBe(0); // inside the TTL
    now = new Date(now.getTime() + 2 * 3600_000);
    expect(d.sweepAttachmentLeases()).toBe(1);
    expect(existsSync(shot)).toBe(false);
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
    // Two writers need two working trees; sharing one is refused (see "concurrent sessions").
    const otherRepo = join(t.home, 'home', 'repo-claude');
    mkdirSync(join(otherRepo, '.git'), { recursive: true });
    const otherProject = registry.add(otherRepo).projectId;
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
        projectId: otherProject,
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

  it('agent.send_instruction resumes a completed session and emits session.updated → working (item 17)', async () => {
    const s1 = ids.ses();
    await d.handle(
      body('agent.start_session', {
        provider: 'claude',
        projectId,
        instruction: 'a',
        sessionId: s1,
        attachments: [],
        readOnly: false,
      }),
    );
    // the turn finished: local record and provider both say completed
    sessions.setStatus(s1, 'completed');
    claude.sessions.set(s1, {
      ...(claude.sessions.get(s1) as NonNullable<ReturnType<typeof claude.sessions.get>>),
      status: 'completed',
      activeTurn: false,
    });
    events.length = 0;
    const ack = await d.handle(
      body('agent.send_instruction', {
        sessionId: s1,
        instruction: 'more please',
        mode: 'auto',
        attachments: [],
      }),
    );
    expect(ack.payload).toMatchObject({ status: 'completed' });
    expect((ack.payload as { result: unknown }).result).toMatchObject({ delivered: 'new_turn' });
    expect(sessions.get(s1)?.status).toBe('working');
    const upd = ofType('session.updated');
    expect(upd).toHaveLength(1);
    expect(upd[0]?.payload).toMatchObject({ sessionId: s1, status: 'working', activeTurn: true });
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

  const openApproval = async (approvalId: string, sessionId: string) => {
    await d.handle(
      body('agent.start_session', {
        provider: 'codex',
        projectId,
        instruction: 'a',
        sessionId,
        attachments: [],
        readOnly: false,
      }),
    );
    codex.push({
      kind: 'approval_requested',
      approvalId,
      sessionId,
      projectId,
      providerRequestId: 'req-1',
      actionType: 'command_execution',
      preview: 'rm -rf build',
      hints: {},
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    });
    await vi.waitFor(() => expect(ofType('approval.requested')).toHaveLength(1));
    return sha256Hex('rm -rf build');
  };

  it('answering an unknown or expired approval reports unknown_approval, not unknown_session', async () => {
    const sessionId = ids.ses();
    const previewHash = await openApproval(ids.apr(), sessionId);
    const ack = await d.handle(
      body('agent.respond_to_approval', {
        approvalId: ids.apr(), // never registered — or long since timed out
        sessionId,
        providerRequestId: 'req-1',
        previewHash,
        decision: 'allow',
      }),
    );
    // The session is alive and well; only the approval is gone. Saying `unknown_session` sent the
    // phone to "this session no longer exists".
    expect(ack.payload).toMatchObject({ status: 'failed', errorCode: 'unknown_approval' });
    expect(sessions.get(sessionId)?.status).toBe('working');
  });

  it('a relay that throws produces one coherent failure, never approved-and-failed', async () => {
    const approvalId = ids.apr();
    const sessionId = ids.ses();
    const previewHash = await openApproval(approvalId, sessionId);
    codex.failNext = new Error('app-server connection closed');
    const ack = await d.handle(
      body('agent.respond_to_approval', {
        approvalId,
        sessionId,
        providerRequestId: 'req-1',
        previewHash,
        decision: 'allow',
      }),
    );
    expect(ack.payload).toMatchObject({
      status: 'failed',
      message: 'app-server connection closed',
    });
    // The phone must NOT have been told the action was approved.
    expect(ofType('approval.resolved_locally')).toHaveLength(0);
    const failures = ofType('session.event').filter(
      (e) => (e.payload as { kind: string }).kind === 'failed',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({ sessionId, provider: 'codex' });
    // Still single-use: the failed relay did not leave the approval answerable again.
    const again = await d.handle(
      body('agent.respond_to_approval', {
        approvalId,
        sessionId,
        providerRequestId: 'req-1',
        previewHash,
        decision: 'allow',
      }),
    );
    expect(again.payload).toMatchObject({ status: 'failed', errorCode: 'unknown_approval' });
    expect(d.approvals.get(approvalId)).toBeNull();
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
