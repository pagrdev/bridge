import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDaemon, type Daemon } from './daemon.js';
import { ChannelBridge, IpcServer, registerChannelMethods } from './ipc.js';
import { MemorySecretStore } from './keychain.js';
import { useTempHome } from './testUtil.js';

describe('ChannelBridge', () => {
  it('returns everything past the cursor without waiting', async () => {
    const b = new ChannelBridge();
    b.enqueue('/p', 'a');
    b.enqueue('/p', 'b');
    const first = await b.poll('/p', 0, 0);
    expect(first).toEqual({
      cursor: 2,
      messages: [
        { seq: 1, text: 'a' },
        { seq: 2, text: 'b' },
      ],
    });
    expect(await b.poll('/p', 2, 0)).toEqual({ cursor: 2, messages: [] });
  });

  it('wakes a waiting poll the moment a text is enqueued', async () => {
    const b = new ChannelBridge();
    const pending = b.poll('/p', 0, 5_000);
    b.enqueue('/p', 'steer me');
    expect((await pending).messages.map((m) => m.text)).toEqual(['steer me']);
  });

  it('gives up after the poll window with an empty batch', async () => {
    const b = new ChannelBridge();
    expect(await b.poll('/p', 0, 5)).toEqual({ cursor: 0, messages: [] });
  });

  it('keeps queues per project', async () => {
    const b = new ChannelBridge();
    b.enqueue('/a', 'for a');
    b.enqueue('/b', 'for b');
    expect((await b.poll('/a', 0, 0)).messages.map((m) => m.text)).toEqual(['for a']);
    // Only a project something is actually polling counts as attached; a queued text does not
    // prove a channel exists (see CHANNEL_ATTACH_TTL_MS).
    expect(b.attachedProjects()).toEqual(['/a']);
  });

  it('stops reporting a channel as attached once it stops polling', async () => {
    let clock = 1_000_000;
    const b = new ChannelBridge(() => clock, 1000);
    await b.poll('/p', 0, 0);
    expect(b.isAttached('/p')).toBe(true);
    clock += 999;
    expect(b.isAttached('/p')).toBe(true);
    clock += 2;
    expect(b.isAttached('/p')).toBe(false);
    expect(b.attachedProjects()).toEqual([]);
    // a fresh poll re-attaches it
    await b.poll('/p', 0, 0);
    expect(b.isAttached('/p')).toBe(true);
  });

  it('does not treat an enqueue as an attachment', () => {
    const b = new ChannelBridge();
    b.enqueue('/p', 'steer me');
    expect(b.isAttached('/p')).toBe(false);
  });

  it('attaches on poll and reports attachment', async () => {
    const b = new ChannelBridge();
    expect(b.isAttached('/p')).toBe(false);
    await b.poll('/p', 0, 0);
    expect(b.isAttached('/p')).toBe(true);
  });

  it('drops queues and bindings on reset', () => {
    const b = new ChannelBridge();
    b.enqueue('/p', 'x');
    b.bindSession('ses_1', { cwd: '/p', projectId: 'prj_1' });
    b.reset();
    expect(b.isAttached('/p')).toBe(false);
    expect(b.bindingFor('ses_1')).toBeUndefined();
  });

  it('bounds the backlog of a channel that stopped polling', async () => {
    const b = new ChannelBridge();
    for (let i = 0; i < 260; i++) b.enqueue('/p', `m${i}`);
    const res = await b.poll('/p', 0, 0);
    expect(res.messages.length).toBe(200);
    expect(res.cursor).toBe(260);
  });
});

describe('registerChannelMethods', () => {
  const project = { projectId: 'prj_1', path: '/code/app' };
  let ipc: IpcServer;
  let bridge: ChannelBridge;
  let messages: Array<{ sessionId: string; projectId: string; text: string }>;
  let minted: string[];
  /** Stands in for `~/.claude/sessions/<pid>.json`: which Claude session a live pid is running. */
  let pidFiles: Map<number, string>;
  let bound: Array<{ sessionId: string; claudeSessionId: string; projectId: string }>;

  beforeEach(() => {
    ipc = new IpcServer({ socketPath: '/unused.sock' });
    bridge = new ChannelBridge();
    messages = [];
    minted = [];
    pidFiles = new Map();
    bound = [];
    registerChannelMethods(ipc, {
      bridge,
      pollTimeoutMs: 5,
      resolveProject: (cwd) => (cwd.startsWith(project.path) ? project : null),
      claudeSessionsIn: () => ['ses_a', 'ses_b'],
      claudeSessionForPid: (pid) => {
        const claudeSessionId = pidFiles.get(pid);
        return claudeSessionId ? { claudeSessionId, sessionId: `ses_of_${claudeSessionId}` } : null;
      },
      onBound: (b) => void bound.push(b),
      ensureSession: ({ sessionId }) => {
        const id = sessionId ?? 'ses_minted';
        minted.push(id);
        return id;
      },
      emitAgentMessage: (m) => void messages.push(m),
    });
  });

  /** Invoke a registered handler the way `IpcServer.handleLine` would (always async). */
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const handler = (
      ipc as unknown as { methods: Map<string, (p: unknown) => unknown> }
    ).methods.get(method);
    if (!handler) throw new Error(`no method ${method}`);
    return handler(params);
  };

  it('registers exactly the two channel methods', () => {
    expect(ipc.methodNames().sort()).toEqual(['channel.outbound', 'channel.poll']);
  });

  it('binds every claude session in the project on poll', async () => {
    await call('channel.poll', { cwd: `${project.path}/sub`, cursor: 0 });
    expect(bridge.bindingFor('ses_a')).toEqual({ cwd: project.path, projectId: project.projectId });
    expect(bridge.bindingFor('ses_b')).toEqual({ cwd: project.path, projectId: project.projectId });
    expect(bridge.isAttached(project.path)).toBe(true);
  });

  /**
   * The binding that matters. `claudePid` is the `claude` that spawned the channel server, so the
   * daemon can name the exact Claude session and the phone can take a turn in THAT terminal —
   * not in whatever else happens to be running in the same directory.
   */
  it('binds by Claude session id when the poll reports its claudePid', async () => {
    pidFiles.set(4242, 'cs-abc');
    await call('channel.poll', { cwd: project.path, cursor: 0, claudePid: 4242 });
    expect(bridge.bindingFor('ses_of_cs-abc')).toEqual({
      cwd: project.path,
      projectId: project.projectId,
      claudeSessionId: 'cs-abc',
    });
    expect(bound).toEqual([
      { sessionId: 'ses_of_cs-abc', claudeSessionId: 'cs-abc', projectId: project.projectId },
    ]);
    expect(bridge.boundSessions()).toContain('ses_of_cs-abc');
  });

  it('falls back to the directory index when there is no pid file for that pid', async () => {
    await call('channel.poll', { cwd: project.path, cursor: 0, claudePid: 9999 });
    expect(bound).toEqual([]);
    // The legacy path still binds every known Claude session in the project, which is right for
    // one `claude` per directory and is all an older Claude Code can support.
    expect(bridge.bindingFor('ses_a')?.cwd).toBe(project.path);
    expect(bridge.bindingFor('ses_a')?.claudeSessionId).toBeUndefined();
  });

  it('stops reporting a bound session once its project stops polling', async () => {
    let clock = 1_000_000;
    const ttl = new ChannelBridge(() => clock, 1000);
    ttl.bindSession('ses_x', { cwd: '/p', projectId: 'prj_1', claudeSessionId: 'cs-x' });
    await ttl.poll('/p', 0, 0);
    expect(ttl.boundSessions()).toEqual(['ses_x']);
    clock += 2000;
    expect(ttl.boundSessions()).toEqual([]);
  });

  it('reports a follow-up leaving the queue, so `queued` can become `picked_up`', async () => {
    const b = new ChannelBridge();
    const seen: unknown[] = [];
    const off = b.onPickup((p) => seen.push(p));
    b.enqueue('/p', 'do it', { followupId: 'fu_1', sessionId: 'ses_1', projectId: 'prj_1' });
    expect(seen).toEqual([]); // queued is not picked up
    await b.poll('/p', 0, 0);
    expect(seen).toEqual([
      { cwd: '/p', seq: 1, followupId: 'fu_1', sessionId: 'ses_1', projectId: 'prj_1' },
    ]);
    // A second poll past the cursor hands out nothing, so nothing is reported twice.
    await b.poll('/p', 1, 0);
    expect(seen).toHaveLength(1);
    off();
    b.enqueue('/p', 'again', { followupId: 'fu_2' });
    await b.poll('/p', 1, 0);
    expect(seen).toHaveLength(1);
  });

  it('never leaks local routing to the channel server', async () => {
    const b = new ChannelBridge();
    b.enqueue('/p', 'text', { followupId: 'fu_1', sessionId: 'ses_1', projectId: 'prj_1' });
    const res = await b.poll('/p', 0, 0);
    // `followupId` rides out (it becomes a `<channel followup="…">` attribute); the session and
    // project ids are this Mac's business and stay here.
    expect(res.messages).toEqual([{ seq: 1, text: 'text', followupId: 'fu_1' }]);
  });

  it('emits an agent message on outbound and binds the session', async () => {
    const res = (await call('channel.outbound', { cwd: project.path, text: 'all done' })) as {
      sessionId: string;
    };
    expect(res.sessionId).toBe('ses_minted');
    expect(messages).toEqual([
      { sessionId: 'ses_minted', projectId: project.projectId, text: 'all done' },
    ]);
    expect(bridge.bindingFor('ses_minted')?.cwd).toBe(project.path);
  });

  it('honours an explicit sessionId', async () => {
    await call('channel.outbound', { cwd: project.path, text: 'x', sessionId: 'ses_env' });
    expect(minted).toEqual(['ses_env']);
  });

  it('refuses a cwd outside every registered project', async () => {
    await expect(call('channel.outbound', { cwd: '/elsewhere', text: 'x' })).rejects.toThrow(
      /registered project/,
    );
    await expect(call('channel.poll', { cwd: '/elsewhere' })).rejects.toThrow(/registered project/);
  });

  it('rejects malformed params', async () => {
    await expect(call('channel.outbound', { cwd: project.path })).rejects.toThrow();
    await expect(call('channel.poll', { cursor: -1, cwd: project.path })).rejects.toThrow();
  });
});

describe('daemon flag gate', () => {
  const t = useTempHome('pagr-chan-daemon-');
  const make = (env: NodeJS.ProcessEnv): Promise<Daemon> => {
    const home = join(t.home, `pagr-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(home, { recursive: true });
    return createDaemon({ home, adapters: new Map(), secretStore: new MemorySecretStore(), env });
  };

  it('registers the channel methods by default, and PAGR_CLAUDE_CHANNEL=0 takes them away', async () => {
    const on = await make({});
    expect(on.ipc.methodNames()).toEqual(
      expect.arrayContaining(['channel.poll', 'channel.outbound']),
    );
    // `=1` was the old opt-in and is now a no-op, which matters: a daemon installed with it in
    // its launchd environment must behave exactly like one without.
    const explicit = await make({ PAGR_CLAUDE_CHANNEL: '1' });
    expect(explicit.ipc.methodNames()).toEqual(
      expect.arrayContaining(['channel.poll', 'channel.outbound']),
    );
    const off = await make({ PAGR_CLAUDE_CHANNEL: '0' });
    expect(off.ipc.methodNames()).not.toContain('channel.poll');
    expect(off.channelStatus().enabled).toBe(false);
  });

  /**
   * `adopted` means one specific thing — "Pagr can relay this session's approvals and nothing
   * else" — and the cloud refuses to steer or stop on the strength of it. A channel-attached
   * session is also one the bridge did not spawn, but it IS steerable: that is what the channel
   * is for. Marking it adopted would ship a limit that is not true.
   */
  it('does not mark a channel-attached session adopted, because that one can be steered', async () => {
    const daemon = await make({ PAGR_CLAUDE_CHANNEL: '1' });
    const repo = join(t.home, 'chan-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const project = daemon.registry.add(repo);
    const handler = (
      daemon.ipc as unknown as { methods: Map<string, (p: unknown) => unknown> }
    ).methods.get('channel.outbound');
    if (!handler) throw new Error('channel.outbound not registered');
    const res = (await handler({ cwd: repo, text: 'hello' })) as { sessionId: string };
    const rec = daemon.sessions.get(res.sessionId);
    expect(rec?.projectId).toBe(project.projectId);
    expect(rec?.adopted).toBeUndefined();
  });
});
