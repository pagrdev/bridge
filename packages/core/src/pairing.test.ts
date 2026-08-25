import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { MemorySecretStore } from './keychain.js';
import {
  bodyExcerpt,
  clockSkewMs,
  describeClockSkew,
  describeFetchFailure,
  type FetchFn,
  PairingError,
  type PairingErrorCode,
  type PollProgress,
  pair,
  pollPairing,
  startPairing,
} from './pairing.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const text = (body: string, status = 200, contentType = 'text/html') =>
  new Response(body, { status, headers: { 'content-type': contentType } });

const identity = () => loadOrCreateIdentity(new MemorySecretStore());
const base = async () => ({
  apiUrl: 'https://api.pagr.dev',
  deviceName: 'd',
  identity: await identity(),
  bridgeVersion: '1.2.3',
  sleep: async () => undefined,
});

describe('pairing · happy path', () => {
  const t = useTempHome('pagr-pair-');

  it('posts the public key only, polls until completed, persists config', async () => {
    const id = await identity();
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
      identity: id,
      bridgeVersion: '0.1.0',
      fetch: fetchFn,
      configFile,
      onCode: (r) => codes.push(r.code),
      poll: { sleep: async () => undefined },
    });
    expect(result.deviceId).toBe(deviceId);
    expect(codes).toEqual(['ABCD-1234']);
    const startBody = calls[0]?.body as Record<string, unknown>;
    expect(startBody.publicKey).toBe(id.publicKeyRaw);
    expect(startBody.platform).toBe('darwin');
    expect(startBody.protocolVersion).toBe(1);
    expect(JSON.stringify(startBody)).not.toMatch(/PRIVATE/);
    expect(polls).toBe(3);
    expect(readConfig(configFile)).toMatchObject({
      deviceId,
      userId,
      gatewayUrl: 'wss://gw.pagr.dev/ws',
      serverKeys: { k1: 'AAAA' },
      deviceName: 'Test Mac',
    });
  });

  it('sends replacesDeviceId when re-pairing over an existing device', async () => {
    let body: Record<string, unknown> = {};
    await startPairing({
      ...(await base()),
      replacesDeviceId: 'dev_old',
      fetch: async (_u, init) => {
        body = JSON.parse(String(init?.body));
        return json({ pairingId: 'p', code: 'C', pairUrl: 'https://x.test/p', expiresAt: 'x' });
      },
    });
    expect(body.replacesDeviceId).toBe('dev_old');
  });
});

describe('pairing · every HTTP status maps to a code and a hint', () => {
  const cases: Array<[number, PairingErrorCode, RegExp]> = [
    [404, 'not_found', /no pairing endpoint/],
    [401, 'unauthorized', /rejected the request/],
    [403, 'unauthorized', /rejected the request/],
    [426, 'unsupported', /no longer supported/],
    [410, 'expired', /expired/],
    [409, 'used', /already used/],
    [418, 'http', /HTTP 418/],
  ];
  for (const [status, code, message] of cases) {
    it(`HTTP ${status} → ${code}`, async () => {
      const err = await startPairing({
        ...(await base()),
        retries: 0,
        fetch: async () => json({ error: 'x' }, status),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PairingError);
      const p = err as PairingError;
      expect(p.code).toBe(code);
      expect(p.message).toMatch(message);
      expect(p.hint).toBeTruthy();
      expect(p.status).toBe(status);
    });
  }

  it('5xx is retried, then reported as server_error', async () => {
    let calls = 0;
    const err = await startPairing({
      ...(await base()),
      retries: 2,
      fetch: async () => {
        calls++;
        return json({}, 503);
      },
    }).catch((e: unknown) => e as PairingError);
    expect(calls).toBe(3);
    expect((err as PairingError).code).toBe('server_error');
    expect((err as PairingError).retryable).toBe(true);
  });

  it('a 5xx followed by success is invisible to the caller', async () => {
    let calls = 0;
    const started = await startPairing({
      ...(await base()),
      fetch: async () => {
        calls++;
        return calls === 1
          ? json({}, 500)
          : json({ pairingId: 'p', code: 'C', pairUrl: 'https://x.test/p', expiresAt: 'x' });
      },
    });
    expect(started.code).toBe('C');
    expect(calls).toBe(2);
  });
});

describe('pairing · bodies that are not what we asked for', () => {
  it('an HTML page is named as such, with an excerpt', async () => {
    const err = (await startPairing({
      ...(await base()),
      fetch: async () => text('<!doctype html><html><body>Sign in to the hotel wifi</body></html>'),
    }).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('invalid_response');
    expect(err.message).toMatch(/HTML page, not JSON/);
    expect(err.detail).toContain('hotel wifi');
    expect(err.hint).toMatch(/captive portal/);
  });

  it('detects HTML even when the content-type lies', async () => {
    const err = (await startPairing({
      ...(await base()),
      fetch: async () => text('<html>502</html>', 200, 'application/json'),
    }).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('invalid_response');
    expect(err.message).toMatch(/HTML page/);
  });

  it('truncated JSON is reported as malformed, not as "not paired"', async () => {
    const err = (await startPairing({
      ...(await base()),
      fetch: async () =>
        new Response('{"pairingId":', { headers: { 'content-type': 'application/json' } }),
    }).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('invalid_response');
    expect(err.message).toMatch(/malformed JSON/);
  });

  it('a valid JSON body of the wrong shape names the offending field', async () => {
    const err = (await startPairing({
      ...(await base()),
      fetch: async () => json({ pairingId: 'p', code: 'c', pairUrl: 'not-a-url', expiresAt: 'x' }),
    }).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('invalid_response');
    expect(err.detail).toContain('pairUrl');
  });

  it('body excerpts are one line and length-capped', () => {
    expect(bodyExcerpt('a\n  b\tc')).toBe('a b c');
    expect(bodyExcerpt('x'.repeat(500)).length).toBe(161);
  });
});

describe('pairing · version gates', () => {
  it('refuses an API that requires a newer bridge', async () => {
    const err = (await startPairing({
      ...(await base()),
      fetch: async () =>
        json({
          pairingId: 'p',
          code: 'c',
          pairUrl: 'https://x.test/p',
          expiresAt: 'x',
          minBridgeVersion: '2.0.0',
        }),
    }).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('unsupported');
    expect(err.message).toContain('1.2.3');
    expect(err.message).toContain('2.0.0');
  });

  it('accepts an API whose minimum we already satisfy', async () => {
    const started = await startPairing({
      ...(await base()),
      fetch: async () =>
        json({
          pairingId: 'p',
          code: 'c',
          pairUrl: 'https://x.test/p',
          expiresAt: 'x',
          minBridgeVersion: '1.0.0',
        }),
    });
    expect(started.pairingId).toBe('p');
  });

  it('refuses a mismatched device protocol in both directions', async () => {
    const reply = (protocolVersion: number) =>
      json({
        pairingId: 'p',
        code: 'c',
        pairUrl: 'https://x.test/p',
        expiresAt: 'x',
        protocolVersion,
      });
    const newer = (await startPairing({ ...(await base()), fetch: async () => reply(2) }).catch(
      (e: unknown) => e,
    )) as PairingError;
    expect(newer.code).toBe('unsupported');
    expect(newer.hint).toMatch(/@pagr\/cli@latest/);
    const older = (await startPairing({ ...(await base()), fetch: async () => reply(0) }).catch(
      (e: unknown) => e,
    )) as PairingError;
    expect(older.hint).toMatch(/--api-url/);
  });
});

describe('pairing · polling', () => {
  const poll = (fetchFn: FetchFn, over: Record<string, unknown> = {}) =>
    pollPairing({
      apiUrl: 'https://api.pagr.dev',
      pairingId: 'p',
      fetch: fetchFn,
      sleep: async () => undefined,
      ...over,
    });

  const terminal: Array<[string, PairingErrorCode, RegExp]> = [
    ['expired', 'expired', /expired before it was approved/],
    ['rejected', 'rejected', /declined in the dashboard/],
    ['used', 'used', /already used by another device/],
  ];
  for (const [status, code, message] of terminal) {
    it(`status "${status}" stops immediately with code ${code}`, async () => {
      const err = (await poll(async () => json({ status })).catch(
        (e: unknown) => e,
      )) as PairingError;
      expect(err.code).toBe(code);
      expect(err.message).toMatch(message);
      expect(err.hint).toMatch(/pagr connect/);
    });
  }

  it('times out instead of polling forever', async () => {
    let now = 0;
    const err = (await poll(async () => json({ status: 'pending' }), {
      sleep: async () => {
        now += 1000;
      },
      now: () => now,
      timeoutMs: 2500,
    }).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('timeout');
    expect(err.message).toMatch(/nobody approved/);
  });

  it('survives a run of transient failures and still completes', async () => {
    let n = 0;
    const done = await poll(async () => {
      n++;
      if (n <= 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return json({
        status: 'completed',
        deviceId: ids.dev(),
        userId: ids.usr(),
        gatewayUrl: 'wss://gw.test/ws',
        serverKeys: {},
      });
    });
    expect(done.status).toBe('completed');
  });

  it('gives up after too many consecutive transient failures', async () => {
    const err = (await poll(
      async () => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      },
      { maxTransientFailures: 2 },
    ).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/lost contact with the API/);
  });

  it('reports progress, including the transient error being retried', async () => {
    let n = 0;
    const seen: string[] = [];
    await poll(
      async () => {
        n++;
        if (n === 1) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
        if (n === 2) return json({ status: 'pending' });
        return json({
          status: 'completed',
          deviceId: ids.dev(),
          userId: ids.usr(),
          gatewayUrl: 'wss://gw.test/ws',
          serverKeys: {},
        });
      },
      {
        onProgress: (p: PollProgress) => seen.push(p.transientError ? 'transient' : 'pending'),
      },
    );
    expect(seen).toEqual(['transient', 'pending']);
  });

  it('aborts promptly when the signal fires (Ctrl-C)', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = (await poll(async () => json({ status: 'pending' }), { signal: ac.signal }).catch(
      (e: unknown) => e,
    )) as PairingError;
    expect(err.message).toBe('pairing canceled');
  });

  it('a status this CLI does not know asks for an update rather than looping', async () => {
    const err = (await poll(async () => json({ status: 'needs_mfa' })).catch(
      (e: unknown) => e,
    )) as PairingError;
    expect(err.code).toBe('unsupported');
    expect(err.message).toContain('needs_mfa');
  });

  it('a completed payload with a malformed device id is rejected', async () => {
    const err = (await poll(async () =>
      json({
        status: 'completed',
        deviceId: 'nope',
        userId: ids.usr(),
        gatewayUrl: 'wss://g.test',
        serverKeys: {},
      }),
    ).catch((e: unknown) => e)) as PairingError;
    expect(err.code).toBe('invalid_response');
  });
});

describe('pairing · network failures speak plain language', () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ['ENOTFOUND', /cannot resolve/, /DNS/],
    ['ECONNREFUSED', /refused the connection/, /API URL/],
    ['ETIMEDOUT', /did not respond/, /443/],
    ['CERT_HAS_EXPIRED', /certificate .* has expired/, /clock/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /could not verify the TLS certificate/, /proxy/],
  ];
  for (const [code, message, hint] of cases) {
    it(code, () => {
      const wrapped = new TypeError('fetch failed');
      (wrapped as { cause?: unknown }).cause = Object.assign(new Error('x'), { code });
      const err = describeFetchFailure('https://api.pagr.dev/v1/x', wrapped, 15_000);
      expect(err.code).toBe('network');
      expect(err.message).toMatch(message);
      expect(err.hint).toMatch(hint);
    });
  }

  it('an abort becomes a timeout message naming the budget', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const err = describeFetchFailure('https://api.pagr.dev/v1/x', abort, 250);
    expect(err.message).toContain('did not respond within 250ms');
  });

  it('an unknown failure still produces a network error with a hint', () => {
    const err = describeFetchFailure('https://api.pagr.dev/v1/x', new Error('weird'), 1000);
    expect(err.code).toBe('network');
    expect(err.hint).toMatch(/PAGR_API_URL/);
  });
});

describe('pairing · clock skew', () => {
  it('measures skew from the Date header and reports it to the caller', async () => {
    const serverNow = Date.parse('2026-08-25T12:00:00.000Z');
    const localNow = serverNow + 5 * 60_000;
    let seen: number | null = null;
    await startPairing({
      ...(await base()),
      now: () => localNow,
      onClockSkew: (s) => {
        seen = s;
      },
      fetch: async () =>
        json({ pairingId: 'p', code: 'c', pairUrl: 'https://x.test/p', expiresAt: 'x' }, 200, {
          date: new Date(serverNow).toUTCString(),
        }),
    });
    expect(seen).not.toBeNull();
    expect(Math.abs((seen as unknown as number) - 5 * 60_000)).toBeLessThan(1000);
  });

  it('no Date header means no claim about the clock', () => {
    expect(clockSkewMs(new Response('{}'), Date.now())).toBeNull();
    expect(
      clockSkewMs(new Response('{}', { headers: { date: 'garbage' } }), Date.now()),
    ).toBeNull();
  });

  it('describes skew in units a human reads', () => {
    expect(describeClockSkew(90_000)).toBe('2m ahead of');
    expect(describeClockSkew(-5000)).toBe('5s behind');
    expect(describeClockSkew(7200_000)).toBe('2h ahead of');
  });
});
