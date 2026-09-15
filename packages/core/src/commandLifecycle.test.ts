import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, Provider } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter, StartSessionInput } from './adapters/types.js';
import { updateConfig } from './config.js';
import { createDaemon, type Daemon } from './daemon.js';
import { MemorySecretStore } from './keychain.js';
import { FakeServerSigner, ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

/** An adapter whose `startSession` hangs until the test lets it finish (a Codex cold start). */
class SlowAdapter extends FakeAdapter {
  entered = 0;
  private release: (() => void) | null = null;
  private readonly gate: Promise<void>;
  constructor() {
    super('codex');
    this.gate = new Promise<void>((r) => {
      this.release = r;
    });
  }
  finish(): void {
    this.release?.();
  }
  override async startSession(input: StartSessionInput) {
    this.entered++;
    await this.gate;
    return super.startSession(input);
  }
}

const payload = (e: DeviceEvent) =>
  e.payload as { commandId: string; status: string; errorCode?: string; result?: unknown };

const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/**
 * The gateway resends an envelope it has had no ack for after ~30 s. A `start_session` that is
 * still running (a cold start, four attachments at ~15 s each) must not have that resend answered
 * `rejected / replayed` — the cloud maps that to `failed` and then ignores the real ack.
 */
describe('command lifecycle: a gateway resend is de-duplicated, not rejected', () => {
  const t = useTempHome('pagr-cmdlife-');
  const deviceId = ids.dev();
  let signer: FakeServerSigner;
  let daemon: Daemon;
  let codex: SlowAdapter;
  let projectId: string;

  beforeEach(async () => {
    signer = new FakeServerSigner();
    const home = join(t.home, 'pagr');
    mkdirSync(home, { recursive: true });
    updateConfig(join(home, 'config.json'), {
      deviceId,
      userId: ids.usr(),
      serverKeys: signer.trustedKeys,
    });
    codex = new SlowAdapter();
    daemon = await createDaemon({
      home,
      adapters: new Map<Provider, CodingAgentAdapter>([['codex', codex]]),
      secretStore: new MemorySecretStore(),
    });
    const repo = join(t.home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    projectId = daemon.registry.add(repo).projectId;
  });

  const startBody = (over: Partial<Parameters<typeof makeBody>[2]> = {}) =>
    makeBody(
      'agent.start_session',
      {
        provider: 'codex',
        projectId,
        instruction: 'take your time',
        sessionId: ids.ses(),
        attachments: [],
        readOnly: false,
      },
      { deviceId, ...over },
    );

  it('answers both copies with the one genuine terminal ack', async () => {
    const body = startBody();
    const envelope = signer.sign(body);
    const first = daemon.handleEnvelope(envelope);
    await tick();
    expect(codex.entered).toBe(1); // the command is in flight

    // 30 s later the gateway, still unacked, sends the identical envelope again.
    const resend = daemon.handleEnvelope(envelope);
    await tick();
    expect(codex.entered).toBe(1); // NOT executed twice

    codex.finish();
    const [a, b] = await Promise.all([first, resend]);
    for (const ack of [a, b]) {
      expect(payload(ack)).toMatchObject({ commandId: body.commandId, status: 'completed' });
      expect(payload(ack).errorCode).toBeUndefined();
      expect(ack.inReplyTo).toBe(body.commandId);
    }
    expect(payload(b).result).toEqual(payload(a).result);
    expect(codex.calls.filter((c) => c.method === 'startSession')).toHaveLength(1);
  });

  it('answers a resend that arrives after the command finished with the same terminal ack', async () => {
    const body = startBody();
    const envelope = signer.sign(body);
    const run = daemon.handleEnvelope(envelope);
    codex.finish();
    const a = await run;
    expect(payload(a).status).toBe('completed');
    const b = await daemon.handleEnvelope(envelope);
    expect(payload(b)).toMatchObject({ commandId: body.commandId, status: 'completed' });
    expect(codex.entered).toBe(1);
  });

  it('still rejects a different command that reuses a seen nonce, mid-flight or not', async () => {
    const body = startBody();
    const inFlight = daemon.handleEnvelope(signer.sign(body));
    await tick();
    const forged = startBody({ nonce: body.nonce });
    const rejected = await daemon.handleEnvelope(signer.sign(forged));
    expect(payload(rejected)).toMatchObject({ status: 'rejected', errorCode: 'replayed' });
    expect(codex.entered).toBe(1);
    codex.finish();
    expect(payload(await inFlight).status).toBe('completed');
    // and the same is true once it has finished
    const after = await daemon.handleEnvelope(signer.sign(startBody({ nonce: body.nonce })));
    expect(payload(after)).toMatchObject({ status: 'rejected', errorCode: 'replayed' });
  });

  it('a rejection that lands before dispatch is still answerable, and never hangs a resend', async () => {
    const body = makeBody(
      'agent.send_instruction',
      { sessionId: ids.ses(), instruction: 'x', mode: 'auto', attachments: [] },
      { deviceId },
    );
    const envelope = signer.sign(body);
    const first = await daemon.handleEnvelope(envelope);
    expect(payload(first)).toMatchObject({ status: 'rejected', errorCode: 'unknown_session' });
    // The guard marked this command in flight before the local-existence check; the resend must
    // get that verdict back rather than waiting on a command that will never run.
    const resend = await daemon.handleEnvelope(envelope);
    expect(payload(resend)).toMatchObject({ commandId: body.commandId, status: 'rejected' });
  });
});
