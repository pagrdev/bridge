#!/usr/bin/env node
/**
 * Regenerate `packages/core/src/__fixtures__/seal-vectors.json`.
 *
 *   node packages/core/scripts/gen-seal-vectors.mjs          # write the file
 *   node packages/core/scripts/gen-seal-vectors.mjs --check  # fail if it would change
 *
 * Three implementations of `pagr.seal.v1` have to agree: this bridge (`src/seal.ts`), the
 * platform (`packages/security`) and the iPhone (`PagrCore`). The vectors are what they agree
 * ON, so this generator deliberately does NOT import `seal.ts` — it is a second, independent
 * reading of the written contract in `docs/mobile/BUILD-PLAN.md § Shared contract`, using
 * `node:crypto` and nothing else. If the two implementations ever diverge, the known-answer test
 * in `seal.test.ts` fails instead of three codebases quietly drifting apart.
 *
 * Every byte string below is derived from a printable label with SHA-256, so the file
 * regenerates identically on any machine and every value can be traced back to its source.
 * None of this key material is secret and none of it is ever used outside tests.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  '__fixtures__',
  'seal-vectors.json',
);

const SEAL_CONTEXT = 'pagr.seal.v1';
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

// ---------- the contract, re-read ----------

const canonicalize = (value) => JSON.stringify(sortKeys(value));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');
const bytes = (label, n = 32) => createHash('sha256').update(label).digest().subarray(0, n);

const pub = (raw) =>
  createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    type: 'spki',
    format: 'der',
  });
const priv = (raw) =>
  createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]),
    type: 'pkcs8',
    format: 'der',
  });
const rawPub = (key) => {
  const der = key.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32);
};
const fingerprint = (rawPublicKey) =>
  createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16).match(/.{4}/g).join(':');

const aeadSeal = (key, nonce, aad, plaintext) => {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
};
const aeadOpen = (key, nonce, aad, sealed) => {
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
};

const wrapKeyFor = (ephPrivate, recipientPubRaw, epkRaw, canonicalAad) =>
  Buffer.from(
    hkdfSync(
      'sha256',
      diffieHellman({ privateKey: ephPrivate, publicKey: pub(recipientPubRaw) }),
      Buffer.concat([Buffer.from(epkRaw), Buffer.from(recipientPubRaw)]),
      Buffer.from(`${SEAL_CONTEXT}${canonicalAad}`, 'utf8'),
      32,
    ),
  );

/** `aad` is what the opener EXPECTS; the envelope's own copy is never trusted. */
function open(env, aadObject, recipientPrivateRaw) {
  const canonicalAad = canonicalize(aadObject);
  const aad = Buffer.from(canonicalAad, 'utf8');
  const key = priv(recipientPrivateRaw);
  const myPub = rawPub(createPublicKey(key));
  const slot = env.recipients.find((r) => r.kid === fingerprint(myPub));
  if (!slot) return 'not_a_recipient';
  const epkRaw = unb64u(env.epk);
  const wk = Buffer.from(
    hkdfSync(
      'sha256',
      diffieHellman({ privateKey: key, publicKey: pub(epkRaw) }),
      Buffer.concat([epkRaw, Buffer.from(myPub)]),
      Buffer.from(`${SEAL_CONTEXT}${canonicalAad}`, 'utf8'),
      32,
    ),
  );
  let contentKey;
  try {
    contentKey = aeadOpen(wk, unb64u(slot.nonce), aad, unb64u(slot.wrap));
  } catch {
    return 'bad_wrap';
  }
  try {
    return aeadOpen(contentKey, unb64u(env.nonce), aad, unb64u(env.ct));
  } catch {
    return 'bad_ct';
  }
}

// ---------- fixed material ----------

const RECIPIENTS = ['phone-a', 'phone-b'].map((label) => {
  const privateKeyRaw = bytes(`pagr.seal.v1 vectors recipient ${label}`);
  const publicKeyRaw = rawPub(createPublicKey(priv(privateKeyRaw)));
  return {
    label,
    kid: fingerprint(publicKeyRaw),
    publicKeyB64u: b64u(publicKeyRaw),
    publicKeyHex: Buffer.from(publicKeyRaw).toString('hex'),
    /** Present so any implementation can OPEN the vectors, not only reproduce them. */
    privateKeyRawHex: Buffer.from(privateKeyRaw).toString('hex'),
    privateKeyPkcs8B64: priv(privateKeyRaw)
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64'),
  };
});
const byLabel = Object.fromEntries(RECIPIENTS.map((r) => [r.label, r]));

/** Recipient order inside an envelope is the pinned set sorted by `kid`. */
const sortedLabels = (labels) =>
  [...labels].sort((a, b) => (byLabel[a].kid < byLabel[b].kid ? -1 : 1));

function buildCase({ name, labels, aad, plaintext, seed }) {
  const order = sortedLabels(labels);
  const ephemeralPrivateRaw = bytes(`pagr.seal.v1 vectors ephemeral ${seed}`);
  const ephPrivate = priv(ephemeralPrivateRaw);
  const epkRaw = rawPub(createPublicKey(ephPrivate));
  const contentKey = bytes(`pagr.seal.v1 vectors content key ${seed}`);
  const bodyNonce = bytes(`pagr.seal.v1 vectors body nonce ${seed}`, 12);
  const wrapNonces = order.map((label) =>
    bytes(`pagr.seal.v1 vectors wrap nonce ${seed} ${label}`, 12),
  );

  const canonicalAad = canonicalize(aad);
  const aadBytes = Buffer.from(canonicalAad, 'utf8');
  const body = Buffer.from(plaintext, 'utf8');
  const ct = aeadSeal(contentKey, bodyNonce, aadBytes, body);

  const wrapKeys = order.map((label) =>
    wrapKeyFor(ephPrivate, unb64u(byLabel[label].publicKeyB64u), epkRaw, canonicalAad),
  );
  const recipients = order.map((label, i) => ({
    kid: byLabel[label].kid,
    nonce: b64u(wrapNonces[i]),
    wrap: b64u(aeadSeal(wrapKeys[i], wrapNonces[i], aadBytes, contentKey)),
  }));

  const envelope = {
    v: 1,
    epk: b64u(epkRaw),
    recipients,
    nonce: b64u(bodyNonce),
    ct: b64u(ct),
    aad,
  };

  for (const label of order) {
    const got = open(envelope, aad, Buffer.from(byLabel[label].privateKeyRawHex, 'hex'));
    if (!Buffer.isBuffer(got) || got.toString('utf8') !== plaintext)
      throw new Error(`${name}: ${label} could not open its own envelope`);
  }

  return {
    name,
    recipients: order,
    rng: {
      /** Draw order: ephemeral scalar, content key, body nonce, then one wrap nonce per recipient. */
      ephemeralPrivateKeyHex: Buffer.from(ephemeralPrivateRaw).toString('hex'),
      contentKeyHex: Buffer.from(contentKey).toString('hex'),
      bodyNonceHex: Buffer.from(bodyNonce).toString('hex'),
      wrapNoncesHex: wrapNonces.map((n) => Buffer.from(n).toString('hex')),
    },
    aad,
    canonicalAad,
    plaintextUtf8: plaintext,
    plaintextHex: body.toString('hex'),
    wrapKeysHex: wrapKeys.map((k) => k.toString('hex')),
    envelope,
  };
}

const cases = [
  buildCase({
    name: 'one recipient',
    labels: ['phone-a'],
    seed: '1',
    aad: { sessionId: `ses_${'1'.repeat(32)}`, seq: 1, kind: 'assistant' },
    plaintext: JSON.stringify({ text: 'the migration is applied; 3 tests still fail' }),
  }),
  buildCase({
    name: 'two recipients, chunked body',
    labels: ['phone-b', 'phone-a'],
    seed: '2',
    aad: {
      sessionId: `ses_${'2'.repeat(32)}`,
      seq: 41,
      kind: 'terminal',
      chunk: { group: 'grp_7f3a', index: 1, total: 3 },
    },
    plaintext: JSON.stringify({ command: 'pnpm gate', stdout: 'ok\n', exitCode: 0 }),
  }),
];

// ---------- negative cases ----------

const flip = (s, index) => {
  const b = unb64u(s);
  b[index] ^= 0x01;
  return b64u(b);
};
const clone = (v) => JSON.parse(JSON.stringify(v));

function negative(name, caseName, openWith, mutate, aadOverride, expect) {
  const base = cases.find((c) => c.name === caseName);
  const envelope = mutate ? mutate(clone(base.envelope)) : clone(base.envelope);
  const aad = aadOverride ?? base.aad;
  const got = open(envelope, aad, Buffer.from(byLabel[openWith].privateKeyRawHex, 'hex'));
  if (got !== expect)
    throw new Error(
      `${name}: expected ${expect}, got ${Buffer.isBuffer(got) ? 'a plaintext' : got}`,
    );
  return { name, case: caseName, openWith, aad, envelope, expect };
}

const one = cases[0];
const negatives = [
  negative(
    'a key that is not a recipient',
    'one recipient',
    'phone-b',
    null,
    null,
    'not_a_recipient',
  ),
  negative(
    'tampered ct',
    'one recipient',
    'phone-a',
    (e) => ({ ...e, ct: flip(e.ct, 0) }),
    null,
    'bad_ct',
  ),
  negative(
    'tampered wrap',
    'one recipient',
    'phone-a',
    (e) => ({ ...e, recipients: [{ ...e.recipients[0], wrap: flip(e.recipients[0].wrap, 0) }] }),
    null,
    'bad_wrap',
  ),
  negative(
    'tampered epk',
    'one recipient',
    'phone-a',
    (e) => ({ ...e, epk: flip(e.epk, 0) }),
    null,
    'bad_wrap',
  ),
  negative(
    'wrong aad: seq + 1',
    'one recipient',
    'phone-a',
    null,
    { ...one.aad, seq: one.aad.seq + 1 },
    'bad_wrap',
  ),
  negative(
    'wrong aad: another session',
    'one recipient',
    'phone-a',
    null,
    { ...one.aad, sessionId: `ses_${'9'.repeat(32)}` },
    'bad_wrap',
  ),
  negative(
    'wrong aad: another kind',
    'one recipient',
    'phone-a',
    null,
    { ...one.aad, kind: 'user' },
    'bad_wrap',
  ),
  // The relay re-labels the frame and hands the phone its own metadata back. The AAD is
  // authenticated by both layers, so the re-labelled envelope simply does not open.
  negative(
    'relabelled envelope, opened with the label it claims',
    'one recipient',
    'phone-a',
    (e) => ({ ...e, aad: { ...e.aad, seq: 999 } }),
    { ...one.aad, seq: 999 },
    'bad_wrap',
  ),
];

// ---------- write ----------

const vectors = {
  $comment:
    'Known-answer vectors for pagr.seal.v1. Generated by packages/core/scripts/gen-seal-vectors.mjs — do not hand-edit. Copied verbatim to platform/packages/security/src/__fixtures__/ and apps/ios/Packages/PagrCore/Tests/Fixtures/. All key material here is test-only and public.',
  version: 1,
  algorithm: {
    kem: 'X25519 (ephemeral per envelope)',
    kdf: 'HKDF-SHA256',
    aead: 'ChaCha20-Poly1305, 12-byte nonce, 16-byte tag appended',
    info: `${SEAL_CONTEXT} + canonicalize(aad)`,
    salt: 'epkRaw || recipientPublicKeyRaw',
    kid: "sha256(rawX25519PublicKey).hex[0:16], grouped by 4 with ':'",
    recipientOrder: 'the pinned key set sorted by kid',
    rngDrawOrder: [
      'ephemeralPrivateKey(32)',
      'contentKey(32)',
      'bodyNonce(12)',
      'wrapNonce(12) per recipient',
    ],
  },
  recipients: RECIPIENTS,
  cases,
  negative: negatives,
};

const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== text) {
    process.stderr.write(
      'seal-vectors.json is out of date; run node packages/core/scripts/gen-seal-vectors.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write('seal-vectors.json is up to date\n');
} else {
  writeFileSync(OUT, text);
  process.stdout.write(`wrote ${OUT} (${cases.length} cases, ${negatives.length} negative)\n`);
}
