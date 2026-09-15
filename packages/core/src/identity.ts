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
  // A store read that FAILS (locked Keychain, denied prompt) throws — it must never look like
  // "no key yet", or we would mint a second identity and overwrite a working pairing.
  let pem = await store.get(PRIVATE_KEY_SECRET);
  const created = !pem;
  if (!pem) {
    pem = generateKeyPairPem().privateKeyPem;
    await store.set(PRIVATE_KEY_SECRET, pem);
  }
  const privateKeyPem = pem;
  let publicKeyPem: string;
  try {
    publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'pem' })
      .toString();
  } catch (err) {
    throw new InvalidDeviceKeyError(
      `the stored pagr device key is not a usable Ed25519 private key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const identity: DeviceIdentity = {
    publicKeyRaw: rawPublicKeyFromPem(publicKeyPem),
    sign: (data) => signWithPem(privateKeyPem, data),
  };
  if (opts.deviceId) identity.deviceId = opts.deviceId;
  identityWasCreated.set(identity, created);
  return identity;
}

/**
 * A replacement device key that exists only in memory until `commit()`.
 *
 * `pagr connect --force` used to delete the working key and mint its replacement BEFORE the new
 * pairing existed. Any failure after that point — a 5xx, a denied approval, a Ctrl-C, a timeout —
 * left `config.json` holding the OLD deviceId while the only key on the machine was the new one,
 * so every signature failed `bad_signature` and the Mac was stranded with no way back. Staging
 * makes the swap atomic from the user's point of view: the old key stays exactly where it is
 * until the cloud has accepted the new one, and `rollback()` puts it back if the last step fails.
 */
export interface StagedIdentity {
  /** The new identity. Live in memory; NOT in the secret store until `commit()`. */
  identity: DeviceIdentity;
  /** Whether there was a previous key to restore. */
  replacesExistingKey: boolean;
  /** Persist the new key, replacing the old one. */
  commit(): Promise<void>;
  /** Undo `commit()` (or do nothing if it never ran). Safe to call in any state. */
  rollback(): Promise<void>;
}

export async function stageNewIdentity(store: SecretStore): Promise<StagedIdentity> {
  // Read the current key FIRST. A locked or denied Keychain throws here, before anything has
  // changed — the one safe moment to fail.
  const previous = await store.get(PRIVATE_KEY_SECRET);
  const { privateKeyPem, publicKeyPem } = generateKeyPairPem();
  let committed = false;
  return {
    identity: {
      publicKeyRaw: rawPublicKeyFromPem(publicKeyPem),
      sign: (data) => signWithPem(privateKeyPem, data),
    },
    replacesExistingKey: previous !== null,
    commit: async () => {
      await store.set(PRIVATE_KEY_SECRET, privateKeyPem);
      committed = true;
    },
    rollback: async () => {
      if (!committed) return;
      if (previous === null) await store.delete(PRIVATE_KEY_SECRET);
      else await store.set(PRIVATE_KEY_SECRET, previous);
      committed = false;
    },
  };
}

/** Whether `loadOrCreateIdentity` minted a brand-new key (vs. reusing the stored one). */
const identityWasCreated = new WeakMap<DeviceIdentity, boolean>();
export const wasNewlyCreated = (identity: DeviceIdentity): boolean =>
  identityWasCreated.get(identity) ?? false;

/** The stored key exists but is corrupt — a truncated Keychain item or a hand-edited file. */
export class InvalidDeviceKeyError extends Error {
  readonly hint =
    'run `pagr logout` then `pagr connect` to mint a fresh key (the old one is unusable)';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDeviceKeyError';
  }
}

/** Is a device private key present? Used by `doctor` to spot a config without its key. */
export async function hasIdentity(store: SecretStore): Promise<boolean> {
  return (await store.get(PRIVATE_KEY_SECRET)) !== null;
}

export async function deleteIdentity(store: SecretStore): Promise<void> {
  await store.delete(PRIVATE_KEY_SECRET);
}
