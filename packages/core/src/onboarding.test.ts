import { describe, expect, it } from 'vitest';
import type { FetchFn } from './pairing.js';
import {
  type OnboardingFacts,
  pollOnboarding,
  readOnboarding,
  readProductNumber,
} from './pairing.js';
import { LINK_PHONE_BODY, linkPhoneSms, smsLink } from './sms.js';
import { ids } from './testFixtures.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const facts = (over: Partial<OnboardingFacts> = {}) => ({
  entitled: false,
  messagingLinked: false,
  hasProject: false,
  claudeConnected: false,
  codexConnected: false,
  ...over,
});

const completed = (over: Record<string, unknown> = {}) => ({
  status: 'completed',
  deviceId: ids.dev(),
  userId: ids.usr(),
  gatewayUrl: 'wss://gw.example/ws',
  serverKeys: { k1: 'AAAA' },
  ...over,
});

/** A fetch that replays a script of bodies, repeating the last one. */
function scripted(bodies: unknown[]): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return json(body);
    },
  };
}

const base = (fetchFn: FetchFn) => ({
  apiUrl: 'https://api.pagr.dev',
  pairingId: 'pr_1',
  fetch: fetchFn,
  sleep: async () => undefined,
});

describe('sms deep links', () => {
  it('uses the `?&body=` form both iOS and Android parse', () => {
    expect(smsLink('+15550101234', 'Hi Pagr')).toBe('sms:+15550101234?&body=Hi%20Pagr');
    expect(linkPhoneSms('+15550101234')).toBe(smsLink('+15550101234', LINK_PHONE_BODY));
  });

  it('escapes a body that would otherwise end the query', () => {
    expect(smsLink('+15550101234', 'a&b=c d')).toBe('sms:+15550101234?&body=a%26b%3Dc%20d');
  });
});

describe('readOnboarding', () => {
  it('reads the facts and the number off a completed pairing', async () => {
    const { fetch, calls } = scripted([
      completed({ onboarding: facts({ messagingLinked: true }), productNumber: '+15550101234' }),
    ]);
    const got = await readOnboarding(base(fetch));
    expect(got.onboarding).toMatchObject({ messagingLinked: true, entitled: false });
    expect(got.productNumber).toBe('+15550101234');
    expect(calls[0]).toBe('https://api.pagr.dev/v1/devices/pair/status/pr_1');
  });

  it('reports "unknown", not "none", when the api is older than this CLI', async () => {
    const { fetch } = scripted([completed()]);
    expect(await readOnboarding(base(fetch))).toEqual({ onboarding: null, productNumber: null });
  });

  it('ignores fields it does not know and defaults ones it does not get', async () => {
    const { fetch } = scripted([
      completed({
        onboarding: { messagingLinked: true, entitled: 'yes', somethingNew: { a: 1 } },
        productNumber: null,
      }),
    ]);
    const got = await readOnboarding(base(fetch));
    // a wrong type and a missing field both read as "not done"; the unknown key is dropped
    expect(got.onboarding).toEqual({
      entitled: false,
      messagingLinked: true,
      hasProject: false,
      claudeConnected: false,
      codexConnected: false,
    });
  });

  it('a pairing that is still pending carries no facts', async () => {
    const { fetch } = scripted([{ status: 'pending' }]);
    expect((await readOnboarding(base(fetch))).onboarding).toBeNull();
  });
});

describe('readProductNumber', () => {
  it('reads GET /v1/messaging/line', async () => {
    const calls: string[] = [];
    const number = await readProductNumber({
      apiUrl: 'https://api.pagr.dev/',
      fetch: async (url) => {
        calls.push(url);
        return json({ productNumber: '+15550101234' });
      },
    });
    expect(number).toBe('+15550101234');
    expect(calls[0]).toBe('https://api.pagr.dev/v1/messaging/line');
  });

  it('is null on a deployment with no published line', async () => {
    expect(
      await readProductNumber({
        apiUrl: 'https://api.pagr.dev',
        fetch: async () => json({ productNumber: null }),
      }),
    ).toBeNull();
  });
});

describe('pollOnboarding', () => {
  it('stops as soon as the fact it waits for is true', async () => {
    const { fetch, calls } = scripted([
      completed({ onboarding: facts(), productNumber: '+1555' }),
      completed({ onboarding: facts(), productNumber: '+1555' }),
      completed({ onboarding: facts({ messagingLinked: true }), productNumber: '+1555' }),
    ]);
    const got = await pollOnboarding({ ...base(fetch), until: (f) => f.messagingLinked });
    expect(got.outcome).toBe('satisfied');
    expect(got.onboarding?.messagingLinked).toBe(true);
    expect(got.productNumber).toBe('+1555');
    expect(calls).toHaveLength(3);
  });

  it('gives up politely at the deadline instead of waiting forever', async () => {
    let now = 0;
    const { fetch } = scripted([completed({ onboarding: facts() })]);
    const got = await pollOnboarding({
      ...base(fetch),
      until: (f) => f.messagingLinked,
      timeoutMs: 10_000,
      intervalMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(got.outcome).toBe('timeout');
    expect(got.onboarding).toMatchObject({ messagingLinked: false });
  });

  it('does not keep asking an api that will never answer with onboarding', async () => {
    const { fetch, calls } = scripted([completed()]);
    const got = await pollOnboarding({ ...base(fetch), until: (f) => f.messagingLinked });
    expect(got.outcome).toBe('unsupported');
    expect(calls).toHaveLength(1);
  });

  it('rides out a network wobble and keeps waiting', async () => {
    let i = 0;
    const got = await pollOnboarding({
      ...base(async () => {
        i++;
        if (i <= 2) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
        return json(completed({ onboarding: facts({ messagingLinked: true }) }));
      }),
      until: (f) => f.messagingLinked,
    });
    expect(got.outcome).toBe('satisfied');
  });

  it('reports, never throws, when the api stays unreachable', async () => {
    const got = await pollOnboarding({
      ...base(async () => {
        throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
      }),
      until: (f) => f.messagingLinked,
      maxTransientFailures: 1,
    });
    expect(got.outcome).toBe('error');
    expect(got.error?.code).toBe('network');
    expect(got.onboarding).toBeNull();
  });

  it('a 500 is an outcome too, not an exception out of `pagr connect`', async () => {
    const got = await pollOnboarding({
      ...base(async () => json({ error: 'boom' }, 500)),
      until: (f) => f.messagingLinked,
      maxTransientFailures: 0,
    });
    expect(got.outcome).toBe('error');
    expect(got.error?.code).toBe('server_error');
  });

  it('Ctrl-C ends the wait without ending the install', async () => {
    const controller = new AbortController();
    const { fetch } = scripted([completed({ onboarding: facts(), productNumber: '+1555' })]);
    const got = await pollOnboarding({
      ...base(fetch),
      until: (f) => f.messagingLinked,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    expect(got.outcome).toBe('canceled');
    // whatever it learned before the interrupt is still reported
    expect(got.productNumber).toBe('+1555');
  });
});
