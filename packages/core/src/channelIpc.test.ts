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
    expect(b.attachedProjects().sort()).toEqual(['/a', '/b']);
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

  beforeEach(() => {
    ipc = new IpcServer({ socketPath: '/unused.sock' });
    bridge = new ChannelBridge();
    messages = [];
    minted = [];
    registerChannelMethods(ipc, {
      bridge,
      pollTimeoutMs: 5,
      resolveProject: (cwd) => (cwd.startsWith(project.path) ? project : null),
      claudeSessionsIn: () => ['ses_a', 'ses_b'],
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

  it('registers the channel methods only under PAGR_CLAUDE_CHANNEL=1', async () => {
    const off = await make({});
    expect(off.ipc.methodNames()).not.toContain('channel.poll');
    const on = await make({ PAGR_CLAUDE_CHANNEL: '1' });
    expect(on.ipc.methodNames()).toEqual(
      expect.arrayContaining(['channel.poll', 'channel.outbound']),
    );
  });
});
