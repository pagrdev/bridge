import { describe, expect, it } from 'vitest';
import {
  deleteIdentity,
  generateKeyPairPem,
  hasIdentity,
  InvalidDeviceKeyError,
  loadOrCreateIdentity,
  PRIVATE_KEY_SECRET,
  publicKeyPemFromRaw,
  rawPublicKeyFromPem,
  signWithPem,
  stageNewIdentity,
  verifyRaw,
} from './identity.js';
import { MemorySecretStore, SecretStoreError } from './keychain.js';

describe('staged identity (`pagr connect --force`)', () => {
  const store = () => new MemorySecretStore();

  it('leaves the working key in place until commit', async () => {
    const s = store();
    const old = await loadOrCreateIdentity(s);
    const oldPem = s.map.get(PRIVATE_KEY_SECRET);

    const staged = await stageNewIdentity(s);
    expect(staged.replacesExistingKey).toBe(true);
    expect(staged.identity.publicKeyRaw).not.toBe(old.publicKeyRaw);
    // Nothing was written: a pairing that fails now leaves the Mac exactly as it was.
    expect(s.map.get(PRIVATE_KEY_SECRET)).toBe(oldPem);
    const reloaded = await loadOrCreateIdentity(s);
    expect(reloaded.publicKeyRaw).toBe(old.publicKeyRaw);

    await staged.commit();
    expect(s.map.get(PRIVATE_KEY_SECRET)).not.toBe(oldPem);
    expect((await loadOrCreateIdentity(s)).publicKeyRaw).toBe(staged.identity.publicKeyRaw);
  });

  it('rollback puts the previous key back after a commit', async () => {
    const s = store();
    const old = await loadOrCreateIdentity(s);
    const staged = await stageNewIdentity(s);
    await staged.commit();
    await staged.rollback();
    expect((await loadOrCreateIdentity(s)).publicKeyRaw).toBe(old.publicKeyRaw);
  });

  it('rollback before commit changes nothing, and is idempotent', async () => {
    const s = store();
    const old = await loadOrCreateIdentity(s);
    const staged = await stageNewIdentity(s);
    await staged.rollback();
    await staged.rollback();
    expect((await loadOrCreateIdentity(s)).publicKeyRaw).toBe(old.publicKeyRaw);
  });

  it('on a machine with no key at all, rollback removes the staged one', async () => {
    const s = store();
    const staged = await stageNewIdentity(s);
    expect(staged.replacesExistingKey).toBe(false);
    await staged.commit();
    expect(await hasIdentity(s)).toBe(true);
    await staged.rollback();
    expect(await hasIdentity(s)).toBe(false);
  });

  it('the staged identity signs verifiably with its own key', async () => {
    const staged = await stageNewIdentity(store());
    const sig = staged.identity.sign('dev_x.nonce');
    expect(verifyRaw(staged.identity.publicKeyRaw, 'dev_x.nonce', sig)).toBe(true);
  });
});

describe('identity', () => {
  it('creates a keypair on first load and reuses it after', async () => {
    const store = new MemorySecretStore();
    const a = await loadOrCreateIdentity(store);
    expect(store.map.get(PRIVATE_KEY_SECRET)).toMatch(/BEGIN PRIVATE KEY/);
    const b = await loadOrCreateIdentity(store, { deviceId: 'dev_x' });
    expect(b.publicKeyRaw).toBe(a.publicKeyRaw);
    expect(b.deviceId).toBe('dev_x');
    expect(a.deviceId).toBeUndefined();
    expect(Buffer.from(a.publicKeyRaw, 'base64url').length).toBe(32);
  });

  it('signatures verify with raw public key and fail on tamper', async () => {
    const id = await loadOrCreateIdentity(new MemorySecretStore());
    const sig = id.sign('dev_x.nonce');
    expect(verifyRaw(id.publicKeyRaw, 'dev_x.nonce', sig)).toBe(true);
    expect(verifyRaw(id.publicKeyRaw, 'dev_x.nonce2', sig)).toBe(false);
    expect(verifyRaw(id.publicKeyRaw, 'dev_x.nonce', 'garbage')).toBe(false);
  });

  it('raw <-> pem round trip', () => {
    const { privateKeyPem, publicKeyPem } = generateKeyPairPem();
    const raw = rawPublicKeyFromPem(publicKeyPem);
    expect(publicKeyPemFromRaw(raw)).toBe(publicKeyPem);
    expect(verifyRaw(raw, 'x', signWithPem(privateKeyPem, 'x'))).toBe(true);
  });

  it('deleteIdentity removes the private key', async () => {
    const store = new MemorySecretStore();
    await loadOrCreateIdentity(store);
    await deleteIdentity(store);
    expect(await store.get(PRIVATE_KEY_SECRET)).toBeNull();
  });

  it('hasIdentity reflects whether a key is stored', async () => {
    const store = new MemorySecretStore();
    expect(await hasIdentity(store)).toBe(false);
    await loadOrCreateIdentity(store);
    expect(await hasIdentity(store)).toBe(true);
  });

  it('a store read that FAILS never mints a replacement key', async () => {
    // The whole point: a locked Keychain must not look like "no key yet", or `connect` would
    // silently create a second identity and overwrite a working pairing.
    const writes: string[] = [];
    const store = {
      kind: 'keyring' as const,
      get: async () => {
        throw new SecretStoreError('locked', 'keychain is locked');
      },
      set: async (_k: string, v: string) => {
        writes.push(v);
      },
      delete: async () => {},
    };
    await expect(loadOrCreateIdentity(store)).rejects.toBeInstanceOf(SecretStoreError);
    expect(writes).toEqual([]);
  });

  it('a corrupt stored key is reported, not thrown raw', async () => {
    const store = new MemorySecretStore();
    await store.set(PRIVATE_KEY_SECRET, 'not a pem at all');
    const err = await loadOrCreateIdentity(store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidDeviceKeyError);
    expect((err as InvalidDeviceKeyError).hint).toContain('pagr logout');
  });
});
