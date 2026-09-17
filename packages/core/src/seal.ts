import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import {
  canonicalize,
  SEAL_CONTEXT,
  SEAL_ENVELOPE_VERSION,
  SealAad as SealAadSchema,
  FrameChunk as SealChunkSchema,
  SealedEnvelope as SealedEnvelopeSchema,
  SealedRecipient as SealedRecipientSchema,
} from '@pagr/protocol';
import type { z } from 'zod';

/**
 * Sealed frames (`pagr.seal.v1`).
 *
 * The bridge is the only sealer in the system: it encrypts every transcript frame on this Mac
 * for the user's own phones, and the cloud relays ciphertext it cannot read. This module is the
 * source of truth for the format — the platform's `packages/security` and the iOS `PagrCore`
 * mirror it and prove they agree with the known-answer vectors in `__fixtures__/seal-vectors.json`.
 *
 * Per envelope:
 *
 *   1. mint an ephemeral X25519 key pair (`epk`) and a random 32-byte content key;
 *   2. `ct = ChaCha20-Poly1305(body, key: contentKey, nonce: 12 random, aad: canonicalize(aad))`,
 *      16-byte tag appended;
 *   3. for each recipient: `shared = X25519(eph, recipientPub)`,
 *      `wrapKey = HKDF-SHA256(ikm: shared, salt: epkRaw ‖ recipientPubRaw,
 *      info: 'pagr.seal.v1' + canonicalize(aad), len: 32)`, then
 *      `wrap = ChaCha20-Poly1305(contentKey, key: wrapKey, nonce: 12 random,
 *      aad: canonicalize(aad))` — 32 + 16 = 48 bytes.
 *
 * `aad` travels in the clear (the cloud indexes on it) and is authenticated by BOTH layers, so a
 * relay that re-labels a frame's session, sequence or kind cannot make it open.
 *
 * There is no HPKE here on purpose: HPKE would pull in a dependency, and this repo ships with
 * `node:crypto` only.
 */

/**
 * The wire contract lives in `@pagr/protocol` — one definition, byte-synced to the platform and
 * mirrored in Swift. This module owns the CRYPTO; the shapes it reads and writes are the
 * protocol's, re-exported here under the names this package has always used for them.
 */
export {
  /** Domain separator mixed into every wrap key. */
  SEAL_CONTEXT,
  SealAadSchema,
  SealChunkSchema,
  SealedEnvelopeSchema,
  SealedRecipientSchema,
};
/** Envelope format version. */
export const SEAL_VERSION = SEAL_ENVELOPE_VERSION;

export const CONTENT_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const X25519_RAW_BYTES = 32;
/** `wrap` is always the 32-byte content key plus its 16-byte tag. */
export const WRAP_BYTES = CONTENT_KEY_BYTES + TAG_BYTES;

/**
 * Largest body this module will seal. Callers chunk above it (MOB-032's `chunkFrame`), because a
 * sealed body is base64 on the wire and the gateway closes the socket on an oversized frame
 * rather than rejecting it politely (see `MAX_FRAME_BYTES` in `transport.ts`).
 */
export const MAX_SEAL_BODY_BYTES = 160 * 1024;

/** X25519 SPKI DER prefix: the last 32 bytes are the raw public key. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
/** X25519 PKCS#8 DER prefix: the last 32 bytes are the raw private scalar. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

// ---------- AAD ----------

/** A frame body split across several envelopes; every part carries the same `group`. */
export type SealChunk = z.infer<typeof SealChunkSchema>;

/** What both crypto layers authenticate, and what the cloud is allowed to read and index. */
export type SealAad = z.infer<typeof SealAadSchema>;

/**
 * The exact bytes signed into both AEAD layers: `canonicalize({sessionId, seq, kind, chunk?})`.
 * Sorted keys, no whitespace, `undefined` dropped — identical in Swift's `CanonicalJSON`.
 */
export function sealAadFor(meta: SealAad): string {
  return canonicalize({
    sessionId: meta.sessionId,
    seq: meta.seq,
    kind: meta.kind,
    ...(meta.chunk ? { chunk: meta.chunk } : {}),
  });
}

// ---------- envelope ----------

/** One phone's wrapped copy of the content key. */
export type SealedRecipient = z.infer<typeof SealedRecipientSchema>;

/** A sealed frame body as it travels: opaque to the cloud apart from its `aad`. */
export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;

/** `kid` shape: four colon-separated hex quads. The protocol's `KeyFingerprint` says the same. */
export const KID_PATTERN = /^[0-9a-f]{4}(:[0-9a-f]{4}){3}$/;

// ---------- recipients ----------

export interface Recipient {
  kid: string;
  /** Raw 32-byte X25519 public key. */
  publicKeyRaw: Uint8Array;
}

/** The phones that may open a frame, in a stable order (sorted by `kid`). */
export type RecipientKeySet = readonly Recipient[];

export type SealErrorCode =
  /** Nothing is pinned to seal for: the user has not paired a phone yet. */
  | 'no_recipients'
  /** A recipient key is not a usable 32-byte X25519 public key, or its `kid` does not match it. */
  | 'bad_key'
  /** The body is larger than `MAX_SEAL_BODY_BYTES`; the caller must chunk it. */
  | 'oversize';

export class SealError extends Error {
  constructor(
    readonly code: SealErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SealError';
  }
}

/** `sha256(rawX25519Pub).hex[0:16]` grouped by 4 with ':' — byte-identical to the cloud's. */
export function keyFingerprint(publicKeyRaw: Uint8Array): string {
  const hex = createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 16);
  return (hex.match(/.{4}/g) ?? []).join(':');
}

/**
 * Validate a pinned `kid → base64url X25519 public key` map into a usable recipient set.
 *
 * The `kid` is CHECKED, not trusted: it is a fingerprint of the key it labels, so a key set that
 * files someone else's key under a `kid` the user has verified is refused here rather than being
 * silently sealed for.
 */
export function importRecipientKeys(raw: Record<string, string>): RecipientKeySet {
  const out: Recipient[] = [];
  for (const kid of Object.keys(raw).sort()) {
    const b64u = raw[kid] ?? '';
    if (!KID_PATTERN.test(kid)) throw new SealError('bad_key', `not a pagr key id: ${kid}`);
    if (!/^[A-Za-z0-9_-]+$/.test(b64u))
      throw new SealError('bad_key', `recipient ${kid}: key is not base64url`);
    const publicKeyRaw = Buffer.from(b64u, 'base64url');
    if (publicKeyRaw.length !== X25519_RAW_BYTES)
      throw new SealError(
        'bad_key',
        `recipient ${kid}: expected a ${X25519_RAW_BYTES}-byte X25519 key, got ${publicKeyRaw.length}`,
      );
    try {
      publicKeyObject(publicKeyRaw);
    } catch (err) {
      throw new SealError(
        'bad_key',
        `recipient ${kid}: not a usable X25519 public key (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const derived = keyFingerprint(publicKeyRaw);
    if (derived !== kid)
      throw new SealError('bad_key', `recipient ${kid}: key fingerprints as ${derived}`);
    out.push({ kid, publicKeyRaw });
  }
  return out;
}

/** The pinned key ids, sorted — what `device.hello` v2 reports as `recipientKeyIds`. */
export function recipientKeyIds(recipients: RecipientKeySet | Record<string, string>): string[] {
  return Array.isArray(recipients)
    ? recipients.map((r) => r.kid)
    : Object.keys(recipients as Record<string, string>).sort();
}

// ---------- sealing ----------

/**
 * Randomness, injectable so the known-answer vectors are reproducible. Draws happen in exactly
 * this order and the vectors depend on it:
 *
 *   1. the 32-byte ephemeral X25519 private scalar,
 *   2. the 32-byte content key,
 *   3. the 12-byte body nonce,
 *   4. one 12-byte wrap nonce per recipient, in recipient order.
 */
export type SealRng = (bytes: number) => Uint8Array;

const systemRng: SealRng = (bytes) => randomBytes(bytes);

/**
 * Seal `body` for every recipient. Throws `SealError('no_recipients')` when the set is empty —
 * use `trySealFrame` where "no phone paired yet" is an ordinary state rather than a fault.
 */
export function sealFrame(
  body: Uint8Array,
  aad: SealAad,
  recipients: RecipientKeySet,
  rng: SealRng = systemRng,
): SealedEnvelope {
  if (recipients.length === 0)
    throw new SealError('no_recipients', 'no recipient keys are pinned; nothing can open a frame');
  if (body.byteLength > MAX_SEAL_BODY_BYTES)
    throw new SealError(
      'oversize',
      `body is ${body.byteLength} bytes; seal at most ${MAX_SEAL_BODY_BYTES} (chunk it first)`,
    );

  const canonicalAad = sealAadFor(aad);
  const aadBytes = Buffer.from(canonicalAad, 'utf8');
  const info = Buffer.from(`${SEAL_CONTEXT}${canonicalAad}`, 'utf8');

  const ephemeralPrivateRaw = draw(rng, X25519_RAW_BYTES, 'ephemeral private key');
  const ephemeralPrivate = privateKeyObject(ephemeralPrivateRaw);
  const epkRaw = rawPublicKey(createPublicKey(ephemeralPrivate));

  const contentKey = draw(rng, CONTENT_KEY_BYTES, 'content key');
  const bodyNonce = draw(rng, NONCE_BYTES, 'body nonce');
  const ct = aeadSeal(contentKey, bodyNonce, aadBytes, body);

  const wrapped: SealedRecipient[] = [];
  for (const recipient of recipients) {
    const shared = diffieHellman({
      privateKey: ephemeralPrivate,
      publicKey: publicKeyObject(recipient.publicKeyRaw),
    });
    const wrapKey = deriveWrapKey(shared, epkRaw, recipient.publicKeyRaw, info);
    const wrapNonce = draw(rng, NONCE_BYTES, `wrap nonce for ${recipient.kid}`);
    wrapped.push({
      kid: recipient.kid,
      nonce: Buffer.from(wrapNonce).toString('base64url'),
      wrap: Buffer.from(aeadSeal(wrapKey, wrapNonce, aadBytes, contentKey)).toString('base64url'),
    });
  }

  return {
    v: SEAL_VERSION,
    epk: Buffer.from(epkRaw).toString('base64url'),
    recipients: wrapped,
    nonce: Buffer.from(bodyNonce).toString('base64url'),
    ct: Buffer.from(ct).toString('base64url'),
    aad: { ...aad, ...(aad.chunk ? { chunk: { ...aad.chunk } } : {}) },
  };
}

/**
 * `sealFrame`, except that an empty recipient set is answered with `null` instead of an error.
 *
 * A Mac with no phone paired is a correct, ordinary state: frames are journaled locally and
 * nothing goes on the wire (`pagr doctor` says so). Every other `SealError` still throws.
 */
export function trySealFrame(
  body: Uint8Array,
  aad: SealAad,
  recipients: RecipientKeySet,
  rng: SealRng = systemRng,
): SealedEnvelope | null {
  if (recipients.length === 0) return null;
  return sealFrame(body, aad, recipients, rng);
}

/** Bytes the JSON envelope will occupy, never under-counting, for the frame-size budget. */
export function sealedEnvelopeBound(bodyBytes: number, recipientCount: number): number {
  const b64 = (n: number) => Math.ceil(n / 3) * 4;
  const perRecipient = 40 + KID_LENGTH + b64(NONCE_BYTES) + b64(WRAP_BYTES);
  const fixedKeys = 64;
  const aadRoom = 512;
  return (
    fixedKeys +
    b64(X25519_RAW_BYTES) +
    b64(NONCE_BYTES) +
    b64(bodyBytes + TAG_BYTES) +
    recipientCount * perRecipient +
    aadRoom
  );
}
const KID_LENGTH = 19;

// ---------- opening (tests and the vector generator only) ----------

export type OpenErrorCode =
  /** The key handed in is not an X25519 private key at all. */
  | 'bad_key'
  /** No `recipients[]` entry matches this key's `kid`. */
  | 'not_a_recipient'
  /** The wrap did not authenticate: wrong key, wrong AAD, or a tampered wrap. */
  | 'bad_wrap'
  /** The body did not authenticate: a tampered `ct`, or an AAD the body was not sealed under. */
  | 'bad_ct'
  /** The envelope is not a `pagr.seal.v1` envelope. */
  | 'bad_envelope';

export class OpenError extends Error {
  constructor(
    readonly code: OpenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenError';
  }
}

/**
 * Open a sealed envelope with a recipient's X25519 private key.
 *
 * **The daemon never calls this.** The bridge holds no recipient private key and has no reason
 * to read back what it sealed; only the phone opens frames. It is exported so the round-trip
 * tests, the known-answer vectors and `scripts/gen-seal-vectors.mjs` can prove the format,
 * and the platform keeps its own copy under `src/testing/` with a test that fails if any
 * service imports it.
 *
 * `aad` is what the CALLER expects, not what the envelope claims: the envelope's own `aad` is
 * relayed metadata and is never trusted here. Pass `env.aad` only when the point is to prove
 * that re-labelling a frame does not make it open.
 */
export function openFrame(
  env: SealedEnvelope,
  aad: SealAad | string,
  recipientPrivateKey: string | Uint8Array | KeyObject,
): Uint8Array {
  const parsed = SealedEnvelopeSchema.safeParse(env);
  if (!parsed.success)
    throw new OpenError(
      'bad_envelope',
      `not a pagr.seal.v1 envelope: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );

  let privateKey: KeyObject;
  let publicKeyRaw: Uint8Array;
  try {
    privateKey = toX25519PrivateKey(recipientPrivateKey);
    publicKeyRaw = rawPublicKey(createPublicKey(privateKey));
  } catch (err) {
    throw new OpenError(
      'bad_key',
      `not a usable X25519 private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const kid = keyFingerprint(publicKeyRaw);
  const slot = env.recipients.find((r) => r.kid === kid);
  if (!slot)
    throw new OpenError(
      'not_a_recipient',
      `this key (${kid}) is not one of the envelope's recipients (${env.recipients
        .map((r) => r.kid)
        .join(', ')})`,
    );

  const canonicalAad = typeof aad === 'string' ? aad : sealAadFor(aad);
  const aadBytes = Buffer.from(canonicalAad, 'utf8');
  const info = Buffer.from(`${SEAL_CONTEXT}${canonicalAad}`, 'utf8');

  const epkRaw = Buffer.from(env.epk, 'base64url');
  if (epkRaw.length !== X25519_RAW_BYTES)
    throw new OpenError('bad_envelope', `epk is ${epkRaw.length} bytes, expected 32`);

  let wrapKey: Uint8Array;
  try {
    const shared = diffieHellman({ privateKey, publicKey: publicKeyObject(epkRaw) });
    wrapKey = deriveWrapKey(shared, epkRaw, publicKeyRaw, info);
  } catch (err) {
    throw new OpenError(
      'bad_envelope',
      `epk is not a usable X25519 public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const wrap = Buffer.from(slot.wrap, 'base64url');
  if (wrap.length !== WRAP_BYTES)
    throw new OpenError('bad_wrap', `wrap is ${wrap.length} bytes, expected ${WRAP_BYTES}`);
  let contentKey: Uint8Array;
  try {
    contentKey = aeadOpen(wrapKey, Buffer.from(slot.nonce, 'base64url'), aadBytes, wrap);
  } catch {
    throw new OpenError('bad_wrap', 'the wrapped content key did not authenticate');
  }

  try {
    return aeadOpen(
      contentKey,
      Buffer.from(env.nonce, 'base64url'),
      aadBytes,
      Buffer.from(env.ct, 'base64url'),
    );
  } catch {
    throw new OpenError('bad_ct', 'the sealed body did not authenticate');
  }
}

/** A fresh X25519 pair in the shapes this module uses. Tests and the vector generator only. */
export function generateRecipientKeyPair(): {
  kid: string;
  publicKeyRaw: Uint8Array;
  publicKeyB64u: string;
  privateKey: KeyObject;
  privateKeyRaw: Uint8Array;
} {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const publicKeyRaw = rawPublicKey(publicKey);
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    kid: keyFingerprint(publicKeyRaw),
    publicKeyRaw,
    publicKeyB64u: Buffer.from(publicKeyRaw).toString('base64url'),
    privateKey,
    privateKeyRaw: der.subarray(der.length - X25519_RAW_BYTES),
  };
}

// ---------- primitives ----------

function draw(rng: SealRng, bytes: number, what: string): Uint8Array {
  const out = rng(bytes);
  if (out.byteLength !== bytes)
    throw new SealError('bad_key', `rng returned ${out.byteLength} bytes for the ${what}`);
  return out;
}

function deriveWrapKey(
  shared: Uint8Array,
  epkRaw: Uint8Array,
  recipientPubRaw: Uint8Array,
  info: Uint8Array,
): Uint8Array {
  const salt = Buffer.concat([Buffer.from(epkRaw), Buffer.from(recipientPubRaw)]);
  return new Uint8Array(hkdfSync('sha256', shared, salt, info, CONTENT_KEY_BYTES));
}

function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  // `plaintextLength` is only load-bearing for CCM, but the OCB-family typings ask for it.
  cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
): Uint8Array {
  if (sealed.byteLength < TAG_BYTES) throw new Error('too short to carry a tag');
  const body = sealed.subarray(0, sealed.byteLength - TAG_BYTES);
  const tag = sealed.subarray(sealed.byteLength - TAG_BYTES);
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad, { plaintextLength: body.byteLength });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function publicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    type: 'spki',
    format: 'der',
  });
}

export function privateKeyObject(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]),
    type: 'pkcs8',
    format: 'der',
  });
}

export function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - X25519_RAW_BYTES);
}

function toX25519PrivateKey(key: string | Uint8Array | KeyObject): KeyObject {
  const obj =
    typeof key === 'string'
      ? createPrivateKey(key)
      : key instanceof Uint8Array
        ? key.byteLength === X25519_RAW_BYTES
          ? privateKeyObject(key)
          : createPrivateKey({ key: Buffer.from(key), format: 'der', type: 'pkcs8' })
        : key;
  if (obj.asymmetricKeyType !== 'x25519')
    throw new Error(`key is ${obj.asymmetricKeyType ?? 'of an unknown type'}, not x25519`);
  return obj;
}
