import { writeFileSync } from 'node:fs';
import { getPaths } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import {
  DEV_ID,
  FakeApi,
  type OnboardingOver,
  PRODUCT_NUMBER,
  type Reply,
  statusCompleted,
  statusCompletedWithOnboarding,
  USER_ID,
} from './fakeApi.js';
import { type Harness, harness, lastJson, plain } from './helpers.js';

let h: Harness;
let api: FakeApi | null = null;

beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await api?.close();
  api = null;
  h.cleanup();
});

/** A paired Mac, optionally one that predates `connect` recording the pairing id. */
async function paired(o: { status?: Reply[]; pairingId?: string | null } = {}): Promise<void> {
  api = await FakeApi.start(o.status ? { status: o.status } : {});
  writeFileSync(
    getPaths(h.home).configFile,
    JSON.stringify({
      deviceId: DEV_ID,
      userId: USER_ID,
      deviceName: 'mac',
      apiUrl: api.url,
      ...(o.pairingId === null ? {} : { pairingId: o.pairingId ?? 'pr_1' }),
    }),
  );
}

interface Check {
  name: string;
  status: string;
  detail: string;
  fix?: string;
}

async function checks(args: string[] = []): Promise<Check[]> {
  h.stdout.length = 0;
  await h.run(['doctor', '--json', ...args]);
  return (lastJson(h) as { checks: Check[] }).checks;
}

const named = (list: Check[], name: string) => list.find((c) => c.name === name);

const withOnboarding = (over: OnboardingOver, productNumber: string | null = PRODUCT_NUMBER) => [
  statusCompletedWithOnboarding(over, productNumber),
];

describe('pagr doctor · the account', () => {
  it('reports a linked phone and an active trial', async () => {
    await paired({ status: withOnboarding({ messagingLinked: true, entitled: true }) });
    const list = await checks();
    expect(named(list, 'phone')).toMatchObject({ status: 'ok', detail: 'linked' });
    expect(named(list, 'trial')).toMatchObject({ status: 'ok', detail: 'active' });
  });

  it('warns — never fails — when they are unfinished, and names what finishes them', async () => {
    await paired({ status: withOnboarding({}) });
    const list = await checks();
    expect(named(list, 'phone')?.status).toBe('warn');
    expect(named(list, 'phone')?.fix).toContain(`text Hi Pagr to ${PRODUCT_NUMBER}`);
    expect(named(list, 'trial')?.status).toBe('warn');
    expect(named(list, 'trial')?.fix).toContain('/welcome');
    // `fail` means broken; an account whose owner has not texted Pagr yet is merely unfinished,
    // so neither check may ever be the thing that makes `pagr doctor` exit non-zero.
    expect(list.filter((c) => c.status === 'fail').map((c) => c.name)).not.toContain('phone');
    expect(list.filter((c) => c.status === 'fail').map((c) => c.name)).not.toContain('trial');
  });

  it('points at the dashboard when the deployment publishes no number', async () => {
    await paired({ status: withOnboarding({}, null) });
    expect(named(await checks(), 'phone')?.fix).toContain(
      'link your phone at http://localhost:3000',
    );
  });

  it('skips, with the command that enables it, on a Mac paired before the id was recorded', async () => {
    await paired({ pairingId: null });
    const list = await checks();
    expect(named(list, 'phone')).toMatchObject({
      status: 'skip',
      fix: 're-run `pagr connect --force` to enable this check',
    });
    expect(named(list, 'phone')?.detail).toContain('before pagr recorded the pairing id');
    expect(named(list, 'trial')?.status).toBe('skip');
  });

  it('skips on --offline and on a Mac that was never paired', async () => {
    await paired({ status: withOnboarding({ messagingLinked: true, entitled: true }) });
    const offline = await checks(['--offline']);
    expect(named(offline, 'phone')).toMatchObject({ status: 'skip', detail: '--offline' });
    expect(named(offline, 'trial')).toMatchObject({ status: 'skip', detail: '--offline' });

    h.cleanup();
    h = harness();
    h.overrides.env = { ...h.overrides.env, PAGR_API_URL: api?.url ?? '' };
    expect(named(await checks(), 'phone')?.detail).toContain('not paired yet');
  });

  it('says the deployment is silent rather than guessing, on an older api', async () => {
    await paired({ status: [statusCompleted()] });
    expect(named(await checks(), 'phone')).toMatchObject({
      status: 'skip',
      detail: 'this Pagr deployment does not report account state',
    });
  });

  it('an api that cannot be reached is unknown, not "not linked"', async () => {
    await paired({ status: [{ status: 500, json: { error: 'boom' } }] });
    const list = await checks();
    expect(named(list, 'phone')?.status).toBe('skip');
    expect(named(list, 'phone')?.detail).toContain('could not ask');
    expect(named(list, 'trial')?.status).toBe('skip');
  });
});

describe('pagr status · the account', () => {
  it('adds phone and trial to --json', async () => {
    await paired({ status: withOnboarding({ messagingLinked: true }) });
    expect(await h.run(['status', '--json'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({
      phoneLinked: true,
      entitled: false,
      productNumber: PRODUCT_NUMBER,
      accountUnknown: null,
    });
  });

  it('prints an Account block above the phone-link block', async () => {
    await paired({ status: withOnboarding({ messagingLinked: true }) });
    expect(await h.run(['status'])).toBe(EXIT.ok);
    const text = plain(h.stdout);
    expect(text).toContain('Account');
    expect(text).toMatch(/phone\s+✓ linked/);
    expect(text).toMatch(/trial\s+! not started/);
  });

  it('offers the text to send when the phone is not linked', async () => {
    await paired({ status: withOnboarding({}) });
    expect(await h.run(['status'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain(`text Hi Pagr to ${PRODUCT_NUMBER}`);
  });

  it('is null, with the reason, when the facts cannot be read', async () => {
    await paired({ pairingId: null });
    expect(await h.run(['status', '--json'])).toBe(EXIT.ok);
    const json = lastJson(h) as { phoneLinked: null; entitled: null; accountUnknown: string };
    expect(json.phoneLinked).toBeNull();
    expect(json.entitled).toBeNull();
    expect(json.accountUnknown).toContain('before pagr recorded the pairing id');
    expect(plain(h.stdout)).not.toContain('Account');
  });

  it('stays local, and silent about the account, on a Mac that was never paired', async () => {
    api = await FakeApi.start();
    expect(await h.run(['status', '--json'])).toBe(EXIT.ok);
    expect(api.requests).toHaveLength(0);
    expect(lastJson(h)).toMatchObject({ phoneLinked: null, entitled: null });
  });
});
