import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSecretStore,
  FileSecretStore,
  KeyringSecretStore,
  MemorySecretStore,
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

  it('SecurityCliSecretStore shells to /usr/bin/security with argv arrays', async () => {
    const argv: string[][] = [];
    const db = new Map<string, string>();
    const exec = (file: string, args: string[]) => {
      expect(file).toBe('/usr/bin/security');
      argv.push(args);
      const acct = args[args.indexOf('-a') + 1] ?? '';
      if (args[0] === 'find-generic-password') {
        const v = db.get(acct);
        if (v === undefined) throw new Error('not found');
        return `${v}\n`;
      }
      if (args[0] === 'add-generic-password') {
        db.set(acct, args[args.indexOf('-w') + 1] ?? '');
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
    ).rejects.toThrow(/No secure secret store/);
    const c = await createSecretStore({
      home: t.home,
      env: { PAGR_INSECURE_FILE_STORE: '1' },
      loadKeyring: async () => null,
    });
    expect(c.kind).toBe('file');
  });
});
