import { getPaths, readConfig } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextOverrides } from '../context.js';
import { EXIT } from '../errors.js';
import {
  FakeApi,
  lineOk,
  PRODUCT_NUMBER,
  type Reply,
  statusCompleted,
  statusCompletedWithOnboarding,
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

/**
 * `connect` against a fake api, with a short account-step timeout so a step that is never
 * finished ends in a couple of polls of the harness's virtual clock.
 */
async function connect(
  o: { status?: Reply[]; line?: Reply[] } = {},
  args: string[] = [],
  overrides: ContextOverrides = {},
): Promise<number> {
  api = await FakeApi.start(o);
  Object.assign(h.overrides, overrides);
  return h.run(['connect', '--api-url', api.url, '--wait', '0', '--timeout', '0.05', ...args]);
}

const out = () => plain(h.stdout);
const all = () => `${plain(h.stdout)}\n${plain(h.stderr)}`;
const statusCalls = () => api?.paths().filter((p) => p.includes('/status/')).length ?? 0;

describe('connect · step 7, link your phone', () => {
  it('prints the number and the sms link, waits, and confirms when the text arrives', async () => {
    expect(
      await connect({
        status: [
          statusCompletedWithOnboarding(),
          statusCompletedWithOnboarding(),
          statusCompletedWithOnboarding({ messagingLinked: true }),
          statusCompletedWithOnboarding({ messagingLinked: true, entitled: true }),
        ],
      }),
    ).toBe(EXIT.ok);
    const text = all();
    expect(text).toContain('[7/8]');
    expect(text).toContain('Link your phone');
    expect(text).toContain(`Hi Pagr`);
    expect(text).toContain(PRODUCT_NUMBER);
    // no QR without a TTY — the link itself is always printed in a form that can be copied
    expect(text).toContain('sms:+15550101234?&body=Hi%20Pagr');
    expect(text).toContain('phone linked');
  });

  const linkThenDone = () => ({
    status: [
      statusCompletedWithOnboarding(),
      statusCompletedWithOnboarding({ messagingLinked: true, entitled: true }),
    ],
  });

  it('draws a QR when there is a terminal wide enough to hold it', async () => {
    expect(await connect(linkThenDone(), [], { isTTY: true, columns: 80 })).toBe(EXIT.ok);
    expect(all()).toContain('█');
  });

  it('falls back to the plain link on a terminal too narrow for the code', async () => {
    expect(await connect(linkThenDone(), [], { isTTY: true, columns: 30 })).toBe(EXIT.ok);
    expect(all()).not.toContain('█');
    expect(all()).toContain('sms:+15550101234?&body=Hi%20Pagr');
  });

  it('--no-qr prints the link even on a terminal that could draw the code', async () => {
    expect(await connect(linkThenDone(), ['--no-qr'], { isTTY: true, columns: 200 })).toBe(EXIT.ok);
    expect(all()).not.toContain('█');
    expect(all()).toContain('sms:+15550101234?&body=Hi%20Pagr');
  });

  it('asks /v1/messaging/line only when the pairing response carried no number', async () => {
    expect(
      await connect({
        status: [
          statusCompletedWithOnboarding({}, null),
          statusCompletedWithOnboarding({ messagingLinked: true, entitled: true }, null),
        ],
        line: [lineOk('+442071838750')],
      }),
    ).toBe(EXIT.ok);
    expect(api?.paths()).toContain('GET /v1/messaging/line');
    expect(all()).toContain('+442071838750');
  });

  it('says so plainly when the deployment has no number to text at all', async () => {
    expect(
      await connect({
        status: [statusCompletedWithOnboarding({}, null), statusCompletedWithOnboarding({}, null)],
        line: [lineOk(null)],
      }),
    ).toBe(EXIT.ok);
    const text = all();
    expect(text).toContain('no number to text yet');
    expect(text).toContain('http://localhost:3000/welcome');
    expect(text).not.toContain('sms:');
  });

  it('--open-messages opens the link and prints the caveat that makes it opt-in', async () => {
    expect(
      await connect(
        {
          status: [
            statusCompletedWithOnboarding(),
            statusCompletedWithOnboarding({ messagingLinked: true, entitled: true }),
          ],
        },
        ['--open-messages'],
      ),
    ).toBe(EXIT.ok);
    expect(h.opened).toContain('sms:+15550101234?&body=Hi%20Pagr');
    expect(all()).toContain('Start new conversations from');
  });

  it('skips the step entirely when the phone was linked from the web door', async () => {
    expect(
      await connect({
        status: [
          statusCompletedWithOnboarding({ messagingLinked: true }),
          statusCompletedWithOnboarding({ messagingLinked: true, entitled: true }),
        ],
      }),
    ).toBe(EXIT.ok);
    const text = all();
    expect(text).toContain('phone already linked');
    expect(text).not.toContain('Link your phone');
    // the trial is then the only step left, and says so
    expect(text).toContain('[7/7]');
  });
});

describe('connect · step 8, start your trial', () => {
  it('opens /welcome, waits, and confirms when the webhook lands', async () => {
    expect(
      await connect({
        status: [
          statusCompletedWithOnboarding({ messagingLinked: true }),
          statusCompletedWithOnboarding({ messagingLinked: true, entitled: true }),
        ],
      }),
    ).toBe(EXIT.ok);
    expect(h.opened).toContain('http://localhost:3000/welcome');
    expect(all()).toContain('trial started');
  });

  it('times out politely with the URL instead of blocking the install', async () => {
    expect(
      await connect({
        status: [statusCompletedWithOnboarding({ messagingLinked: true })],
      }),
    ).toBe(EXIT.ok);
    const text = all();
    expect(text).toContain('not started yet');
    expect(text).toContain('http://localhost:3000/welcome');
    expect(out()).toContain('trial');
  });

  it('does not wait at all when both steps are already done', async () => {
    expect(
      await connect({
        status: [statusCompletedWithOnboarding({ messagingLinked: true, entitled: true })],
      }),
    ).toBe(EXIT.ok);
    expect(statusCalls()).toBe(1);
    expect(all()).toContain('trial already active');
    expect(all()).toContain('[6/6]');
  });
});

describe('connect · the summary and the config', () => {
  it('reports the live account state instead of pointing at the dashboard', async () => {
    expect(
      await connect({
        status: [statusCompletedWithOnboarding({ messagingLinked: true, entitled: true })],
      }),
    ).toBe(EXIT.ok);
    const text = out();
    expect(text).toMatch(/phone\s+✓ linked/);
    expect(text).toMatch(/trial\s+✓ active/);
    expect(text).not.toContain('link iMessage from the dashboard');
  });

  it('names what is left, with the command or URL that finishes it', async () => {
    expect(await connect({ status: [statusCompletedWithOnboarding()] })).toBe(EXIT.ok);
    const text = out();
    expect(text).toMatch(/phone\s+! not linked — text Hi Pagr to \+15550101234/);
    expect(text).toMatch(/trial\s+! not started — http:\/\/localhost:3000\/welcome/);
    expect(text).toContain('text Hi Pagr to +15550101234');
    expect(text).toContain('start your trial');
  });

  it('persists the pairing id so status and doctor can ask about the account later', async () => {
    expect(
      await connect({
        status: [statusCompletedWithOnboarding({ messagingLinked: true, entitled: true })],
      }),
    ).toBe(EXIT.ok);
    expect(readConfig(getPaths(h.home).configFile).pairingId).toBe('pr_1');
  });

  it('--json reports the facts and never sits waiting for a person', async () => {
    expect(await connect({ status: [statusCompletedWithOnboarding()] }, ['--json'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({
      ok: true,
      productNumber: PRODUCT_NUMBER,
      welcomeUrl: 'http://localhost:3000/welcome',
      onboarding: { messagingLinked: false, entitled: false, hasProject: false },
    });
    // one read, no poll: a scripted run reports what is true and gets out of the way
    expect(statusCalls()).toBe(1);
    expect(h.opened).not.toContain('http://localhost:3000/welcome');
  });
});

describe('connect · an api that says nothing about the account', () => {
  it('adds no steps, no requests and no claims', async () => {
    expect(await connect({ status: [statusCompleted()] })).toBe(EXIT.ok);
    const text = all();
    expect(statusCalls()).toBe(1);
    expect(text).toContain('[6/6]');
    expect(text).not.toContain('[7/');
    expect(text).not.toMatch(/phone\s+(✓|!)/);
    // the old hand-off copy is what is left when we genuinely do not know
    expect(text).toContain('link iMessage from the dashboard');
  });

  it('reports null onboarding in --json rather than a guess', async () => {
    expect(await connect({ status: [statusCompleted()] }, ['--json'])).toBe(EXIT.ok);
    expect(lastJson(h)).toMatchObject({ onboarding: null, productNumber: null });
  });
});

describe('connect · the account steps can never break the install', () => {
  it('Ctrl-C during the phone wait finishes the install, it does not abort it', async () => {
    api = await FakeApi.start({
      status: [statusCompletedWithOnboarding(), statusCompletedWithOnboarding()],
    });
    h.overrides.sleep = async (ms) => {
      h.nowMs += Math.max(ms, h.clockStepMs);
      h.interrupt();
    };
    expect(await h.run(['connect', '--api-url', api.url, '--wait', '0', '--timeout', '0.05'])).toBe(
      EXIT.ok,
    );
    expect(out()).toContain('Next steps');
    expect(readConfig(getPaths(h.home).configFile).deviceId).toBeTruthy();
    // and one Ctrl-C is enough: the trial step prints what finishes it and waits for nothing
    expect(all()).toContain('not waiting — open it whenever you are ready');
    expect(h.opened).not.toContain('http://localhost:3000/welcome');
  });

  it('does not hold a broken install hostage to two account steps', async () => {
    // The daemon never answered: that is a real failure with a real fix, and it must be the
    // thing the user is told about — not something they reach after two waits.
    api = await FakeApi.start({ status: [statusCompletedWithOnboarding()] });
    expect(await h.run(['connect', '--api-url', api.url, '--wait', '1', '--timeout', '0.05'])).toBe(
      EXIT.precondition,
    );
    const text = all();
    expect(text).not.toContain('[7/');
    expect(text).toContain('did not start');
    expect(statusCalls()).toBe(1);
  });

  it('an api that stops answering is a note, not a failed pairing', async () => {
    expect(
      await connect({
        status: [statusCompletedWithOnboarding(), { status: 404, json: { error: 'not_found' } }],
      }),
    ).toBe(EXIT.ok);
    expect(all()).toContain('could not check whether your phone linked');
    expect(out()).toContain('Done');
  });
});
