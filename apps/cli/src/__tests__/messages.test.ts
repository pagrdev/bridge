import {
  InvalidDeviceKeyError,
  LaunchAgentError,
  PagrHomeError,
  PairingError,
  type PairingErrorCode,
  SecretStoreError,
} from '@pagr/bridge-core';
import { describe, expect, it } from 'vitest';
import {
  CliError,
  daemonDownError,
  EXIT,
  interruptedError,
  notPairedError,
  PAIRING_EXIT,
  toCliError,
} from '../errors.js';

/**
 * The copy IS the product here: every failure a stranger can hit must arrive as a plain-language
 * message, an actionable hint and a stable exit code. These tables are the contract.
 */
describe('every pairing failure maps to a code, an exit and a hint', () => {
  const cases: Array<[PairingErrorCode, number, string]> = [
    ['network', EXIT.network, 'pairing_network'],
    ['server_error', EXIT.network, 'pairing_server_error'],
    ['not_found', EXIT.network, 'pairing_not_found'],
    ['unauthorized', EXIT.network, 'pairing_unauthorized'],
    ['http', EXIT.network, 'pairing_http'],
    ['invalid_response', EXIT.network, 'pairing_invalid_response'],
    ['unsupported', EXIT.unsupported, 'pairing_unsupported'],
    ['expired', EXIT.pairing, 'pairing_expired'],
    ['rejected', EXIT.pairing, 'pairing_rejected'],
    ['used', EXIT.pairing, 'pairing_used'],
    ['timeout', EXIT.pairing, 'pairing_timeout'],
  ];

  it('covers every code in the union — a new code cannot be added without a decision', () => {
    expect(cases.map(([c]) => c).sort()).toEqual(Object.keys(PAIRING_EXIT).sort());
  });

  for (const [code, exit, slug] of cases) {
    it(`${code} → exit ${exit}`, () => {
      const cli = toCliError(new PairingError(code, 'something happened', { hint: 'do this' }));
      expect(cli.exitCode).toBe(exit);
      expect(cli.code).toBe(slug);
      expect(cli.hint).toBe('do this');
      expect(cli.message).toContain('something happened');
      expect(cli.message).not.toMatch(/\bError\b|\bundefined\b/);
    });
  }

  it('the four "nobody approved" outcomes are prefixed so the phase is obvious', () => {
    for (const code of ['expired', 'rejected', 'used', 'timeout'] as const)
      expect(toCliError(new PairingError(code, 'x')).message).toContain('pairing did not complete');
    for (const code of ['network', 'not_found'] as const)
      expect(toCliError(new PairingError(code, 'x')).message).toBe('x');
  });

  it('falls back to the doctor hint when the domain error had none', () => {
    expect(toCliError(new PairingError('http', 'x')).hint).toContain('pagr doctor');
  });

  it('carries the response excerpt through as `detail`', () => {
    const cli = toCliError(new PairingError('http', 'x', { detail: '{"error":"nope"}' }));
    expect(cli.detail).toBe('{"error":"nope"}');
    expect(cli.toJson().error.detail).toBe('{"error":"nope"}');
  });
});

describe('every other domain error maps to its own exit code', () => {
  const cases: Array<[string, unknown, number, string, RegExp]> = [
    [
      'locked keychain',
      new SecretStoreError('locked', 'keychain is locked', { hint: 'unlock it' }),
      EXIT.secretStore,
      'keychain_locked',
      /unlock it/,
    ],
    [
      'denied keychain',
      new SecretStoreError('denied', 'denied', { hint: 'Always Allow' }),
      EXIT.secretStore,
      'keychain_denied',
      /Always Allow/,
    ],
    [
      'no keychain at all',
      new SecretStoreError('unavailable', 'nope', { hint: 'reinstall' }),
      EXIT.secretStore,
      'keychain_unavailable',
      /reinstall/,
    ],
    [
      'corrupt device key',
      new InvalidDeviceKeyError('bad key'),
      EXIT.secretStore,
      'keychain_invalid_key',
      /pagr logout/,
    ],
    [
      'unwritable PAGR_HOME',
      new PagrHomeError('permission', '/x', 'cannot write to /x', { hint: 'chown it' }),
      EXIT.state,
      'home_permission',
      /chown it/,
    ],
    [
      'full disk',
      new PagrHomeError('no_space', '/x', 'disk full', { hint: 'free space' }),
      EXIT.state,
      'home_no_space',
      /free space/,
    ],
    [
      'launchctl missing',
      new LaunchAgentError('no_launchctl', 'no launchctl', { hint: 'run in foreground' }),
      EXIT.precondition,
      'launchd_no_launchctl',
      /foreground/,
    ],
    [
      'bootstrap refused',
      new LaunchAgentError('bootstrap', 'refused', { hint: 'check logs', detail: 'exit 5' }),
      EXIT.precondition,
      'launchd_bootstrap',
      /check logs/,
    ],
  ];
  for (const [name, err, exit, code, hint] of cases) {
    it(name, () => {
      const cli = toCliError(err);
      expect(cli.exitCode).toBe(exit);
      expect(cli.code).toBe(code);
      expect(cli.hint).toMatch(hint);
    });
  }

  it('an unknown error keeps exit 1 rather than guessing', () => {
    const cli = toCliError(new Error('mystery'));
    expect(cli.exitCode).toBe(EXIT.error);
    expect(cli.code).toBe('error');
    expect(cli.message).toBe('mystery');
  });

  it('a thrown non-Error is still reported', () => {
    expect(toCliError('boom').message).toBe('boom');
  });

  it('a CliError passes through untouched', () => {
    const original = new CliError('x', EXIT.usage, { code: 'usage' });
    expect(toCliError(original)).toBe(original);
  });
});

describe('the shared error constructors', () => {
  it('daemon down → exit 3, points at install and doctor', () => {
    const e = daemonDownError();
    expect(e.exitCode).toBe(EXIT.daemonDown);
    expect(e.hint).toContain('pagr daemon install');
    expect(e.hint).toContain('pagr doctor');
  });

  it('not paired → exit 4, points at connect', () => {
    expect(notPairedError().exitCode).toBe(EXIT.notPaired);
    expect(notPairedError().hint).toContain('pagr connect');
  });

  it('interrupted → exit 130, promises nothing was written', () => {
    const e = interruptedError();
    expect(e.exitCode).toBe(EXIT.interrupted);
    expect(e.hint).toContain('nothing was written');
  });
});

describe('CliError JSON shape', () => {
  it('is stable and machine-readable', () => {
    const e = new CliError('boom', EXIT.network, {
      code: 'pairing_network',
      hint: 'check the wifi',
      detail: 'ECONNREFUSED',
    });
    expect(e.toJson()).toEqual({
      ok: false,
      error: {
        code: 'pairing_network',
        message: 'boom',
        exitCode: EXIT.network,
        hint: 'check the wifi',
        detail: 'ECONNREFUSED',
      },
    });
  });

  it('omits absent fields rather than emitting nulls', () => {
    expect(new CliError('boom').toJson().error).toEqual({
      code: 'error',
      message: 'boom',
      exitCode: EXIT.error,
    });
  });

  it('still accepts the legacy string hint form', () => {
    expect(new CliError('x', EXIT.usage, 'do y').hint).toBe('do y');
  });
});

describe('exit codes are a stable, documented contract', () => {
  it('has no duplicates and no gaps in meaning', () => {
    const values = Object.values(EXIT);
    expect(new Set(values).size).toBe(values.length);
    expect(EXIT).toMatchObject({
      ok: 0,
      error: 1,
      usage: 2,
      daemonDown: 3,
      notPaired: 4,
      precondition: 5,
      network: 6,
      pairing: 7,
      unsupported: 8,
      secretStore: 9,
      state: 10,
      interrupted: 130,
    });
  });
});
