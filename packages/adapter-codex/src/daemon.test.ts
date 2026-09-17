import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from './adapter.js';
import { AppServerClient } from './app-server.js';
import {
  codexHomeDir,
  controlSocketPath,
  controlSocketPresent,
  daemonDoctorLine,
  probeDaemon,
  versionFromUserAgent,
} from './daemon.js';
import { FileLogger } from './logger.js';

/**
 * Attaching to the shared daemon, and falling back when there is none.
 *
 * Nothing here goes near the real `~/.codex`: every socket is a fake app-server this test started
 * under a temp directory, and no test runs `codex app-server daemon start` — the bridge never does
 * either, which is itself asserted below.
 */

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-app-server.mjs', import.meta.url));
const PROJ = 'proj_0000000000000000000000000000000a';

/** Short path: macOS refuses a Unix socket path over `SUN_LEN` (104 bytes). */
function shortTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-'));
}

interface FakeDaemon {
  socketPath: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

async function startFakeDaemon(env: NodeJS.ProcessEnv = {}): Promise<FakeDaemon> {
  const dir = shortTmp();
  const socketPath = path.join(dir, 'd.sock');
  const child = spawn('node', [FIXTURE, 'app-server'], {
    env: { ...process.env, ...env, FAKE_CODEX_SOCK: socketPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake daemon did not listen')), 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (chunk.includes('listening')) {
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
    child,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 30));
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('discovery', () => {
  it('prefers CODEX_HOME and otherwise looks in $HOME/.codex', () => {
    expect(codexHomeDir({ CODEX_HOME: '/tmp/elsewhere', HOME: '/Users/x' })).toBe('/tmp/elsewhere');
    expect(codexHomeDir({ HOME: '/Users/x' })).toBe('/Users/x/.codex');
  });

  it('knows the control socket path the daemon listens on', () => {
    expect(controlSocketPath('/Users/x/.codex')).toBe(
      '/Users/x/.codex/app-server-control/app-server-control.sock',
    );
  });

  it('does not mistake a regular file for a listening socket', () => {
    const dir = shortTmp();
    const file = path.join(dir, 'not-a-socket');
    fs.writeFileSync(file, '');
    try {
      expect(controlSocketPresent(file)).toBe(false);
      expect(controlSocketPresent(path.join(dir, 'missing.sock'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the version out of the initialize user agent', () => {
    expect(versionFromUserAgent('codex-cli 0.149.1 (Mac OS 26.6.2; arm64)')).toBe('0.149.1');
    expect(versionFromUserAgent('nothing here')).toBeUndefined();
  });
});

describe('probeDaemon', () => {
  it('attaches to a live control socket and reads its version and home back', async () => {
    const daemon = await startFakeDaemon();
    try {
      const p = await probeDaemon({ socketPath: daemon.socketPath });
      expect(p.attached).toBe(true);
      expect(p.version).toBe('0.149.1');
      expect(p.codexHome).toBe('/tmp/fake-codex');
      expect(daemonDoctorLine(p)).toMatchObject({
        name: 'codex daemon',
        status: 'ok',
        detail: 'attached (0.149.1)',
      });
    } finally {
      await daemon.stop();
    }
  });

  it('reports "not running" — with the start hint — when there is no socket', async () => {
    const dir = shortTmp();
    try {
      const p = await probeDaemon({ socketPath: path.join(dir, 'nope.sock') });
      expect(p).toMatchObject({ attached: false, reason: 'absent' });
      const line = daemonDoctorLine(p);
      expect(line.status).toBe('warn');
      expect(line.detail).toContain('not running');
      expect(line.detail).toContain('codex app-server daemon start');
      expect(line.detail).toContain('installer-managed builds only');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the embedded fallback when a socket is there but never answers', async () => {
    const dir = shortTmp();
    const socketPath = path.join(dir, 'dead.sock');
    // Accepts the connection and then says nothing: no WebSocket upgrade, ever.
    const server = net.createServer(() => {});
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      const p = await probeDaemon({ socketPath, timeoutMs: 300 });
      expect(p.attached).toBe(false);
      expect(p.reason).toBe('probe_failed');
      const line = daemonDoctorLine(p);
      expect(line.status).toBe('warn');
      expect(line.detail).toContain('embedded fallback');
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('AppServerClient over the control socket', () => {
  let daemon: FakeDaemon;
  beforeEach(async () => {
    daemon = await startFakeDaemon();
  });
  afterEach(async () => {
    await daemon.stop();
  });

  it('speaks one JSON-RPC message per text frame and survives the server pings', async () => {
    const client = new AppServerClient({
      transport: { kind: 'daemon', socketPath: daemon.socketPath },
      clientVersion: '0.1.0',
      logger: new FileLogger(null),
      experimentalApi: true,
    });
    try {
      const res = await client.start();
      expect(res.userAgent).toContain('fake-app-server');
      expect(client.mode).toBe('app-server-daemon');
      // The fixture pings every 200 ms; a request that still works after several of them proves
      // the pongs are going back (the real server drops a client that does not answer).
      await new Promise((r) => setTimeout(r, 700));
      const started = await client.request<{ thread: { id: string } }>('thread/start', {
        cwd: '/tmp/p',
      });
      expect(started.thread.id).toMatch(/^thr_/);
    } finally {
      await client.stop();
    }
  }, 20_000);

  it('rejects rather than hanging when the socket is not there at all', async () => {
    const client = new AppServerClient({
      transport: { kind: 'daemon', socketPath: '/tmp/pagr-no-such.sock' },
      clientVersion: '0.1.0',
      logger: new FileLogger(null),
    });
    await expect(client.start()).rejects.toThrow(/codex daemon socket/);
    await client.stop();
  });
});

describe('CodexAdapter attach vs embedded fallback', () => {
  let home: string;
  let project: string;
  const adapters: CodexAdapter[] = [];

  beforeEach(() => {
    home = shortTmp();
    project = shortTmp();
  });
  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.shutdown();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const make = (opts: Record<string, unknown>): CodexAdapter => {
    const a = new CodexAdapter({
      home,
      codexCommand: ['node', FIXTURE],
      log: false,
      frames: false,
      mirror: false,
      ...opts,
    } as ConstructorParameters<typeof CodexAdapter>[0]);
    adapters.push(a);
    return a;
  };

  it('drives a session over the daemon socket without spawning an app-server of its own', async () => {
    const daemon = await startFakeDaemon();
    const trace = path.join(home, 'trace.txt');
    try {
      const a = make({ controlSocketPath: daemon.socketPath, env: { FAKE_CODEX_TRACE: trace } });
      const s = await a.startSession({
        sessionId: 'ses_00000000000000000000000000000009',
        project: { projectId: PROJ, path: project, displayName: 'demo' },
        instruction: 'hello',
        localImagePaths: [],
        readOnly: false,
      });
      expect(s.status).toBe('working');
      expect((await a.probe()).mode).toBe('app-server-daemon');
      // The trace file records every fake `codex` invocation. Attaching means the only one was
      // the `--version` probe: no app-server child of our own, and above all no `daemon start`.
      const argv = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
      expect(argv).not.toContain('app-server');
      expect(argv).not.toContain('daemon start');
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  it('spawns its own app-server when the control socket is absent', async () => {
    const trace = path.join(home, 'trace.txt');
    const a = make({
      controlSocketPath: path.join(home, 'missing.sock'),
      env: { FAKE_CODEX_TRACE: trace },
    });
    await a.startSession({
      sessionId: 'ses_00000000000000000000000000000008',
      project: { projectId: PROJ, path: project, displayName: 'demo' },
      instruction: 'hello',
      localImagePaths: [],
      readOnly: false,
    });
    expect((await a.probe()).mode).toBe('app-server-embedded');
    const argv = fs.readFileSync(trace, 'utf8');
    expect(argv).toContain('app-server');
    // The daemon is never started for us: that command only works for installer-managed builds.
    expect(argv).not.toContain('daemon start');
  }, 30_000);

  it('falls back to its own app-server when the socket is there but does not answer', async () => {
    const dir = shortTmp();
    const socketPath = path.join(dir, 'dead.sock');
    const server = net.createServer(() => {});
    await new Promise<void>((r) => server.listen(socketPath, r));
    const trace = path.join(home, 'trace.txt');
    try {
      const a = make({
        controlSocketPath: socketPath,
        daemonProbeTimeoutMs: 300,
        env: { FAKE_CODEX_TRACE: trace },
      });
      await a.startSession({
        sessionId: 'ses_00000000000000000000000000000007',
        project: { projectId: PROJ, path: project, displayName: 'demo' },
        instruction: 'hello',
        localImagePaths: [],
        readOnly: false,
      });
      expect((await a.probe()).mode).toBe('app-server-embedded');
      expect(fs.readFileSync(trace, 'utf8')).toContain('app-server');
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('never looks for a daemon when the operator named a different codex', async () => {
    const daemon = await startFakeDaemon();
    try {
      // `codexCommand` says WHICH Codex this bridge drives; the machine's daemon is a different
      // installation, so it is left alone unless a socket path is named explicitly.
      const a = new CodexAdapter({
        home,
        codexCommand: ['node', FIXTURE],
        codexHome: path.dirname(path.dirname(daemon.socketPath)),
        log: false,
        frames: false,
      });
      adapters.push(a);
      await a.startSession({
        sessionId: 'ses_00000000000000000000000000000006',
        project: { projectId: PROJ, path: project, displayName: 'demo' },
        instruction: 'hello',
        localImagePaths: [],
        readOnly: false,
      });
      expect((await a.probe()).mode).toBe('app-server-embedded');
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
