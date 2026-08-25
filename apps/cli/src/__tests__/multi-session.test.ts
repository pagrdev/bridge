import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '@pagr/bridge-adapter-claude';
import { CodexAdapter } from '@pagr/bridge-adapter-codex';
import {
  type CodingAgentAdapter,
  Dispatcher,
  isLiveStatus,
  ProjectRegistry,
  reconcileSessions,
  SessionStore,
} from '@pagr/bridge-core';
import type {
  CommandBody,
  CommandPayload,
  CommandType,
  DeviceEvent,
  Provider,
} from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * End-to-end multi-session behaviour against the fixture agents — real child processes speaking
 * the real stdio protocols, not stubs. Everything the founder asked about happens in one file:
 * three sessions over two projects, a refusal, a steer, a crash, a stop, and a daemon restart in
 * the middle of it all.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const CODEX_FIXTURE = join(repoRoot, 'packages/adapter-codex/src/__fixtures__/fake-app-server.mjs');
const CLAUDE_FIXTURE = join(repoRoot, 'packages/adapter-claude/src/__fixtures__/fake-claude.mjs');

const hex32 = () => randomBytes(16).toString('hex');
const sesId = () => `ses_${hex32()}`;

function body<T extends CommandType>(type: T, payload: CommandPayload<T>): CommandBody {
  const at = new Date();
  return {
    version: 1,
    commandId: `cmd_${hex32()}`,
    userId: `usr_${hex32()}`,
    deviceId: `dev_${hex32()}`,
    issuedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 300_000).toISOString(),
    nonce: hex32(),
    idempotencyKey: hex32(),
    type,
    payload,
  } as CommandBody;
}

interface Ack {
  status: string;
  errorCode?: string;
  message?: string;
  result?: unknown;
}
const ackOf = (e: DeviceEvent): Ack => e.payload as unknown as Ack;

describe('many sessions across many projects', () => {
  let root: string;
  let home: string;
  let repoA: string;
  let repoB: string;
  let registry: ProjectRegistry;
  let sessions: SessionStore;
  let codex: CodexAdapter;
  let claude: ClaudeAdapter;
  let adapters: Map<Provider, CodingAgentAdapter>;
  let dispatcher: Dispatcher;
  let events: DeviceEvent[];
  let projA: string;
  let projB: string;

  const mkrepo = (name: string) => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    return dir;
  };

  const buildAdapters = () => {
    codex = new CodexAdapter({
      home,
      codexCommand: ['node', CODEX_FIXTURE],
      approvalTimeoutMs: 2000,
      restartDelayMs: 20,
      log: false,
    });
    claude = new ClaudeAdapter({
      home,
      claudeCommand: ['node', CLAUDE_FIXTURE],
      approvalTimeoutMs: 2000,
      log: false,
    });
    adapters = new Map<Provider, CodingAgentAdapter>([
      ['codex', codex],
      ['claude', claude],
    ]);
  };

  const buildDispatcher = () => {
    dispatcher = new Dispatcher({
      deviceId: `dev_${hex32()}`,
      adapters,
      registry,
      sessions,
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, 'policy.json'),
    });
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pagr-multi-')));
    home = join(root, 'pagr-home');
    mkdirSync(join(home, 'tmp'), { recursive: true });
    repoA = mkrepo('alpha');
    repoB = mkrepo('beta');
    registry = new ProjectRegistry({
      file: join(home, 'projects.json'),
      home: root,
      pagrHome: home,
    });
    projA = registry.add(repoA).projectId;
    projB = registry.add(repoB).projectId;
    sessions = new SessionStore(join(home, 'sessions.json'));
    events = [];
    buildAdapters();
    buildDispatcher();
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  const start = (o: {
    provider: Provider;
    projectId: string;
    instruction: string;
    readOnly?: boolean;
    sessionId?: string;
  }) => {
    const sessionId = o.sessionId ?? sesId();
    return dispatcher
      .handle(
        body('agent.start_session', {
          provider: o.provider,
          projectId: o.projectId,
          instruction: o.instruction,
          sessionId,
          attachments: [],
          readOnly: o.readOnly ?? false,
        }),
      )
      .then((ack) => ({ sessionId, ack: ackOf(ack) }));
  };

  const waitFor = async (pred: () => boolean, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out; sessions: ${JSON.stringify(sessions.list(), null, 2)}`);
  };
  const statusOf = (id: string) => sessions.get(id)?.status;

  it('runs three sessions over two projects, refusing only the unsafe combination', async () => {
    // 1. a Codex writer in alpha, mid-turn
    const a = await start({ provider: 'codex', projectId: projA, instruction: 'wait for me' });
    expect(a.ack.status).toBe('completed');

    // 2. a Claude writer in beta
    const b = await start({ provider: 'claude', projectId: projB, instruction: 'hang around' });
    expect(b.ack.status).toBe('completed');

    // 3. a read-only Codex reviewer, also in beta — safe next to a writer
    const c = await start({
      provider: 'codex',
      projectId: projB,
      instruction: 'wait and review',
      readOnly: true,
    });
    expect(c.ack.status).toBe('completed');

    await waitFor(() => statusOf(a.sessionId) === 'working' && statusOf(b.sessionId) === 'working');
    expect(dispatcher.activeSessionCount()).toBe(3);

    // 4. a second writer in alpha is refused, by name, with a reason
    const d = await start({ provider: 'claude', projectId: projA, instruction: 'me too' });
    expect(d.ack.status).toBe('failed');
    expect(d.ack.errorCode).toBe('capability_unsupported');
    expect(d.ack.message).toContain(a.sessionId);
    expect(d.ack.message).toMatch(/working tree/);
    expect(sessions.get(d.sessionId)).toBeNull();

    // 5. steering the live Codex turn reaches the provider
    const steer = await dispatcher.handle(
      body('agent.send_instruction', {
        sessionId: a.sessionId,
        instruction: 'actually do the other thing',
        mode: 'steer',
        attachments: [],
      }),
    );
    expect(ackOf(steer).result).toMatchObject({ delivered: 'steered' });
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === 'session.event' &&
          (e.payload as { sessionId: string; summary: string }).sessionId === a.sessionId &&
          (e.payload as { summary: string }).summary.includes('Steer received'),
      ),
    );

    // 6. stopping the reviewer frees its slot without touching the others
    const stopped = await dispatcher.handle(body('agent.stop_session', { sessionId: c.sessionId }));
    expect(ackOf(stopped).status).toBe('completed');
    await waitFor(() => statusOf(c.sessionId) === 'stopped');
    expect(statusOf(a.sessionId)).toBe('working');
    expect(statusOf(b.sessionId)).toBe('working');
  });

  it('surfaces a provider crash as a failed session, not a hung one', async () => {
    const a = await start({ provider: 'codex', projectId: projA, instruction: 'wait for me' });
    const b = await start({ provider: 'claude', projectId: projB, instruction: 'crash now' });
    expect(b.ack.status).toBe('completed');
    await waitFor(() => statusOf(b.sessionId) === 'failed');
    expect(
      events.some(
        (e) =>
          e.type === 'session.event' &&
          (e.payload as { sessionId: string; kind: string }).sessionId === b.sessionId &&
          (e.payload as { kind: string }).kind === 'failed',
      ),
    ).toBe(true);
    // the other provider's session is untouched
    expect(statusOf(a.sessionId)).toBe('working');
    // and the tree the crashed session held is free again
    const replacement = await start({
      provider: 'codex',
      projectId: projB,
      instruction: 'run tests',
    });
    expect(replacement.ack.status).toBe('completed');
  });

  it('reconciles every session after a daemon restart, leaving no zombies', async () => {
    const a = await start({ provider: 'codex', projectId: projA, instruction: 'wait for me' });
    const b = await start({ provider: 'claude', projectId: projB, instruction: 'hang around' });
    await waitFor(() => statusOf(a.sessionId) === 'working' && statusOf(b.sessionId) === 'working');

    // A session the daemon minted for the user's own interactive Claude Code: no adapter has it.
    const orphan = sesId();
    sessions.upsert({
      sessionId: orphan,
      provider: 'claude',
      projectId: projA,
      providerSessionId: orphan,
      status: 'waiting_for_approval',
      startedAt: new Date().toISOString(),
    });

    // --- the daemon dies ---
    await dispatcher.shutdown();

    // --- and comes back: fresh adapters, same files on disk ---
    events = [];
    sessions = new SessionStore(join(home, 'sessions.json'));
    expect(sessions.get(a.sessionId)?.status).toBe('working'); // the zombie, as persisted
    buildAdapters();
    buildDispatcher();

    const changed = await reconcileSessions({ sessions, adapters });
    const byId = new Map(changed.map((c) => [c.record.sessionId, c]));
    expect(byId.get(a.sessionId)?.outcome).toBe('resumable');
    expect(byId.get(b.sessionId)?.outcome).toBe('resumable');
    expect(byId.get(orphan)?.outcome).toBe('terminated');
    for (const s of sessions.list()) expect(isLiveStatus(s.status)).toBe(false);
    expect(dispatcher.activeSessionCount()).toBe(0);

    // a resumable session really does resume: a new instruction starts a fresh turn
    const again = await dispatcher.handle(
      body('agent.send_instruction', {
        sessionId: a.sessionId,
        instruction: 'run tests',
        mode: 'auto',
        attachments: [],
      }),
    );
    expect(ackOf(again).result).toMatchObject({ delivered: 'new_turn' });
    await waitFor(() => statusOf(a.sessionId) === 'completed');

    // and the freed working tree can be claimed by the other provider now
    const c = await start({ provider: 'claude', projectId: projB, instruction: 'hello' });
    expect(c.ack.status).toBe('completed');
  });

  it('keeps sessions.json bounded across many sessions', async () => {
    for (let i = 0; i < 12; i++) {
      const id = sesId();
      sessions.upsert({
        sessionId: id,
        provider: 'codex',
        projectId: projA,
        providerSessionId: id,
        status: 'completed',
        startedAt: new Date(Date.now() - i * 60_000).toISOString(),
        updatedAt: new Date(Date.now() - i * 60_000).toISOString(),
      });
    }
    expect(sessions.size).toBe(12);
    sessions.prune({ maxEntries: 5 });
    expect(sessions.size).toBe(5);
    expect(new SessionStore(join(home, 'sessions.json')).size).toBe(5);
  });
});
