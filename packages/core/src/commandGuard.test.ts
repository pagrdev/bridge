import type { DeviceEvent } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CommandTracker,
  type GuardContext,
  MAX_LIFETIME_MS,
  verifyIncoming,
} from './commandGuard.js';
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
      commands: new CommandTracker(),
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

  const fakeAck = (status = 'completed'): DeviceEvent =>
    ({ eventId: 'e', payload: { status } }) as unknown as DeviceEvent;

  it("returns the finished command's ack for an idempotent retry, and still rejects a replay", async () => {
    const body = start();
    const env = signer.sign(body);
    expect(verifyIncoming(env, ctx).ok).toBe(true);
    const ack = fakeAck();
    ctx.commands.settle(body.commandId, ack);
    // the exact envelope again → the terminal ack of the one execution, not `replayed`
    const r = verifyIncoming(env, ctx);
    expect(r).toMatchObject({ ok: true, duplicate: true, inFlight: false });
    if (r.ok && r.duplicate) expect(await r.ack).toBe(ack);
    // a fresh nonce/commandId with the same idempotency key is also a duplicate
    const r2 = verifyIncoming(signer.sign(start({ idempotencyKey: body.idempotencyKey })), ctx);
    expect(r2).toMatchObject({ ok: true, duplicate: true });
    if (r2.ok && r2.duplicate) expect(await r2.ack).toBe(ack);
  });

  it('de-duplicates the gateway resend of a command that is STILL running', async () => {
    const body = start();
    const env = signer.sign(body);
    const first = verifyIncoming(env, ctx);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    // 30 s later the gateway resends the identical envelope; the first is still executing.
    now = new Date(now.getTime() + 30_000);
    const resend = verifyIncoming(env, ctx);
    expect(resend).toMatchObject({ ok: true, duplicate: true, inFlight: true });
    const ack = fakeAck();
    ctx.commands.settle(body.commandId, ack);
    if (resend.ok && resend.duplicate) expect(await resend.ack).toBe(ack);
  });

  it('still rejects a DIFFERENT command reusing a seen nonce, and a commandId reusing another nonce', () => {
    const body = start();
    expect(verifyIncoming(signer.sign(body), ctx).ok).toBe(true);
    // same nonce, different commandId + idempotency key → genuine replay
    expect(verifyIncoming(signer.sign(start({ nonce: body.nonce })), ctx)).toMatchObject({
      ok: false,
      errorCode: 'replayed',
    });
    // same commandId, different nonce → forged resend, not a de-duplicable retry
    expect(verifyIncoming(signer.sign(start({ commandId: body.commandId })), ctx)).toMatchObject({
      ok: false,
      errorCode: 'replayed',
    });
  });

  it('remembers a nonce for at least the whole accepted lifetime of a command', () => {
    const body = start({ ttlMs: MAX_LIFETIME_MS });
    expect(verifyIncoming(signer.sign(body), ctx).ok).toBe(true);
    // the last instant that command could still have been accepted: its nonce must not be back
    now = new Date(Date.parse(body.issuedAt) + MAX_LIFETIME_MS - 1);
    expect(verifyIncoming(signer.sign(start({ nonce: body.nonce })), ctx)).toMatchObject({
      ok: false,
      errorCode: 'replayed',
    });
  });

  it('enforces the 15 minute ceiling whatever the envelope claims', () => {
    // an hour-long expiresAt is refused outright, so it can never outlive its nonce
    expect(verifyIncoming(signer.sign(start({ ttlMs: 60 * 60_000 })), ctx)).toMatchObject({
      ok: false,
      errorCode: 'expired',
    });
    // exactly 15 minutes is still fine
    expect(verifyIncoming(signer.sign(start({ ttlMs: MAX_LIFETIME_MS })), ctx).ok).toBe(true);
    expect(verifyIncoming(signer.sign(start({ ttlMs: MAX_LIFETIME_MS + 1 })), ctx)).toMatchObject({
      ok: false,
      errorCode: 'expired',
    });
    // issued 15 minutes ago, still unexpired by its own claim → refused on age alone
    const old = start({
      now: new Date(now.getTime() - MAX_LIFETIME_MS - 1_000),
      ttlMs: 60 * 60_000,
    });
    expect(verifyIncoming(signer.sign(old), ctx)).toMatchObject({
      ok: false,
      errorCode: 'expired',
    });
    // issued 14 minutes ago and still unexpired by its own (15 minute) claim → accepted
    const justInside = start({
      now: new Date(now.getTime() - MAX_LIFETIME_MS + 60_000),
      ttlMs: MAX_LIFETIME_MS,
    });
    expect(verifyIncoming(signer.sign(justInside), ctx).ok).toBe(true);
  });

  it('a guard rejection is not cached against the idempotency key', async () => {
    const body = start({}, ids.proj()); // project not registered here
    const rejected = verifyIncoming(signer.sign(body), ctx);
    expect(rejected).toMatchObject({ ok: false, errorCode: 'unknown_project' });
    ctx.commands.settle(body.commandId, fakeAck('rejected'));
    // the project is registered by the time the cloud retries under the same key: run it
    const retry = verifyIncoming(signer.sign(start({ idempotencyKey: body.idempotencyKey })), ctx);
    expect(retry).toMatchObject({ ok: true, duplicate: false });
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
