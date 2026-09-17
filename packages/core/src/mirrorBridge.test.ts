import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, EventPayload, Provider, SessionSummaryV2 } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterEvent, CodingAgentAdapter } from './adapters/types.js';
import { Dispatcher } from './dispatcher.js';
import { ChannelBridge } from './ipc.js';
import { JournalStore, OutboxCursors } from './journal.js';
import {
  getMirrorBridge,
  type MirrorStatus,
  resetMirrorBridge,
  setMirrorBridge,
} from './mirrorBridge.js';
import { nearestGitRoot, ProjectRegistry } from './projects.js';
import { isAdopted, SessionStore } from './sessions.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

describe('nearestGitRoot', () => {
  const t = useTempHome('pagr-git-root-');

  it('finds the repository a subdirectory belongs to', () => {
    const home = join(t.home, 'home');
    const repo = join(home, 'code', 'app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(nearestGitRoot(join(repo, 'src', 'deep'), { home })).toBe(repo);
    expect(nearestGitRoot(repo, { home })).toBe(repo);
  });

  it('is null outside every repository, and never walks past home', () => {
    const home = join(t.home, 'home');
    const loose = join(home, 'notes');
    mkdirSync(loose, { recursive: true });
    expect(nearestGitRoot(loose, { home })).toBeNull();
    expect(nearestGitRoot(home, { home })).toBeNull();
  });
});

describe('the mirror bridge seam', () => {
  afterEach(() => resetMirrorBridge());

  it('is unwired by default: no project, so nothing is mirrored', () => {
    expect(getMirrorBridge().wired).toBe(false);
    expect(getMirrorBridge().projectFor('/anywhere')).toBeNull();
  });

  it('carries the mirror status back for `pagr doctor`', () => {
    const status: MirrorStatus = {
      enabled: true,
      sessions: 2,
      filesWatched: 3,
      lastFrameAt: '2026-09-17T12:00:00.000Z',
      unknownRecordTypes: 0,
    };
    getMirrorBridge().report(status);
    expect(getMirrorBridge().status()).toEqual(status);
  });

  it('can be replaced and put back', () => {
    setMirrorBridge({
      wired: true,
      projectFor: () => ({
        projectId: ids.proj(),
        path: '/w/app',
        displayName: 'app',
        status: 'registered',
      }),
      report: () => {},
      status: () => null,
    });
    expect(getMirrorBridge().projectFor('/w/app')?.displayName).toBe('app');
    resetMirrorBridge();
    expect(getMirrorBridge().projectFor('/w/app')).toBeNull();
  });
});

describe('Dispatcher and the sessions the bridge did not start', () => {
  const t = useTempHome('pagr-mirror-dispatch-');
  const sessionId = ids.ses();
  let events: DeviceEvent[];
  let d: Dispatcher;
  let sessions: SessionStore;
  let registry: ProjectRegistry;
  let projectId: string;
  let repo: string;
  let journal: JournalStore;

  const summaries = (): SessionSummaryV2[] =>
    events
      .filter((e) => e.type === 'session.updated')
      .map((e) => e.payload as EventPayload<'session.updated'>);

  const emitSession = (
    e: { adopted?: boolean; localCwd?: string; session?: Partial<SessionSummaryV2> } = {},
  ) => {
    const event: Extract<AdapterEvent, { kind: 'session' }> = {
      kind: 'session',
      session: {
        sessionId,
        projectId,
        provider: 'claude',
        status: 'idle',
        activeTurn: false,
        startedAt: '2026-09-17T12:00:00.000Z',
        updatedAt: '2026-09-17T12:00:00.000Z',
        controlLevel: 'approvals_only',
        origin: 'terminal',
        projectStatus: 'registered',
        ...e.session,
      },
      ...(e.adopted !== undefined ? { adopted: e.adopted } : {}),
      ...(e.localCwd !== undefined ? { localCwd: e.localCwd } : {}),
    };
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private adapter-event handler
    return (d as any).onAdapterEvent('claude', event) as Promise<void>;
  };

  beforeEach(() => {
    events = [];
    const home = join(t.home, 'home');
    repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    registry = new ProjectRegistry({ home, pagrHome: join(home, '.pagr') });
    projectId = registry.add(repo).projectId;
    sessions = new SessionStore();
    journal = new JournalStore({ dir: join(t.home, 'journal') });
    d = new Dispatcher({
      deviceId: ids.dev(),
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry,
      sessions,
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      frames: {
        journal,
        cursors: new OutboxCursors({
          file: join(t.home, 'journal', 'outbox.json'),
          writeDelayMs: 0,
        }),
        recipientKeys: () => ({}),
        protocolVersion: () => 2,
      },
    });
  });
  afterEach(() => journal.closeAll());

  it('records an adopted session as adopted, with its directory', async () => {
    await emitSession({ adopted: true, localCwd: join(repo, 'src') });
    const rec = sessions.get(sessionId);
    expect(rec && isAdopted(rec)).toBe(true);
    expect(rec?.cwd).toBe(join(repo, 'src'));
  });

  it('refuses to instruct or stop it, and keeps refusing after a status update', async () => {
    await emitSession({ adopted: true, localCwd: repo });
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private guard
    const assertOurs = (what: string) => (d as any).assertOurSession(sessionId, what);
    expect(() => assertOurs('send an instruction to')).toThrow(/Pagr did not start it/);
    // A later update that says nothing about adoption must not silently un-adopt it.
    await emitSession({ session: { status: 'idle', updatedAt: '2026-09-17T12:05:00.000Z' } });
    expect(sessions.get(sessionId)?.adopted).toBe(true);
    expect(() => assertOurs('stop')).toThrow(/cannot stop it/);
  });

  /**
   * The one exception, and the reason it is narrow. A channel is a documented way INTO a running
   * Claude Code session, so a follow-up really can be delivered to one. The `claude` process
   * still belongs to the terminal it is running in, so stopping it stays refused: Pagr has no
   * handle on it to kill, and no business killing it if it had.
   */
  it('accepts an instruction for a channel-bound session, and still refuses to stop it', async () => {
    const bridge = new ChannelBridge();
    const dispatcher = new Dispatcher({
      deviceId: ids.dev(),
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry,
      sessions,
      emit: () => {},
      tmpDir: join(t.home, 'tmp'),
      bridgeVersion: '0.1.0',
      channelBridge: bridge,
    });
    await emitSession({ adopted: true, localCwd: repo });
    const assertOurs = (what: string, channelBound?: boolean) =>
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private guard
      (dispatcher as any).assertOurSession(sessionId, what, { channelBound });

    // Bound but not polling: a channel that died must not leave the session steerable.
    bridge.bindSession(sessionId, { cwd: repo, projectId, claudeSessionId: 'cs-1' });
    expect(() => assertOurs('send an instruction to', true)).toThrow(/Pagr did not start it/);

    bridge.attach(repo);
    expect(() => assertOurs('send an instruction to', true)).not.toThrow();
    expect(() => assertOurs('stop')).toThrow(/cannot stop it/);
  });

  it('stamps how far the journal goes, and says nothing when it is empty', async () => {
    await emitSession({ adopted: true });
    expect(summaries()[0]?.lastSeq).toBeUndefined();
    journal.append(
      sessionId,
      { kind: 'assistant', text: 'hi' },
      { projectId, provider: 'claude', meta: { source: 'transcript' } },
    );
    journal.append(
      sessionId,
      { kind: 'assistant', text: 'again' },
      { projectId, provider: 'claude', meta: { source: 'transcript' } },
    );
    await emitSession({ adopted: true });
    expect(summaries()[1]?.lastSeq).toBe(2);
  });

  it('carries the v2 control fields through to the phone unchanged', async () => {
    await emitSession({
      adopted: true,
      session: { controlLevel: 'none', origin: 'ide', projectStatus: 'unregistered' },
    });
    expect(summaries()[0]).toMatchObject({
      controlLevel: 'none',
      origin: 'ide',
      projectStatus: 'unregistered',
    });
  });

  it('offers an unregistered directory as a handle that `project.register_handle` resolves', () => {
    const loose = join(t.home, 'home', 'loose');
    mkdirSync(join(loose, '.git'), { recursive: true });
    const handle = d.offerRepoHandle(loose);
    expect(handle).toMatch(/^rh_[0-9a-f]{32}$/);
    expect(d.remoteProjectPick().handles).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private command handler
    const summary = (d as any).registerRepoHandle({ handle }) as { projectId: string };
    expect(registry.resolve(summary.projectId).path).toBe(loose);
  });

  it('offers nothing when remote project pick is off on this Mac', () => {
    const off = new Dispatcher({
      deviceId: ids.dev(),
      adapters: new Map<Provider, CodingAgentAdapter>(),
      registry,
      sessions,
      emit: () => {},
      tmpDir: join(t.home, 'tmp'),
      bridgeVersion: '0.1.0',
      env: { PAGR_REMOTE_PROJECT_PICK: '0' },
    });
    expect(off.offerRepoHandle(repo)).toBeNull();
  });
});
