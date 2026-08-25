import { describe, expect, it } from 'vitest';
import {
  deleteIdentity,
  generateKeyPairPem,
  loadOrCreateIdentity,
  PRIVATE_KEY_SECRET,
  publicKeyPemFromRaw,
  rawPublicKeyFromPem,
  signWithPem,
  verifyRaw,
} from './identity.js';
import { MemorySecretStore } from './keychain.js';

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
});
