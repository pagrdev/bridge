import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from 'node:crypto';
import type { SecretStore } from './keychain.js';

export const PRIVATE_KEY_SECRET = 'device.private_key';

export interface DeviceIdentity {
  /** Assigned by the cloud at pairing; undefined before pairing. */
  deviceId?: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKeyRaw: string;
  sign(data: Uint8Array | string): string; // base64url signature
}

/** Ed25519 SPKI DER prefix: the last 32 bytes are the raw key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function rawPublicKeyFromPem(pem: string): string {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;
  return der.subarray(der.length - 32).toString('base64url');
}

export function publicKeyPemFromRaw(rawB64u: string): string {
  const raw = Buffer.from(rawB64u, 'base64url');
  if (raw.length !== 32) throw new Error('invalid raw ed25519 public key length');
  const der = Buffer.concat([SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, type: 'spki', format: 'der' })
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

export function generateKeyPairPem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function signWithPem(privateKeyPem: string, data: Uint8Array | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return cryptoSign(null, buf, createPrivateKey(privateKeyPem)).toString('base64url');
}

/** Verify a base64url Ed25519 signature against a base64url raw public key. */
export function verifyRaw(
  publicKeyRawB64u: string,
  data: Uint8Array | string,
  signatureB64u: string,
): boolean {
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return cryptoVerify(
      null,
      buf,
      createPublicKey(publicKeyPemFromRaw(publicKeyRawB64u)),
      Buffer.from(signatureB64u, 'base64url'),
    );
  } catch {
    return false;
  }
}

/**
 * Load the device identity from the secret store, generating and persisting a keypair on
 * first run. The private key never leaves the store except into process memory here.
 */
export async function loadOrCreateIdentity(
  store: SecretStore,
  opts: { deviceId?: string } = {},
): Promise<DeviceIdentity> {
  let pem = await store.get(PRIVATE_KEY_SECRET);
  if (!pem) {
    pem = generateKeyPairPem().privateKeyPem;
    await store.set(PRIVATE_KEY_SECRET, pem);
  }
  const privateKeyPem = pem;
  const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const identity: DeviceIdentity = {
    publicKeyRaw: rawPublicKeyFromPem(publicKeyPem),
    sign: (data) => signWithPem(privateKeyPem, data),
  };
  if (opts.deviceId) identity.deviceId = opts.deviceId;
  return identity;
}

export async function deleteIdentity(store: SecretStore): Promise<void> {
  await store.delete(PRIVATE_KEY_SECRET);
}
