import type { DeviceEvent } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { type GuardContext, IdempotencyCache, verifyIncoming } from './commandGuard.js';
import { ReplayCache } from './replay.js';
import { FakeServerSigner, ids, makeBody } from './testFixtures.js';

describe('verifyIncoming authorization matrix', () => {
  const deviceId = ids.dev();
  const projectId = ids.proj();
  const sessionId = ids.ses();
  let signer: FakeServerSigner;
  let ctx: GuardContext;
  let now: Date;

  beforeEach(() => {
    signer = new FakeServerSigner();
    now = new Date('2026-08-24T12:00:00Z');
    ctx = {
      deviceId,
      trustedServerKeys: signer.trustedKeys,
      now: () => now,
      replay: new ReplayCache({ now: () => now.getTime() }),
      idempotency: new IdempotencyCache(),
      registry: { has: (id: string) => id === projectId },
      sessions: { has: (id: string) => id === sessionId },
    };
  });

  const start = (o: Partial<Parameters<typeof makeBody>[2]> = {}, proj = projectId) =>
    makeBody(
      'agent.start_session',
      {
        provider: 'codex',
        projectId: proj,
        instruction: 'do it',
        sessionId: ids.ses(),
        attachments: [],
        readOnly: false,
      },
      { deviceId, now, ...o },
    );

  it('accepts a correct command', () => {
    const r = verifyIncoming(signer.sign(start()), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.duplicate).toBe(false);
  });

  it('rejects malformed envelope / payload with invalid_payload', () => {
    expect(verifyIncoming(null, ctx)).toMatchObject({ ok: false, errorCode: 'invalid_payload' });
    expect(verifyIncoming({ body: {}, keyId: 'k1', signature: 'x' }, ctx)).toMatchObject({
      ok: false,
      errorCode: 'invalid_payload',
    });
    // unknown command type
    const body = { ...start(), type: 'shell.exec', payload: { cmd: 'rm -rf /' } };
    expect(verifyIncoming(signer.sign(body), ctx)).toMatchObject({
      ok: false,
      errorCode: 'invalid_payload',
    });
  });

  it('rejects a filesystem path used as a project id (schema)', () => {
    const body = start({}, '/Users/waleed/code');
    const r = verifyIncoming(signer.sign(body), ctx);
    expect(r).toMatchObject({ ok: false, errorCode: 'invalid_payload' });
    if (!r.ok) expect(r.commandId).toBe(body.commandId);
  });

  it('rejects unknown keyId and bad/tampered signatures', () => {
    const env = signer.sign(start());
    expect(verifyIncoming({ ...env, keyId: 'k9' }, ctx)).toMatchObject({
      ok: false,
      errorCode: 'bad_signature',
    });
    const other = new FakeServerSigner('k1');
    expect(verifyIncoming(other.sign(start()), ctx)).toMatchObject({
      ok: false,
      errorCode: 'bad_signature',
    });
    const tampered = {
      ...env,
      body: {
        ...(env.body as object),
        payload: { ...(env.body as { payload: object }).payload, instruction: 'evil' },
      },
    };
    expect(verifyIncoming(tampered, ctx)).toMatchObject({ ok: false, errorCode: 'bad_signature' });
  });

  it('rejects a command bound to another device', () => {
    const r = verifyIncoming(signer.sign(start({ deviceId: ids.dev() })), ctx);
    expect(r).toMatchObject({ ok: false, errorCode: 'wrong_device' });
  });

  it('rejects expired and far-future commands', () => {
    const expired = start({ now: new Date(now.getTime() - 120_000), ttlMs: 60_000 });
    expect(verifyIncoming(signer.sign(expired), ctx)).toMatchObject({
      ok: false,
      errorCode: 'expired',
    });
    const future = start({ now: new Date(now.getTime() + 3 * 60_000) });
    expect(verifyIncoming(signer.sign(future), ctx)).toMatchObject({
      ok: false,
      errorCode: 'expired',
    });
    const slightlyFuture = start({ now: new Date(now.getTime() + 60_000) });
    expect(verifyIncoming(signer.sign(slightlyFuture), ctx).ok).toBe(true);
  });

  it('rejects replayed nonce / commandId, but returns cached ack for idempotent retry', () => {
    const body = start();
    const env = signer.sign(body);
    expect(verifyIncoming(env, ctx).ok).toBe(true);
    expect(verifyIncoming(env, ctx)).toMatchObject({ ok: false, errorCode: 'replayed' });
    // same nonce, different commandId → still replayed
    const env2 = signer.sign(start({ nonce: body.nonce }));
    expect(verifyIncoming(env2, ctx)).toMatchObject({ ok: false, errorCode: 'replayed' });
    // once an ack is cached under the idempotency key, the retry is a duplicate with that ack
    const ack = { eventId: 'e' } as unknown as DeviceEvent;
    ctx.idempotency.set(body.idempotencyKey, ack);
    const r = verifyIncoming(env, ctx);
    expect(r.ok && r.duplicate && r.cachedAck).toBe(ack);
    // a fresh nonce/commandId with the same idempotency key is also a duplicate
    const r2 = verifyIncoming(signer.sign(start({ idempotencyKey: body.idempotencyKey })), ctx);
    expect(r2.ok && r2.duplicate).toBe(true);
  });

  it('rejects unknown project and unknown session', () => {
    expect(verifyIncoming(signer.sign(start({}, ids.proj())), ctx)).toMatchObject({
      ok: false,
      errorCode: 'unknown_project',
    });
    const send = makeBody(
      'agent.send_instruction',
      { sessionId: ids.ses(), instruction: 'x', mode: 'auto', attachments: [] },
      { deviceId, now },
    );
    expect(verifyIncoming(signer.sign(send), ctx)).toMatchObject({
      ok: false,
      errorCode: 'unknown_session',
    });
    const ok = makeBody(
      'agent.send_instruction',
      { sessionId, instruction: 'x', mode: 'auto', attachments: [] },
      { deviceId, now },
    );
    expect(verifyIncoming(signer.sign(ok), ctx).ok).toBe(true);
    const status = makeBody('agent.get_status', {}, { deviceId, now });
    expect(verifyIncoming(signer.sign(status), ctx).ok).toBe(true);
    const rm = makeBody('project.remove', { projectId: ids.proj() }, { deviceId, now });
    expect(verifyIncoming(signer.sign(rm), ctx)).toMatchObject({
      ok: false,
      errorCode: 'unknown_project',
    });
  });

  it('checks run in order: signature before device before expiry', () => {
    const wrongDevExpired = start({ deviceId: ids.dev(), now: new Date(0), ttlMs: 1 });
    expect(verifyIncoming(signer.sign(wrongDevExpired), ctx)).toMatchObject({
      errorCode: 'wrong_device',
    });
    const env = signer.sign(wrongDevExpired);
    expect(verifyIncoming({ ...env, signature: 'AAAA' }, ctx)).toMatchObject({
      errorCode: 'bad_signature',
    });
  });
});
