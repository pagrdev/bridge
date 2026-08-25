import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpcClient, IpcMethodError, IpcServer } from './ipc.js';
import { ensurePaths } from './paths.js';
import { useTempHome } from './testUtil.js';

describe('ipc', () => {
  const t = useTempHome('pagr-ipc-');
  let server: IpcServer;
  let socketPath: string;
  beforeEach(async () => {
    socketPath = ensurePaths(join(t.home, 'p')).socketPath;
    server = new IpcServer({ socketPath });
    server.registerMethod('echo', (p) => p);
    server.registerMethod('boom', () => {
      throw new IpcMethodError('nope', 'refused');
    });
    server.registerMethod('slow', () => new Promise((r) => setTimeout(() => r('late'), 200)));
    await server.listen();
  });
  afterEach(async () => server.close());

  it('creates a 0600 socket owned by us and answers requests', async () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const c = new IpcClient(socketPath);
    expect(await c.call('echo', { a: 1 })).toEqual({ a: 1 });
    await expect(c.call('boom')).rejects.toMatchObject({ code: 'nope', message: 'refused' });
    await expect(c.call('missing')).rejects.toMatchObject({ code: 'unknown_method' });
    await expect(c.call('slow', undefined, 50)).rejects.toMatchObject({ code: 'timeout' });
    expect(await c.call('slow', undefined, 1000)).toBe('late');
  });

  it('unlinks a stale socket on restart and refuses a non-socket file', async () => {
    await server.close();
    writeFileSync(socketPath, 'not a socket');
    await expect(server.listen()).rejects.toThrow(/not a socket/);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(socketPath);
    await server.listen();
    await server.close();
    await server.listen(); // second listen after clean close works
    expect(await new IpcClient(socketPath).call('echo', 1)).toBe(1);
  });

  it('refuses a socket path longer than the sun_path limit with a clear error (item 14)', async () => {
    await server.close();
    const long = new IpcServer({ socketPath: join(t.home, 'z'.repeat(110), 'daemon.sock') });
    await expect(long.listen()).rejects.toThrow(/too long/);
    await server.listen();
  });
});
