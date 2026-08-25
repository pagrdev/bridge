import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { MemorySecretStore } from './keychain.js';
import { type FetchFn, pair, pollPairing, startPairing } from './pairing.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('pairing', () => {
  const t = useTempHome('pagr-pair-');

  it('posts the public key only, polls until completed, persists config', async () => {
    const identity = await loadOrCreateIdentity(new MemorySecretStore());
    const deviceId = ids.dev();
    const userId = ids.usr();
    const calls: { url: string; body?: unknown }[] = [];
    let polls = 0;
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/v1/devices/pair/start'))
        return json({
          pairingId: 'pr_1',
          code: 'ABCD-1234',
          pairUrl: 'https://app.pagr.dev/pair?code=ABCD-1234',
          expiresAt: 'x',
        });
      if (url.endsWith('/v1/devices/pair/status/pr_1')) {
        polls++;
        if (polls < 3) return json({ status: 'pending' });
        return json({
          status: 'completed',
          deviceId,
          userId,
          gatewayUrl: 'wss://gw.pagr.dev/ws',
          serverKeys: { k1: 'AAAA' },
        });
      }
      return json({}, 404);
    };
    const configFile = join(t.home, 'config.json');
    const codes: string[] = [];
    const result = await pair({
      apiUrl: 'https://api.pagr.dev/',
      deviceName: 'Test Mac',
      identity,
      bridgeVersion: '0.1.0',
      fetch: fetchFn,
      configFile,
      onCode: (r) => codes.push(r.code),
      poll: { sleep: async () => undefined },
    });
    expect(result.deviceId).toBe(deviceId);
    expect(codes).toEqual(['ABCD-1234']);
    const startBody = calls[0]?.body as Record<string, unknown>;
    expect(startBody.publicKey).toBe(identity.publicKeyRaw);
    expect(startBody.platform).toBe('darwin');
    expect(JSON.stringify(startBody)).not.toMatch(/PRIVATE/);
    expect(polls).toBe(3);
    const cfg = readConfig(configFile);
    expect(cfg).toMatchObject({
      deviceId,
      userId,
      gatewayUrl: 'wss://gw.pagr.dev/ws',
      serverKeys: { k1: 'AAAA' },
      deviceName: 'Test Mac',
    });
  });

  it('surfaces http, invalid response, expired, rejected, timeout', async () => {
    const identity = await loadOrCreateIdentity(new MemorySecretStore());
    const base = { apiUrl: 'https://api', deviceName: 'd', identity, bridgeVersion: '0.1.0' };
    await expect(startPairing({ ...base, fetch: async () => json({}, 500) })).rejects.toMatchObject(
      { code: 'http' },
    );
    await expect(
      startPairing({ ...base, fetch: async () => json({ nope: 1 }) }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    const poll = (status: string) =>
      pollPairing({
        apiUrl: 'https://api',
        pairingId: 'p',
        fetch: async () => json({ status }),
        sleep: async () => undefined,
      });
    await expect(poll('expired')).rejects.toMatchObject({ code: 'expired' });
    await expect(poll('rejected')).rejects.toMatchObject({ code: 'rejected' });
    let now = 0;
    await expect(
      pollPairing({
        apiUrl: 'https://api',
        pairingId: 'p',
        fetch: async () => json({ status: 'pending' }),
        sleep: async () => {
          now += 1000;
        },
        now: () => now,
        timeoutMs: 2500,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
