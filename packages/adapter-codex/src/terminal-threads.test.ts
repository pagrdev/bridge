import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter, MIRROR_READ_ONLY } from './adapter.js';
import { AppServerClient } from './app-server.js';
import { FileLogger } from './logger.js';

/**
 * Terminal threads, end to end against a fake shared daemon on a Unix socket.
 *
 * The daemon is a fixture process this file starts and kills; the real `~/.codex` is never read
 * and no `codex app-server daemon start` is ever run. The second `AppServerClient` in these tests
 * plays the part of the TUI: the thread's owner, the one whose answers win.
 */

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));
const PROJ = 'proj_0000000000000000000000000000000a';

const shortTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));

interface FakeDaemon {
  socketPath: string;
  rpcLog: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

async function startFakeDaemon(env: NodeJS.ProcessEnv = {}): Promise<FakeDaemon> {
  const dir = shortTmp();
  const socketPath = path.join(dir, 'd.sock');
  const rpcLog = path.join(dir, 'rpc.log');
  const child = spawn('node', [FIXTURE, 'app-server'], {
    env: { ...process.env, ...env, FAKE_CODEX_SOCK: socketPath, FAKE_CODEX_RPC_LOG: rpcLog },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake daemon did not listen')), 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      if (c.includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake daemon exited early (${code})`));
    });
  });
  return {
    socketPath,
    rpcLog,
    child,
    stop: async () => {
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function rpcCalls(file: string): Array<{ method: string; params: Record<string, unknown> }> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
}

function collector() {
  const events: AdapterEvent[] = [];
  const waiters: Array<{ pred: (e: AdapterEvent) => boolean; resolve: () => void }> = [];
  const emit = (e: AdapterEvent) => {
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  const waitFor = (pred: (e: AdapterEvent) => boolean, ms = 10_000): Promise<AdapterEvent> =>
    new Promise((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('timeout waiting for an event')), ms);
      waiters.push({
        pred,
        resolve: () => {
          clearTimeout(t);
          const found = events.find(pred);
          if (found) resolve(found);
          else reject(new Error('predicate matched but the event vanished'));
        },
      });
    });
  return { events, emit, waitFor };
}

async function waitUntil(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for a condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A second subscriber on the same daemon: the terminal that owns the thread. */
async function owner(socketPath: string): Promise<AppServerClient> {
  const client = new AppServerClient({
    transport: { kind: 'daemon', socketPath },
    clientVersion: '0.1.0',
    logger: new FileLogger(null),
    experimentalApi: true,
  });
  await client.start();
  return client;
}

describe('mirroring terminal threads', () => {
  let home: string;
  let project: string;
  let daemon: FakeDaemon | null = null;
  const adapters: CodexAdapter[] = [];
  const clients: AppServerClient[] = [];

  beforeEach(() => {
    home = shortTmp();
    project = shortTmp();
  });
  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.shutdown();
    for (const c of clients.splice(0)) await c.stop();
    await daemon?.stop();
    daemon = null;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function make(
    socketPath: string,
    opts: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {},
  ): {
    adapter: CodexAdapter;
    events: AdapterEvent[];
    waitFor: ReturnType<typeof collector>['waitFor'];
  } {
    const c = collector();
    const adapter = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      controlSocketPath: socketPath,
      approvalTimeoutMs: 5000,
      log: false,
      resolveProject: (cwd) => (cwd === project ? { projectId: PROJ, projectPath: project } : null),
      ...opts,
    });
    adapter.subscribe(c.emit);
    adapters.push(adapter);
    return { adapter, events: c.events, waitFor: c.waitFor };
  }

  it('adopts a daemon-hosted thread as a mirror_only terminal session', async () => {
    daemon = await startFakeDaemon({ FAKE_CODEX_DAEMON_THREADS: `tui-1=${project}` });
    const { adapter, events } = make(daemon.socketPath);
    await adapter.probe();
    await adapter.discoverTerminalThreads();
    await waitUntil(() => events.some((e) => e.kind === 'session'));
    const session = events.find((e) => e.kind === 'session');
    expect(session?.kind === 'session' && session.session).toMatchObject({
      provider: 'codex',
      projectId: PROJ,
      controlLevel: 'mirror_only',
      origin: 'terminal',
      projectStatus: 'registered',
    });
    // Subscribing is how a mirror gets the live stream.
    expect(rpcCalls(daemon.rpcLog).map((c) => c.method)).toContain('thread/resume');
  }, 30_000);

  it('keeps a thread in an unregistered directory local: known here, never described to the cloud', async () => {
    daemon = await startFakeDaemon({ FAKE_CODEX_DAEMON_THREADS: 'tui-1=/tmp/somewhere-else' });
    const { adapter, events } = make(daemon.socketPath);
    const threads = await adapter.discoverTerminalThreads();
    expect(threads.map((t) => t.threadId)).toContain('tui-1');
    expect(events.filter((e) => e.kind === 'session')).toEqual([]);
    // `device.hello` copies this list; a session with no `proj_…` id cannot go in it.
    expect(await adapter.listSessions()).toEqual([]);
  }, 30_000);

  it('polls a writer-locked thread read-only instead of resuming it', async () => {
    daemon = await startFakeDaemon({ FAKE_CODEX_TUI_THREADS: `foreign-1=${project}` });
    const { adapter, events } = make(daemon.socketPath, { readPollIntervalMs: 50 });
    await adapter.discoverTerminalThreads();
    await waitUntil(() => events.some((e) => e.kind === 'frame'), 8000);
    const frames = events.filter((e) => e.kind === 'frame');
    expect(frames.map((f) => (f.kind === 'frame' ? f.body.kind : ''))).toEqual([
      'user',
      'assistant',
    ]);
    // Read, not resumed: `thread/read` works under a foreign lock, `thread/resume` never would.
    const methods = rpcCalls(daemon.rpcLog).map((c) => c.method);
    expect(methods).toContain('thread/read');
    // And the same read, repeated, does not produce the same frames twice.
    const before = frames.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(events.filter((e) => e.kind === 'frame')).toHaveLength(before);
  }, 30_000);

  it('never answers a server request for a thread it does not own', async () => {
    daemon = await startFakeDaemon();
    const { adapter, events } = make(daemon.socketPath, { mirror: false });
    await adapter.probe();
    // Force the link up without giving the adapter a session of its own.
    await adapter.discoverTerminalThreads();
    const tui = await owner(daemon.socketPath);
    clients.push(tui);
    const started = await tui.request<{ thread: { id: string } }>('thread/start', { cwd: project });
    await tui.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'approve this', text_elements: [] }],
    });
    // The request is broadcast to every subscriber, with one id. Ours must stay silent.
    await new Promise((r) => setTimeout(r, 400));
    expect(events.filter((e) => e.kind === 'approval_requested')).toEqual([]);
    const answers = rpcCalls(daemon.rpcLog).filter((c) => c.method === '<response>');
    expect(answers.filter((a) => Number(a.params.id) >= 1000)).toEqual([]);
  }, 30_000);

  it('relays a mirrored approval, writes nothing, and withdraws it when the owner answers', async () => {
    daemon = await startFakeDaemon();
    const { adapter, events, waitFor } = make(daemon.socketPath, { discoveryIntervalMs: 60_000 });
    const tui = await owner(daemon.socketPath);
    clients.push(tui);
    const started = await tui.request<{ thread: { id: string } }>('thread/start', { cwd: project });
    await adapter.discoverTerminalThreads();
    await waitUntil(() => events.some((e) => e.kind === 'session'));

    // What the terminal itself is shown — the same request, with the same id.
    const ownerRequest = new Promise<{ id: number | string }>((resolve) => {
      tui.once('request', (r) => resolve(r));
    });
    await tui.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'approve this', text_elements: [] }],
    });
    const asked = await waitFor((e) => e.kind === 'approval_requested');
    expect(asked.kind === 'approval_requested' && asked.source).toBe('mirror');
    expect(asked.kind === 'approval_requested' && asked.options?.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_session',
      'reject_once',
    ]);
    // Nothing has been written: the person at the terminal is the one being asked.
    expect(
      rpcCalls(daemon.rpcLog).filter(
        (c) => c.method === '<response>' && Number(c.params.id) >= 1000,
      ),
    ).toEqual([]);

    // The owner answers in their terminal. Our card is withdrawn, not errored.
    const request = await ownerRequest;
    tui.respond(request.id, { decision: 'decline' });
    const resolved = await waitFor((e) => e.kind === 'approval_resolved_locally');
    expect(resolved.kind === 'approval_resolved_locally' && resolved.answeredElsewhere).toBe(true);
  }, 30_000);

  it('refuses to steer or stop a thread it only mirrors', async () => {
    daemon = await startFakeDaemon({ FAKE_CODEX_DAEMON_THREADS: `tui-1=${project}` });
    const { adapter, events } = make(daemon.socketPath);
    await adapter.discoverTerminalThreads();
    await waitUntil(() => events.some((e) => e.kind === 'session'));
    const s = events.find((e) => e.kind === 'session');
    const sessionId = s?.kind === 'session' ? s.session.sessionId : '';
    await expect(
      adapter.sendInstruction({
        sessionId,
        instruction: 'do it',
        mode: 'auto',
        localImagePaths: [],
      }),
    ).rejects.toThrow(MIRROR_READ_ONLY);
    await expect(adapter.stopSession(sessionId)).rejects.toThrow(MIRROR_READ_ONLY);
  }, 30_000);
});
