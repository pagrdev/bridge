import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyKeychainError,
  createSecretStore,
  FileSecretStore,
  KeyringSecretStore,
  MemorySecretStore,
  probeSecretStore,
  SecretStoreError,
  SecurityCliSecretStore,
} from './keychain.js';
import { useTempHome } from './testUtil.js';

describe('secret stores', () => {
  const t = useTempHome();

  it('MemorySecretStore round-trips', async () => {
    const s = new MemorySecretStore();
    expect(await s.get('k')).toBeNull();
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
  });

  it('KeyringSecretStore uses Entry(service,key)', async () => {
    const calls: string[] = [];
    const store = new Map<string, string>();
    class FakeEntry {
      constructor(
        readonly service: string,
        readonly user: string,
      ) {
        calls.push(`${service}/${user}`);
      }
      getPassword() {
        return store.get(this.user) ?? null;
      }
      setPassword(v: string) {
        store.set(this.user, v);
      }
      deleteCredential() {
        return store.delete(this.user);
      }
    }
    const s = new KeyringSecretStore(FakeEntry);
    await s.set('device.private_key', 'pem');
    expect(await s.get('device.private_key')).toBe('pem');
    await s.delete('device.private_key');
    expect(await s.get('device.private_key')).toBeNull();
    expect(calls[0]).toBe('dev.pagr.bridge/device.private_key');
  });

  it('SecurityCliSecretStore shells to /usr/bin/security and never puts the secret in argv', async () => {
    const argv: string[][] = [];
    const db = new Map<string, string>();
    const exec = (file: string, args: string[], opts?: { input?: string }) => {
      expect(file).toBe('/usr/bin/security');
      argv.push(args);
      const acct = args[args.indexOf('-a') + 1] ?? '';
      if (args[0] === 'find-generic-password') {
        const v = db.get(acct);
        if (v === undefined) throw new Error('not found');
        return `${v}\n`;
      }
      if (args[0] === 'add-generic-password') {
        // Real `security add-generic-password -w` with no value prompts on stdin and then asks
        // for a retype, so it reads the secret twice.
        const lines = (opts?.input ?? '').split('\n');
        expect(lines[0]).toBe(lines[1]);
        db.set(acct, lines[0] ?? '');
        return '';
      }
      db.delete(acct);
      return '';
    };
    const s = new SecurityCliSecretStore(exec);
    await s.set('k', 'secret value');
    expect(await s.get('k')).toBe('secret value');
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
    expect(argv[0]).toContain('-U');
    expect(argv[0]).toContain('dev.pagr.bridge');
    // BR-21/SEC-17: argv is visible in `ps` to every user on the machine while the call runs.
    expect(argv[0]).not.toContain('secret value');
    expect(argv[0]?.[argv[0].indexOf('-w') + 1]).toBeUndefined();
  });

  it('FileSecretStore writes 0600 file', async () => {
    const s = new FileSecretStore(t.home);
    await s.set('a', '1');
    const f = join(t.home, 'secrets.json');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ a: '1' });
  });

  it('createSecretStore picks keyring, then security, then file only if opted in', async () => {
    const mem = new MemorySecretStore();
    const a = await createSecretStore({ home: t.home, env: {}, loadKeyring: async () => mem });
    expect(a.kind).toBe('memory');
    const b = await createSecretStore({
      home: t.home,
      env: {},
      loadKeyring: async () => null,
      securityAvailable: () => true,
    });
    expect(b.kind).toBe('security-cli');
    await expect(
      createSecretStore({
        home: t.home,
        env: {},
        loadKeyring: async () => null,
        securityAvailable: () => false,
      }),
    ).rejects.toThrow(/no secure secret store/);
    const c = await createSecretStore({
      home: t.home,
      env: { PAGR_INSECURE_FILE_STORE: '1' },
      loadKeyring: async () => null,
    });
    expect(c.kind).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// Failure classification. Getting this wrong is how a locked Keychain silently
// becomes a brand-new device key that overwrites a working pairing.
// ---------------------------------------------------------------------------

describe('keychain failure classification', () => {
  const t = useTempHome();

  const cases: Array<[string, string]> = [
    ['No matching entry found in secure storage', 'not_found'],
    ['The specified item could not be found in the keychain.', 'not_found'],
    ['errSecItemNotFound (-25300)', 'not_found'],
    [
      'SecKeychainItemCopyContent: The user name or passphrase you entered is not correct. (-25629) keychain is locked',
      'locked',
    ],
    ['errSecKeychainLocked', 'locked'],
    ['User interaction is not allowed. (-25308)', 'denied'],
    ['The user canceled the operation. (-128)', 'denied'],
    ['SecKeychain authorization denied', 'denied'],
    ["Cannot find module '@napi-rs/keyring-darwin-arm64'", 'unavailable'],
    ['ERR_DLOPEN_FAILED: mach-o file, but is an incompatible architecture', 'unavailable'],
    ['something else entirely', 'io'],
  ];
  for (const [message, expected] of cases) {
    it(`"${message.slice(0, 40)}…" → ${expected}`, () => {
      expect(classifyKeychainError(message)).toBe(expected);
    });
  }

  const failing = (message: string) => {
    class E {
      constructor(
        readonly service: string,
        readonly user: string,
      ) {}
      getPassword(): string | null {
        throw new Error(message);
      }
      setPassword(): void {
        throw new Error(message);
      }
      deleteCredential(): boolean {
        throw new Error(message);
      }
    }
    return new KeyringSecretStore(E);
  };

  it('a genuine miss reads as null', async () => {
    expect(await failing('No matching entry found in secure storage').get('k')).toBeNull();
  });

  for (const [message, code] of [
    ['keychain is locked (-25629)', 'locked'],
    ['User interaction is not allowed. (-25308)', 'denied'],
  ] as const) {
    it(`a ${code} keychain THROWS instead of pretending there is no key`, async () => {
      const err = await failing(message)
        .get('device.private_key')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SecretStoreError);
      expect((err as SecretStoreError).code).toBe(code);
      expect((err as SecretStoreError).hint).toBeTruthy();
    });
  }

  it('a failed write always throws, with a hint', async () => {
    const err = await failing('keychain is locked')
      .set('k', 'v')
      .catch((e: unknown) => e);
    expect((err as SecretStoreError).code).toBe('locked');
  });

  it('deleting a missing entry is fine, deleting a locked one is not', async () => {
    await expect(failing('No matching entry found').delete('k')).resolves.toBeUndefined();
    await expect(failing('keychain is locked').delete('k')).rejects.toBeInstanceOf(
      SecretStoreError,
    );
  });

  it('the `security` CLI treats exit 44 as a miss and everything else as a failure', async () => {
    const fail = (status: number, stderr: string) => {
      const s = new SecurityCliSecretStore(() => {
        throw Object.assign(new Error('exec failed'), { status, stderr });
      });
      return s;
    };
    expect(await fail(44, 'The specified item could not be found').get('k')).toBeNull();
    const err = await fail(36, 'User interaction is not allowed.')
      .get('k')
      .catch((e: unknown) => e);
    expect((err as SecretStoreError).code).toBe('denied');
  });

  it('createSecretStore explains itself when nothing is available', async () => {
    const err = await createSecretStore({
      home: t.home,
      env: {},
      loadKeyring: async () => null,
      securityAvailable: () => false,
      platform: 'linux',
    }).catch((e: unknown) => e);
    expect((err as SecretStoreError).code).toBe('unavailable');
    expect((err as SecretStoreError).message).toContain('not macOS');
    expect((err as SecretStoreError).hint).toContain('PAGR_INSECURE_FILE_STORE=1');
  });
});

describe('probeSecretStore', () => {
  const t = useTempHome();

  it('passes on a working store and leaves nothing behind', async () => {
    const s = new MemorySecretStore();
    expect(await probeSecretStore(s)).toEqual({ ok: true });
    expect(s.map.size).toBe(0);
  });

  it('reports a locked keychain with the unlock hint', async () => {
    class E {
      constructor(
        readonly service: string,
        readonly user: string,
      ) {}
      getPassword(): string | null {
        throw new Error('keychain is locked');
      }
      setPassword(): void {
        throw new Error('keychain is locked');
      }
      deleteCredential(): boolean {
        return true;
      }
    }
    const r = await probeSecretStore(new KeyringSecretStore(E));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('locked');
      expect(r.hint).toContain('unlock your login Keychain');
    }
  });

  it('catches a store that accepts writes but does not return them', async () => {
    const r = await probeSecretStore({
      kind: 'memory',
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('did not return the value');
  });

  it('reports a FileSecretStore that cannot write', async () => {
    const { chmodSync } = await import('node:fs');
    const s = new FileSecretStore(t.home);
    chmodSync(t.home, 0o500);
    try {
      const r = await probeSecretStore(s);
      if (!r.ok) expect(r.code).toBe('io');
    } finally {
      chmodSync(t.home, 0o700);
    }
  });
});
