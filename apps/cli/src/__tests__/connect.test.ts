import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPaths, PRIVATE_KEY_SECRET, readConfig } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import {
  DEV_ID,
  deadPort,
  FakeApi,
  type Reply,
  startOk,
  statusCompleted,
  statusPending,
  USER_ID,
} from './fakeApi.js';
import { errJson, failingKeychain, type Harness, harness, lastJson, plain } from './helpers.js';

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

/** `connect` against a live fake API on an ephemeral port. */
async function connect(
  o: { start?: Reply[]; status?: Reply[]; health?: Reply } = {},
  args: string[] = [],
): Promise<number> {
  api = await FakeApi.start(o);
  return h.run(['connect', '--api-url', api.url, '--wait', '0', ...args]);
}

const out = () => plain(h.stdout);
const err = () => plain(h.stderr);
const all = () => `${out()}\n${err()}`;

describe('connect · happy path', () => {
  it('pairs end to end over real HTTP and reports every step', async () => {
    expect(
      await connect({ status: [statusPending(), statusCompleted()] }, ['--name', 'Studio']),
    ).toBe(EXIT.ok);
    // the real wire: one POST to start, then polls until completed
    expect(api?.paths()[0]).toBe('POST /v1/devices/pair/start');
    expect(api?.paths().filter((p) => p.includes('/status/')).length).toBe(2);

    // only the PUBLIC key leaves the machine
    const body = api?.requests[0]?.body as Record<string, unknown>;
    expect(typeof body.publicKey).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE/);
    expect(body.deviceName).toBe('Studio');
    expect(body.protocolVersion).toBe(1);

    const cfg = readConfig(getPaths(h.home).configFile);
    expect(cfg).toMatchObject({
      deviceId: DEV_ID,
      userId: USER_ID,
      gatewayUrl: 'wss://gw.example/ws',
      deviceName: 'Studio',
    });
    expect(await h.store.get(PRIVATE_KEY_SECRET)).toMatch(/PRIVATE KEY/);

    const text = all();
    expect(text).toContain('[1/6]');
    expect(text).toContain('[6/6]');
    expect(text).toContain('ABCD-EFGH');
    expect(text).toContain('Next steps');
    // no projects yet → a concrete, copy-pasteable command with a real path
    expect(out()).toMatch(/pagr project add \S+\/code\/my-app --name MyApp/);
  });

  it('installs the launch agent with this home and binary', async () => {
    expect(await connect()).toBe(EXIT.ok);
    const plist = readFileSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'), 'utf8');
    expect(plist).toContain('/opt/pagr/dist/bin.js');
    expect(plist).toContain(`<string>${h.home}</string>`);
    expect(h.execCalls.some((c) => c[1] === 'bootstrap')).toBe(true);
  });

  it('--no-daemon skips launchd and --gateway-url overrides the pairing value', async () => {
    expect(
      await connect({}, ['--no-daemon', '--no-open', '--gateway-url', 'wss://local:8080']),
    ).toBe(EXIT.ok);
    expect(existsSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'))).toBe(false);
    expect(h.opened).toEqual([]);
    expect(readConfig(getPaths(h.home).configFile).gatewayUrl).toBe('wss://local:8080');
  });

  it('leaves PAGR_HOME 0700 and config.json 0600', async () => {
    expect(await connect()).toBe(EXIT.ok);
    expect(statSync(h.home).mode & 0o777).toBe(0o700);
    expect(statSync(getPaths(h.home).configFile).mode & 0o777).toBe(0o600);
  });
});

describe('connect · the API is not usable', () => {
  it('nothing listening → exit 6 and names the host', async () => {
    const port = await deadPort();
    expect(await h.run(['connect', '--api-url', `http://127.0.0.1:${port}`, '--wait', '0'])).toBe(
      EXIT.network,
    );
    expect(err()).toMatch(/refused the connection|could not reach/);
    expect(err()).toContain('--api-url');
  });

  it('DNS failure → exit 6 with a DNS message', async () => {
    expect(
      await h.run(['connect', '--api-url', 'http://pagr-does-not-exist.invalid', '--wait', '0']),
    ).toBe(EXIT.network);
    expect(err()).toMatch(/cannot resolve|could not reach/);
  });

  it('an HTML error page instead of JSON is called out as such', async () => {
    expect(
      await connect({
        start: [
          {
            text: '<!doctype html><html><body>502 Bad Gateway</body></html>',
            contentType: 'text/html',
          },
        ],
      }),
    ).toBe(EXIT.network);
    expect(err()).toContain('HTML page, not JSON');
    expect(err()).toContain('captive portal');
  });

  it('truncated JSON is called out as malformed', async () => {
    expect(await connect({ start: [{ text: '{"pairingId": "pr_1"' }] })).toBe(EXIT.network);
    expect(err()).toContain('malformed JSON');
  });

  it('a well-formed body of the wrong shape asks for an update', async () => {
    expect(await connect({ start: [{ json: { nope: true } }] })).toBe(EXIT.network);
    expect(err()).toContain('unexpected pair/start response');
    expect(err()).toContain('npm i -g @pagr/cli@latest');
  });

  it('retries 5xx on start, then succeeds', async () => {
    expect(await connect({ start: [{ status: 503, json: { error: 'down' } }, startOk()] })).toBe(
      EXIT.ok,
    );
    expect(api?.paths().filter((p) => p.includes('pair/start')).length).toBe(2);
  });

  it('gives up after repeated 5xx with exit 6', async () => {
    expect(await connect({ start: [{ status: 500, json: { error: 'boom' } }] })).toBe(EXIT.network);
    expect(err()).toContain('HTTP 500');
  });

  it('a slow response is abandoned, not hung on', async () => {
    h.overrides.env = { ...h.overrides.env, PAGR_HTTP_TIMEOUT_MS: '80' };
    expect(await connect({ start: [{ delayMs: 5000, json: {} }] })).toBe(EXIT.network);
    expect(err()).toContain('did not respond within 80ms');
  }, 20_000);
});

describe('connect · version and protocol mismatch', () => {
  it('HTTP 426 → exit 8 with an upgrade instruction', async () => {
    expect(await connect({ start: [{ status: 426, json: { error: 'upgrade_required' } }] })).toBe(
      EXIT.unsupported,
    );
    expect(err()).toContain('no longer supported');
    expect(err()).toContain('npm i -g @pagr/cli@latest');
  });

  it('minBridgeVersion above ours → exit 8, naming both versions', async () => {
    expect(await connect({ start: [startOk({ minBridgeVersion: '9.9.9' })] })).toBe(
      EXIT.unsupported,
    );
    expect(err()).toContain('requires 9.9.9 or newer');
  });

  it('a newer device protocol → exit 8', async () => {
    expect(await connect({ start: [startOk({ protocolVersion: 2 })] })).toBe(EXIT.unsupported);
    expect(err()).toContain('device protocol v2');
  });

  it('HTTP 404 reads as a wrong API URL, not a mystery', async () => {
    expect(await connect({ start: [{ status: 404, json: { error: 'nope' } }] })).toBe(EXIT.network);
    expect(err()).toContain('has no pairing endpoint');
    expect(err()).toContain('PAGR_API_URL');
  });

  it('a pairing status this CLI does not know asks for an update', async () => {
    expect(await connect({ status: [{ json: { status: 'awaiting_2fa' } }] })).toBe(
      EXIT.unsupported,
    );
    expect(err()).toContain('awaiting_2fa');
  });
});

describe('connect · the approval never lands', () => {
  const cases: Array<[string, Reply, number, RegExp]> = [
    ['expired', { json: { status: 'expired' } }, EXIT.pairing, /expired before it was approved/],
    ['rejected', { json: { status: 'rejected' } }, EXIT.pairing, /declined in the dashboard/],
    ['used', { json: { status: 'used' } }, EXIT.pairing, /already used by another device/],
    ['410 gone', { status: 410, json: {} }, EXIT.pairing, /expired/],
    ['409 conflict', { status: 409, json: {} }, EXIT.pairing, /already used/],
  ];
  for (const [name, reply, exit, message] of cases) {
    it(`${name} → exit ${exit} and says what to do`, async () => {
      expect(await connect({ status: [reply] })).toBe(exit);
      expect(err()).toMatch(message);
      expect(err()).toContain('pagr connect');
      // nothing was persisted
      expect(existsSync(getPaths(h.home).configFile)).toBe(false);
    });
  }

  it('nobody ever approves → bounded wait, exit 7, and a clear next step', async () => {
    expect(await connect({ status: [statusPending()] }, ['--timeout', '1'])).toBe(EXIT.pairing);
    expect(err()).toContain('nobody approved this Mac within 1 minutes');
    expect(err()).toContain('nothing was registered');
    expect(existsSync(getPaths(h.home).configFile)).toBe(false);
  });
});

describe('connect · transient network trouble mid-poll', () => {
  it('survives a connection reset and keeps polling', async () => {
    expect(
      await connect({
        status: [statusPending(), { reset: true }, { reset: true }, statusCompleted()],
      }),
    ).toBe(EXIT.ok);
    expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(DEV_ID);
    expect(err()).toMatch(/network trouble/);
  });

  it('survives intermittent 500s', async () => {
    expect(await connect({ status: [{ status: 500, json: {} }, statusCompleted()] })).toBe(EXIT.ok);
  });

  it('gives up after a run of consecutive failures instead of looping forever', async () => {
    expect(await connect({ status: [{ reset: true }] })).toBe(EXIT.network);
    expect(err()).toContain('lost contact with the API');
  });
});

describe('connect · the browser', () => {
  it('opens the pairing URL by default', async () => {
    await connect();
    expect(h.opened).toEqual(['http://localhost:3000/device/pair?code=ABCD-EFGH']);
  });

  it('keeps going and shows the URL when no browser can be opened', async () => {
    h.browserOpens = false;
    expect(await connect({ status: [statusPending(), statusCompleted()] })).toBe(EXIT.ok);
    expect(all()).toContain('could not open a browser here');
    expect(all()).toContain('http://localhost:3000/device/pair?code=ABCD-EFGH');
  });

  it('does not try to open a browser inside an SSH session', async () => {
    h.overrides.env = { ...h.overrides.env, SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 51000' };
    expect(await connect()).toBe(EXIT.ok);
    expect(h.opened).toEqual([]);
    expect(all()).toContain('SSH session');
  });
});

describe('connect · the Keychain', () => {
  const store = failingKeychain;

  it('a locked Keychain fails with exit 9 and an unlock instruction, not a stack trace', async () => {
    h.store = store('Keychain is locked (-25629)');
    expect(await connect()).toBe(EXIT.secretStore);
    expect(err()).toContain('unlock your login Keychain');
    expect(err()).not.toContain('    at ');
  });

  it('a denied prompt fails with exit 9 and says Always Allow', async () => {
    h.store = store('User interaction is not allowed (-25308)');
    expect(await connect()).toBe(EXIT.secretStore);
    expect(err()).toContain('Always Allow');
  });

  it('a missing native module fails with exit 9 and a reinstall instruction', async () => {
    h.store = store('ERR_DLOPEN_FAILED: incompatible architecture');
    expect(await connect()).toBe(EXIT.secretStore);
    expect(err()).toContain('npm i -g @pagr/cli');
  });

  it('never contacts the API when the key cannot be read', async () => {
    h.store = store('Keychain is locked');
    api = await FakeApi.start();
    await h.run(['connect', '--api-url', api.url, '--wait', '0']);
    expect(api.requests).toEqual([]);
  });
});

describe('connect · local state', () => {
  it('re-running on a paired Mac is a safe no-op', async () => {
    expect(await connect()).toBe(EXIT.ok);
    const before = readFileSync(getPaths(h.home).configFile, 'utf8');
    h.stdout.length = 0;
    const calls = api?.requests.length ?? 0;
    expect(await h.run(['connect', '--api-url', api?.url ?? '', '--wait', '0'])).toBe(EXIT.ok);
    expect(out()).toContain('already paired');
    expect(api?.requests.length).toBe(calls); // the API was not touched again
    expect(readFileSync(getPaths(h.home).configFile, 'utf8')).toBe(before);
  });

  it('--force re-pairs, rotates the device key and tells the server what it replaces', async () => {
    expect(await connect()).toBe(EXIT.ok);
    const firstKey = await h.store.get(PRIVATE_KEY_SECRET);
    await api?.close();
    api = null;
    h.stdout.length = 0;
    h.stderr.length = 0;

    const other = `dev_${'c'.repeat(32)}`;
    const second = await FakeApi.start({ status: [statusCompleted({ deviceId: other })] });
    api = second;
    expect(await h.run(['connect', '--api-url', second.url, '--wait', '0', '--force'])).toBe(
      EXIT.ok,
    );
    const body = second.requests[0]?.body as Record<string, unknown>;
    expect(body.replacesDeviceId).toBe(DEV_ID);
    const secondKey = await h.store.get(PRIVATE_KEY_SECRET);
    expect(secondKey).not.toBe(firstKey); // revoked key material is never reused
    expect(body.publicKey).not.toBe('');
    expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(other);
    // The new key is only announced once it is actually in the store.
    expect(all()).toContain('replacement device key minted');
  });

  describe('--force that never completes leaves the working pairing alone', () => {
    /** Pair once, then try to re-pair against an API that fails in some way. */
    const pairThenForce = async (
      o: { start?: Reply[]; status?: Reply[] },
      args: string[] = [],
    ): Promise<{ code: number; firstKey: string | null }> => {
      expect(await connect()).toBe(EXIT.ok);
      const firstKey = await h.store.get(PRIVATE_KEY_SECRET);
      await api?.close();
      h.stdout.length = 0;
      h.stderr.length = 0;
      api = await FakeApi.start(o);
      const code = await h.run([
        'connect',
        '--api-url',
        api.url,
        '--wait',
        '0',
        '--force',
        ...args,
      ]);
      return { code, firstKey };
    };

    /** The whole point of BR-8: the Mac is still the device it was, key and config agreeing. */
    const expectUnchanged = async (firstKey: string | null) => {
      expect(await h.store.get(PRIVATE_KEY_SECRET)).toBe(firstKey);
      expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(DEV_ID);
      // and the CLI still treats this Mac as paired, with the identity it started with
      h.stdout.length = 0;
      expect(await h.run(['--json', 'status'])).toBe(EXIT.ok);
      expect((lastJson(h) as { deviceId: string }).deviceId).toBe(DEV_ID);
    };

    it('when the API 500s before a code is issued', async () => {
      const { code, firstKey } = await pairThenForce({
        start: [{ status: 500, json: { error: 'boom' } }],
      });
      expect(code).toBe(EXIT.network);
      await expectUnchanged(firstKey);
    });

    it('when the user declines the request in the dashboard', async () => {
      const { code, firstKey } = await pairThenForce({
        status: [{ json: { status: 'rejected' } }],
      });
      expect(code).toBe(EXIT.pairing);
      expect(err()).toContain('declined');
      await expectUnchanged(firstKey);
    });

    it('when nobody ever approves and the wait times out', async () => {
      const { code, firstKey } = await pairThenForce({ status: [statusPending()] }, [
        '--timeout',
        '0.05',
      ]);
      expect(code).toBe(EXIT.pairing);
      expect(err()).toContain('nobody approved');
      await expectUnchanged(firstKey);
    });

    it('when the approval is interrupted with Ctrl-C', async () => {
      expect(await connect()).toBe(EXIT.ok);
      const firstKey = await h.store.get(PRIVATE_KEY_SECRET);
      await api?.close();
      api = await FakeApi.start({ status: [statusPending()] });
      h.overrides.sleep = async (ms) => {
        h.nowMs += Math.max(ms, h.clockStepMs);
        h.interrupt();
      };
      expect(await h.run(['connect', '--api-url', api.url, '--wait', '0', '--force'])).toBe(
        EXIT.interrupted,
      );
      await expectUnchanged(firstKey);
    });

    it('when the Keychain refuses to store the replacement key after approval', async () => {
      expect(await connect()).toBe(EXIT.ok);
      const firstKey = await h.store.get(PRIVATE_KEY_SECRET);
      await api?.close();
      h.stdout.length = 0;
      h.stderr.length = 0;
      // Reads keep working (so the old key is still there); only the write fails.
      const store = h.store;
      h.store = {
        kind: store.kind,
        get: (k) => store.get(k),
        set: () =>
          Promise.reject(new Error('keychain write failed: User interaction is not allowed')),
        delete: (k) => store.delete(k),
      };
      api = await FakeApi.start({
        status: [statusCompleted({ deviceId: `dev_${'c'.repeat(32)}` })],
      });
      expect(await h.run(['connect', '--api-url', api.url, '--wait', '0', '--force'])).toBe(
        EXIT.secretStore,
      );
      expect(err()).toContain('still paired as');
      h.store = store;
      await expectUnchanged(firstKey);
    });

    it('when config.json cannot be written after approval, the old key is put back', async () => {
      expect(await connect()).toBe(EXIT.ok);
      const firstKey = await h.store.get(PRIVATE_KEY_SECRET);
      const before = readFileSync(getPaths(h.home).configFile, 'utf8');
      await api?.close();
      h.stdout.length = 0;
      h.stderr.length = 0;
      api = await FakeApi.start({
        status: [statusPending(), statusCompleted({ deviceId: `dev_${'c'.repeat(32)}` })],
      });
      // Take away write access AFTER the writability probe, mid-poll — the narrow window in
      // which `connect` has a new pairing and cannot record it.
      h.overrides.sleep = async (ms) => {
        h.nowMs += Math.max(ms, h.clockStepMs);
        chmodSync(h.home, 0o500);
      };
      try {
        expect(await h.run(['connect', '--api-url', api.url, '--wait', '0', '--force'])).toBe(
          EXIT.state,
        );
      } finally {
        chmodSync(h.home, 0o700);
      }
      expect(err()).toContain('could not be written');
      expect(err()).toContain('previous device key was put back');
      expect(await h.store.get(PRIVATE_KEY_SECRET)).toBe(firstKey);
      expect(readFileSync(getPaths(h.home).configFile, 'utf8')).toBe(before);
    });

    it('a second --force after a failed one is clean', async () => {
      const { code, firstKey } = await pairThenForce({
        start: [{ status: 500, json: { error: 'boom' } }],
      });
      expect(code).toBe(EXIT.network);
      await api?.close();
      h.stdout.length = 0;
      h.stderr.length = 0;
      const other = `dev_${'c'.repeat(32)}`;
      api = await FakeApi.start({ status: [statusCompleted({ deviceId: other })] });
      expect(await h.run(['connect', '--api-url', api.url, '--wait', '0', '--force'])).toBe(
        EXIT.ok,
      );
      const body = api.requests[0]?.body as Record<string, unknown>;
      // still replacing the ORIGINAL device: the failed attempt registered nothing
      expect(body.replacesDeviceId).toBe(DEV_ID);
      const finalKey = await h.store.get(PRIVATE_KEY_SECRET);
      expect(finalKey).not.toBe(firstKey);
      expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(other);
      // exactly one identity is left behind, and it signs for the device in config.json
      expect(finalKey).toMatch(/PRIVATE KEY/);
    });
  });

  it('warns loudly when the approval lands on a different Pagr account', async () => {
    expect(await connect()).toBe(EXIT.ok);
    await api?.close();
    h.stdout.length = 0;
    h.stderr.length = 0;
    const otherUser = `usr_${'d'.repeat(32)}`;
    const second = await FakeApi.start({
      status: [statusCompleted({ deviceId: `dev_${'e'.repeat(32)}`, userId: otherUser })],
    });
    api = second;
    expect(await h.run(['connect', '--api-url', second.url, '--wait', '0', '--force'])).toBe(
      EXIT.ok,
    );
    expect(all()).toContain('different Pagr account');
    expect(all()).toContain(otherUser);
  });

  it('says the pairing is stranded when config.json cannot be written', async () => {
    api = await FakeApi.start();
    // Make the home read-only only AFTER the writability probe, by removing write access to the
    // config file itself via an unwritable directory swap is fiddly — instead point the config
    // at a directory, which no write can ever replace.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(getPaths(h.home).configFile, { recursive: true });
    expect(await h.run(['connect', '--api-url', api.url, '--wait', '0'])).toBe(EXIT.state);
    expect(err()).toContain('paired with Pagr, but');
    expect(err()).toContain('revoke the stranded device');
  });

  it('a corrupt config.json is reported and recovered from', async () => {
    writeFileSync(getPaths(h.home).configFile, '{"deviceId": "dev_');
    expect(await connect()).toBe(EXIT.ok);
    expect(all()).toContain('not valid JSON');
    expect(all()).toContain('starting fresh');
    expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(DEV_ID);
  });

  it('a config of the wrong shape is reported and recovered from', async () => {
    writeFileSync(getPaths(h.home).configFile, JSON.stringify({ gatewayUrl: 'not-a-url' }));
    expect(await connect()).toBe(EXIT.ok);
    expect(all()).toContain('not a valid pagr config');
    expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(DEV_ID);
  });

  it('an unwritable PAGR_HOME fails with exit 10 before anything else happens', async () => {
    const readonlyHome = join(h.home, '..', 'ro');
    const { mkdirSync, chmodSync } = await import('node:fs');
    mkdirSync(readonlyHome, { recursive: true });
    chmodSync(readonlyHome, 0o500);
    api = await FakeApi.start();
    try {
      expect(
        await h.run(['--home', readonlyHome, 'connect', '--api-url', api.url, '--wait', '0']),
      ).toBe(EXIT.state);
      expect(err()).toContain('cannot write to');
      expect(api.requests).toEqual([]);
    } finally {
      chmodSync(readonlyHome, 0o700);
    }
  });

  it('loose permissions under PAGR_HOME are tightened and reported', async () => {
    const { chmodSync } = await import('node:fs');
    chmodSync(h.home, 0o755);
    expect(await connect()).toBe(EXIT.ok);
    expect(statSync(h.home).mode & 0o777).toBe(0o700);
    expect(all()).toContain('tightened permissions');
  });
});

describe('connect · Ctrl-C', () => {
  it('leaves no half-written state and exits 130', async () => {
    api = await FakeApi.start({ status: [statusPending()] });
    // Interrupt as soon as the poll starts sleeping.
    h.overrides.sleep = async () => {
      h.nowMs += 1000;
      h.interrupt();
    };
    expect(await h.run(['connect', '--api-url', api.url, '--wait', '0'])).toBe(EXIT.interrupted);
    expect(err()).toContain('canceled');
    expect(existsSync(getPaths(h.home).configFile)).toBe(false);
    expect(existsSync(join(h.launchAgentsDir, 'dev.pagr.bridge.plist'))).toBe(false);
  });
});

describe('connect · clock skew', () => {
  it('warns clearly when this Mac disagrees with the server about the time', async () => {
    const serverDate = new Date(h.nowMs - 90 * 60_000).toUTCString();
    expect(await connect({ start: [{ ...startOk(), headers: { date: serverDate } }] })).toBe(
      EXIT.ok,
    );
    expect(all()).toContain('ahead of the Pagr server');
    expect(all()).toContain('Date & Time');
  });
});

describe('connect · launchd', () => {
  it('reports a launchctl failure without losing the pairing', async () => {
    h.execImpl = (file, args) => {
      if (file === '/bin/launchctl' && args[0] === 'bootstrap')
        throw Object.assign(new Error('Bootstrap failed: 5: Input/output error'), {
          stderr: 'Bootstrap failed: 5: Input/output error',
        });
      return '';
    };
    expect(await connect()).toBe(EXIT.precondition);
    expect(err()).toContain('launchctl refused to start');
    expect(err()).toContain('Input/output error');
    // the pairing survives — the user must not be told to re-pair
    expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(DEV_ID);
  });

  it('recovers when the agent is already bootstrapped', async () => {
    const calls: string[] = [];
    h.execImpl = (_file, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'bootstrap')
        throw Object.assign(new Error('service already bootstrapped'), {
          stderr: 'Load failed: 37: Operation already in progress',
        });
      return '';
    };
    expect(await connect()).toBe(EXIT.ok);
    expect(calls.some((c) => c.startsWith('kickstart -k'))).toBe(true);
  });

  it('says so plainly when launchd is not available at all', async () => {
    h.launchctl = false;
    expect(await connect()).toBe(EXIT.ok);
    expect(all()).toContain('launchd is not available');
    expect(all()).toContain('pagr daemon run');
    expect(readConfig(getPaths(h.home).configFile).deviceId).toBe(DEV_ID);
  });
});

describe('connect · --json', () => {
  it('emits one JSON document on stdout and nothing else', async () => {
    h.overrides.env = { ...h.overrides.env };
    expect(await connect({}, ['--json'])).toBe(EXIT.ok);
    const j = lastJson(h) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.deviceId).toBe(DEV_ID);
    expect(j.gatewayUrl).toBe('wss://gw.example/ws');
    // the pairing code and step narration went to stderr, not stdout
    expect(out()).not.toContain('ABCD-EFGH');
    expect(err()).toContain('ABCD-EFGH');
  });

  it('emits exactly one JSON error document on stdout when it fails', async () => {
    expect(await connect({ status: [{ json: { status: 'expired' } }] }, ['--json'])).toBe(
      EXIT.pairing,
    );
    const e = errJson(h);
    expect(e.ok).toBe(false);
    expect(e.error).toMatchObject({ code: 'pairing_expired', exitCode: EXIT.pairing });
    expect(typeof e.error.hint).toBe('string');
  });

  it('reports a daemon that never came up inside the same JSON document', async () => {
    api = await FakeApi.start();
    expect(await h.run(['connect', '--api-url', api.url, '--json', '--wait', '2'])).toBe(
      EXIT.precondition,
    );
    const j = lastJson(h) as { ok: boolean; deviceId: string; error: Record<string, unknown> };
    expect(j.ok).toBe(false);
    expect(j.deviceId).toBe(DEV_ID); // the pairing still happened and is reported
    expect(j.error).toMatchObject({ code: 'daemon_did_not_start' });
  });
});
