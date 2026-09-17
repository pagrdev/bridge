import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '@pagr/protocol';
import { describe, expect, it } from 'vitest';
import { generateKeyPairPem } from './identity.js';
import {
  CONTENT_KEY_BYTES,
  generateRecipientKeyPair,
  importRecipientKeys,
  KID_PATTERN,
  keyFingerprint,
  MAX_SEAL_BODY_BYTES,
  NONCE_BYTES,
  OpenError,
  openFrame,
  type Recipient,
  recipientKeyIds,
  SEAL_CONTEXT,
  type SealAad,
  SealError,
  type SealedEnvelope,
  type SealRng,
  sealAadFor,
  sealedEnvelopeBound,
  sealFrame,
  trySealFrame,
  WRAP_BYTES,
  X25519_RAW_BYTES,
} from './seal.js';
import { MAX_FRAME_BYTES } from './transport.js';

/**
 * The vectors are read from disk rather than imported so this file stays honest about what is
 * on disk: the same bytes are copied verbatim into the platform and the iPhone, and a KAT that
 * a bundler rewrote would prove nothing.
 */
interface Vectors {
  version: number;
  recipients: Array<{
    label: string;
    kid: string;
    publicKeyB64u: string;
    publicKeyHex: string;
    privateKeyRawHex: string;
    privateKeyPkcs8B64: string;
  }>;
  cases: Array<{
    name: string;
    recipients: string[];
    rng: {
      ephemeralPrivateKeyHex: string;
      contentKeyHex: string;
      bodyNonceHex: string;
      wrapNoncesHex: string[];
    };
    aad: SealAad;
    canonicalAad: string;
    plaintextUtf8: string;
    plaintextHex: string;
    wrapKeysHex: string[];
    envelope: SealedEnvelope;
  }>;
  negative: Array<{
    name: string;
    case: string;
    openWith: string;
    aad: SealAad;
    envelope: SealedEnvelope;
    expect: string;
  }>;
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL('./__fixtures__/seal-vectors.json', import.meta.url), 'utf8'),
);
const vectorKey = (label: string) => {
  const r = vectors.recipients.find((x) => x.label === label);
  if (!r) throw new Error(`no vector recipient ${label}`);
  return r;
};

/** Feeds `sealFrame` a fixed script of bytes, in the documented draw order. */
const scriptedRng = (...chunks: Uint8Array[]): SealRng => {
  let i = 0;
  return (n) => {
    const next = chunks[i++];
    if (!next) throw new Error(`rng script exhausted at draw ${i}`);
    if (next.byteLength !== n)
      throw new Error(`draw ${i} wanted ${n} bytes, script has ${next.byteLength}`);
    return next;
  };
};
const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

const phone = (label: string): Recipient => {
  const v = vectorKey(label);
  return { kid: v.kid, publicKeyRaw: new Uint8Array(Buffer.from(v.publicKeyB64u, 'base64url')) };
};

const aadOf = (over: Partial<SealAad> = {}): SealAad => ({
  sessionId: `ses_${'a'.repeat(32)}`,
  seq: 7,
  kind: 'assistant',
  ...over,
});
const body = (text = 'the deploy finished; 2 warnings') => new TextEncoder().encode(text);

describe('sealAadFor', () => {
  it('is canonical: sorted keys, no whitespace, no absent chunk', () => {
    expect(sealAadFor(aadOf())).toBe(
      `{"kind":"assistant","seq":7,"sessionId":"ses_${'a'.repeat(32)}"}`,
    );
    expect(sealAadFor(aadOf({ chunk: { group: 'g1', index: 0, total: 2 } }))).toBe(
      `{"chunk":{"group":"g1","index":0,"total":2},"kind":"assistant","seq":7,"sessionId":"ses_${'a'.repeat(32)}"}`,
    );
    // Field order at the call site must not change a single byte of what is authenticated.
    expect(sealAadFor({ kind: 'diff', sessionId: 'ses_x', seq: 2 })).toBe(
      sealAadFor({ seq: 2, sessionId: 'ses_x', kind: 'diff' }),
    );
  });
});

describe('importRecipientKeys', () => {
  it('imports a pinned map into a set sorted by kid', () => {
    const a = generateRecipientKeyPair();
    const b = generateRecipientKeyPair();
    const set = importRecipientKeys({ [a.kid]: a.publicKeyB64u, [b.kid]: b.publicKeyB64u });
    expect(set.map((r) => r.kid)).toEqual([a.kid, b.kid].sort());
    expect(recipientKeyIds(set)).toEqual([a.kid, b.kid].sort());
    expect(recipientKeyIds({ [b.kid]: b.publicKeyB64u, [a.kid]: a.publicKeyB64u })).toEqual(
      [a.kid, b.kid].sort(),
    );
    for (const r of set) expect(r.publicKeyRaw.byteLength).toBe(X25519_RAW_BYTES);
  });

  it('refuses a key that does not fingerprint to the kid it is filed under (SEC-7 for phones)', () => {
    const a = generateRecipientKeyPair();
    const b = generateRecipientKeyPair();
    // A gateway that has been talked into serving an extra key must not be able to file it
    // under a key id the user has already verified out of band.
    expect(() => importRecipientKeys({ [a.kid]: b.publicKeyB64u })).toThrow(SealError);
    try {
      importRecipientKeys({ [a.kid]: b.publicKeyB64u });
    } catch (err) {
      expect((err as SealError).code).toBe('bad_key');
      expect((err as SealError).message).toContain(b.kid);
    }
  });

  it('refuses malformed key ids, non-base64url keys and wrong-length keys', () => {
    const a = generateRecipientKeyPair();
    const codes: string[] = [];
    for (const bad of [
      { 'not-a-kid': a.publicKeyB64u },
      { [a.kid]: 'not base64url!!' },
      { [a.kid]: Buffer.alloc(31).toString('base64url') },
    ]) {
      try {
        importRecipientKeys(bad);
        throw new Error('expected a SealError');
      } catch (err) {
        expect(err).toBeInstanceOf(SealError);
        codes.push((err as SealError).code);
      }
    }
    expect(codes).toEqual(['bad_key', 'bad_key', 'bad_key']);
  });

  it('accepts an empty map (a Mac with no phone paired)', () => {
    expect(importRecipientKeys({})).toEqual([]);
    expect(recipientKeyIds(importRecipientKeys({}))).toEqual([]);
  });

  it('derives kid exactly as the contract says', () => {
    for (const r of vectors.recipients) {
      expect(keyFingerprint(new Uint8Array(Buffer.from(r.publicKeyHex, 'hex')))).toBe(r.kid);
      expect(r.kid).toMatch(KID_PATTERN);
    }
  });
});

describe('sealFrame / openFrame round trip', () => {
  it('round-trips for one recipient', () => {
    const a = generateRecipientKeyPair();
    const aad = aadOf();
    const env = sealFrame(body(), aad, [{ kid: a.kid, publicKeyRaw: a.publicKeyRaw }]);
    expect(env.v).toBe(1);
    expect(env.recipients.map((r) => r.kid)).toEqual([a.kid]);
    expect(Buffer.from(env.epk, 'base64url')).toHaveLength(X25519_RAW_BYTES);
    expect(Buffer.from(env.nonce, 'base64url')).toHaveLength(NONCE_BYTES);
    expect(Buffer.from(env.recipients[0]?.wrap ?? '', 'base64url')).toHaveLength(WRAP_BYTES);
    expect(env.aad).toEqual(aad);
    expect(new TextDecoder().decode(openFrame(env, aad, a.privateKey))).toBe(
      'the deploy finished; 2 warnings',
    );
  });

  it('round-trips for three recipients, and each opens with its own key only', () => {
    const phones = [
      generateRecipientKeyPair(),
      generateRecipientKeyPair(),
      generateRecipientKeyPair(),
    ];
    const set = importRecipientKeys(
      Object.fromEntries(phones.map((p) => [p.kid, p.publicKeyB64u])),
    );
    const aad = aadOf({ kind: 'diff', seq: 12 });
    const env = sealFrame(body('diff of src/app.ts'), aad, set);
    expect(env.recipients).toHaveLength(3);
    expect(env.recipients.map((r) => r.kid)).toEqual(phones.map((p) => p.kid).sort());
    // One content key, three wraps: the ciphertext is stored once however many phones there are.
    expect(new Set(env.recipients.map((r) => r.wrap)).size).toBe(3);
    expect(new Set(env.recipients.map((r) => r.nonce)).size).toBe(3);
    for (const p of phones)
      expect(new TextDecoder().decode(openFrame(env, aad, p.privateKey))).toBe(
        'diff of src/app.ts',
      );
  });

  it('gives every envelope a fresh ephemeral key, content key and nonces', () => {
    const a = generateRecipientKeyPair();
    const aad = aadOf();
    const set = [{ kid: a.kid, publicKeyRaw: a.publicKeyRaw }];
    const one = sealFrame(body('same body'), aad, set);
    const two = sealFrame(body('same body'), aad, set);
    expect(one.epk).not.toBe(two.epk);
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.ct).not.toBe(two.ct);
  });

  it('skips sealing (null), never a half-sealed frame, when no phone is paired', () => {
    expect(trySealFrame(body(), aadOf(), [])).toBeNull();
    expect(() => sealFrame(body(), aadOf(), [])).toThrow(SealError);
    try {
      sealFrame(body(), aadOf(), []);
    } catch (err) {
      expect((err as SealError).code).toBe('no_recipients');
    }
  });

  it('refuses a body larger than the chunk size instead of earning a 1009 close', () => {
    const a = generateRecipientKeyPair();
    const set = [{ kid: a.kid, publicKeyRaw: a.publicKeyRaw }];
    expect(() => sealFrame(new Uint8Array(MAX_SEAL_BODY_BYTES + 1), aadOf(), set)).toThrow(
      SealError,
    );
    try {
      sealFrame(new Uint8Array(MAX_SEAL_BODY_BYTES + 1), aadOf(), set);
    } catch (err) {
      expect((err as SealError).code).toBe('oversize');
    }
    expect(() => sealFrame(new Uint8Array(MAX_SEAL_BODY_BYTES), aadOf(), set)).not.toThrow();
  });

  it('keeps a full-size envelope inside the gateway frame cap (BR-3)', () => {
    const phones = [
      generateRecipientKeyPair(),
      generateRecipientKeyPair(),
      generateRecipientKeyPair(),
    ];
    const set = importRecipientKeys(
      Object.fromEntries(phones.map((p) => [p.kid, p.publicKeyB64u])),
    );
    const env = sealFrame(new Uint8Array(MAX_SEAL_BODY_BYTES), aadOf(), set);
    const actual = Buffer.byteLength(JSON.stringify(env), 'utf8');
    expect(actual).toBeLessThanOrEqual(sealedEnvelopeBound(MAX_SEAL_BODY_BYTES, set.length));
    expect(sealedEnvelopeBound(MAX_SEAL_BODY_BYTES, set.length)).toBeLessThan(MAX_FRAME_BYTES);
    // Small bodies must be cheap too: three wraps is the whole per-recipient cost.
    const small = sealFrame(body('hi'), aadOf(), set);
    expect(Buffer.byteLength(JSON.stringify(small), 'utf8')).toBeLessThan(1200);
  });
});

describe('openFrame negatives', () => {
  const a = generateRecipientKeyPair();
  const set = [{ kid: a.kid, publicKeyRaw: a.publicKeyRaw }];
  const aad = aadOf();
  const env = () => sealFrame(body('secret plan'), aad, set);
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      if (err instanceof OpenError) return err.code;
      return `threw ${(err as Error).name}`;
    }
    return 'opened';
  };

  it('fails with the device signing key (Ed25519, not an X25519 key at all)', () => {
    // The gateway holds Ed25519 keys and nothing else; none of them is a key that can open a frame.
    expect(codeOf(() => openFrame(env(), aad, generateKeyPairPem().privateKeyPem))).toBe('bad_key');
    const ed = generateKeyPairSync('ed25519').privateKey;
    expect(codeOf(() => openFrame(env(), aad, ed))).toBe('bad_key');
  });

  it('fails with an X25519 key that is simply not a recipient', () => {
    const stranger = generateRecipientKeyPair();
    expect(codeOf(() => openFrame(env(), aad, stranger.privateKey))).toBe('not_a_recipient');
  });

  it('fails when the recipient slot is filed under another kid', () => {
    const e = env();
    const wrongKid = generateRecipientKeyPair().kid;
    e.recipients = [
      { ...(e.recipients[0] as { kid: string; nonce: string; wrap: string }), kid: wrongKid },
    ];
    expect(codeOf(() => openFrame(e, aad, a.privateKey))).toBe('not_a_recipient');
  });

  it('fails on a tampered ct, wrap, nonce or epk', () => {
    const flip = (s: string, i = 0) => {
      const b = Buffer.from(s, 'base64url');
      b[i] = (b[i] ?? 0) ^ 0x01;
      return b.toString('base64url');
    };
    const ctTampered = env();
    ctTampered.ct = flip(ctTampered.ct);
    expect(codeOf(() => openFrame(ctTampered, aad, a.privateKey))).toBe('bad_ct');

    const wrapTampered = env();
    const slot = wrapTampered.recipients[0] as { kid: string; nonce: string; wrap: string };
    wrapTampered.recipients = [{ ...slot, wrap: flip(slot.wrap) }];
    expect(codeOf(() => openFrame(wrapTampered, aad, a.privateKey))).toBe('bad_wrap');

    const nonceTampered = env();
    const slot2 = nonceTampered.recipients[0] as { kid: string; nonce: string; wrap: string };
    nonceTampered.recipients = [{ ...slot2, nonce: flip(slot2.nonce) }];
    expect(codeOf(() => openFrame(nonceTampered, aad, a.privateKey))).toBe('bad_wrap');

    const epkTampered = env();
    epkTampered.epk = flip(epkTampered.epk);
    expect(codeOf(() => openFrame(epkTampered, aad, a.privateKey))).toBe('bad_wrap');
  });

  it('fails for the wrong aad: another seq, another session, another kind', () => {
    const sealed = env();
    expect(codeOf(() => openFrame(sealed, { ...aad, seq: aad.seq + 1 }, a.privateKey))).toBe(
      'bad_wrap',
    );
    expect(
      codeOf(() => openFrame(sealed, { ...aad, sessionId: `ses_${'b'.repeat(32)}` }, a.privateKey)),
    ).toBe('bad_wrap');
    expect(codeOf(() => openFrame(sealed, { ...aad, kind: 'user' }, a.privateKey))).toBe(
      'bad_wrap',
    );
    // A chunk label that was never sealed in is a different AAD too.
    expect(
      codeOf(() =>
        openFrame(sealed, { ...aad, chunk: { group: 'g', index: 0, total: 2 } }, a.privateKey),
      ),
    ).toBe('bad_wrap');
  });

  it('cannot be re-labelled by the relay: the envelope carries its aad but does not define it', () => {
    const relabelled = env();
    relabelled.aad = { ...aad, seq: 999 };
    // Opening with what the envelope now CLAIMS fails — the AAD is authenticated by both layers.
    expect(codeOf(() => openFrame(relabelled, relabelled.aad, a.privateKey))).toBe('bad_wrap');
    // And the real AAD still opens it, so a re-label is detectable, not destructive.
    expect(new TextDecoder().decode(openFrame(relabelled, aad, a.privateKey))).toBe('secret plan');
  });

  it('rejects an envelope that is not a pagr.seal.v1 envelope', () => {
    const e = env() as unknown as Record<string, unknown>;
    expect(
      codeOf(() => openFrame({ ...e, v: 2 } as unknown as SealedEnvelope, aad, a.privateKey)),
    ).toBe('bad_envelope');
    expect(
      codeOf(() =>
        openFrame({ ...e, recipients: [] } as unknown as SealedEnvelope, aad, a.privateKey),
      ),
    ).toBe('bad_envelope');
    expect(codeOf(() => openFrame({} as unknown as SealedEnvelope, aad, a.privateKey))).toBe(
      'bad_envelope',
    );
  });
});

describe('known-answer vectors (the three implementations agree on these bytes)', () => {
  it('reproduces every case byte for byte from the scripted rng', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(0);
    for (const c of vectors.cases) {
      const rng = scriptedRng(
        hex(c.rng.ephemeralPrivateKeyHex),
        hex(c.rng.contentKeyHex),
        hex(c.rng.bodyNonceHex),
        ...c.rng.wrapNoncesHex.map(hex),
      );
      const set = c.recipients.map(phone);
      const env = sealFrame(hex(c.plaintextHex), c.aad, set, rng);
      expect(canonicalize(env), `${c.name}: envelope`).toBe(canonicalize(c.envelope));
      expect(sealAadFor(c.aad), `${c.name}: aad`).toBe(c.canonicalAad);
      expect(`${SEAL_CONTEXT}${c.canonicalAad}`.startsWith('pagr.seal.v1{')).toBe(true);
      expect(hex(c.rng.contentKeyHex).byteLength).toBe(CONTENT_KEY_BYTES);
    }
  });

  it('opens every case with every listed recipient private key', () => {
    for (const c of vectors.cases)
      for (const label of c.recipients) {
        const plain = openFrame(c.envelope, c.aad, hex(vectorKey(label).privateKeyRawHex));
        expect(new TextDecoder().decode(plain), `${c.name}/${label}`).toBe(c.plaintextUtf8);
        // The PKCS#8 form in the fixture must name the same key.
        const pkcs8 = new Uint8Array(Buffer.from(vectorKey(label).privateKeyPkcs8B64, 'base64'));
        expect(new TextDecoder().decode(openFrame(c.envelope, c.aad, pkcs8))).toBe(c.plaintextUtf8);
      }
  });

  it('are exactly what the generator produces (nobody hand-edited them)', () => {
    // The generator is a second, independent reading of the written contract; the fixture is the
    // agreement. If either moves without the other, this fails here rather than in three repos.
    const script = fileURLToPath(new URL('../scripts/gen-seal-vectors.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(`${run.stdout}${run.stderr}`).toContain('up to date');
    expect(run.status).toBe(0);
  });

  it('fails every negative case with the recorded reason', () => {
    expect(vectors.negative.length).toBeGreaterThanOrEqual(4);
    for (const n of vectors.negative) {
      let code = 'opened';
      try {
        openFrame(n.envelope, n.aad, hex(vectorKey(n.openWith).privateKeyRawHex));
      } catch (err) {
        code = err instanceof OpenError ? err.code : `threw ${(err as Error).name}`;
      }
      expect(code, n.name).toBe(n.expect);
    }
  });
});
