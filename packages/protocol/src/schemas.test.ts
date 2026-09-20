import { describe, expect, it } from 'vitest';
import {
  ApprovalOption,
  AuthResponse,
  AuthResult,
  CommandBody,
  CommandType,
  canonicalize,
  DeviceEvent,
  FrameKind,
  GatewayFrame,
  GitRange,
  HandoffCaptureResult,
  HandoffState,
  RECIPIENT_KEY_SET_CONTEXT,
  RepoScanResult,
  ReviewStartResult,
  RulesMigrateResult,
  SEAL_CONTEXT,
  SealedEnvelope,
  SendInstructionResult,
} from './schemas.js';

const hex32 = 'a'.repeat(32);
const base = {
  version: 1 as const,
  commandId: `cmd_${hex32}`,
  userId: `usr_${hex32}`,
  deviceId: `dev_${hex32}`,
  issuedAt: '2026-08-24T00:00:00.000Z',
  expiresAt: '2026-08-24T00:05:00.000Z',
  nonce: 'n'.repeat(24),
  idempotencyKey: 'idem-12345678',
};

describe('protocol', () => {
  it('has no generic shell/filesystem command', () => {
    const types = CommandType.options;
    for (const forbidden of ['shell', 'exec', 'filesystem', 'spawn', 'read_any', 'write_any']) {
      expect(types.some((t) => t.includes(forbidden))).toBe(false);
    }
  });

  it('accepts a valid start_session command with opaque project id', () => {
    const r = CommandBody.safeParse({
      ...base,
      type: 'agent.start_session',
      payload: {
        provider: 'codex',
        projectId: `proj_${hex32}`,
        sessionId: `ses_${hex32}`,
        instruction: 'run tests',
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a cloud-supplied filesystem path in place of a project id', () => {
    const r = CommandBody.safeParse({
      ...base,
      type: 'agent.start_session',
      payload: {
        provider: 'codex',
        projectId: '/Users/x/code',
        sessionId: `ses_${hex32}`,
        instruction: 'x',
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown command types', () => {
    const r = CommandBody.safeParse({ ...base, type: 'shell.exec', payload: { cmd: 'rm -rf /' } });
    expect(r.success).toBe(false);
  });

  it('parses approval.requested event with defaults', () => {
    const r = DeviceEvent.safeParse({
      version: 1,
      eventId: 'evt-12345678',
      deviceId: `dev_${hex32}`,
      at: '2026-08-24T00:00:00.000Z',
      type: 'approval.requested',
      payload: {
        approvalId: `apr_${hex32}`,
        sessionId: `ses_${hex32}`,
        projectId: `proj_${hex32}`,
        provider: 'codex',
        providerRequestId: 'req-1',
        actionType: 'command_execution',
        preview: 'npm run db:migrate',
        previewHash: 'f'.repeat(64),
        expiresAt: '2026-08-24T00:10:00.000Z',
      },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'approval.requested') {
      expect(r.data.payload.hints.destructive).toBe(false);
    }
  });

  it('canonicalizes deterministically', () => {
    expect(canonicalize({ b: 1, a: [{ z: 1, y: undefined }] })).toBe('{"a":[{"z":1}],"b":1}');
  });
});

// ---------------------------------------------------------------------------
// protocol v2
//
// v2 is additive: one schema parses both peers. Every case below that names a v1 shape is here to
// prove the v1 bridge still on someone's Mac keeps working exactly as it does today.
// ---------------------------------------------------------------------------

const kid = '0011:2233:4455:6677';
const sealed = {
  v: 1 as const,
  epk: 'A'.repeat(43),
  recipients: [{ kid, nonce: 'B'.repeat(16), wrap: 'C'.repeat(64) }],
  nonce: 'D'.repeat(16),
  ct: 'E'.repeat(120),
  aad: { sessionId: `ses_${hex32}`, seq: 7, kind: 'assistant' },
};
const frameMeta = { bytes: 128, truncated: false, source: 'stdio' as const };
const event = (type: string, payload: unknown, version: 1 | 2 = 2) => ({
  version,
  eventId: 'evt-12345678',
  deviceId: `dev_${hex32}`,
  at: '2026-09-17T00:00:00.000Z',
  type,
  payload,
});

describe('protocol v2 — versions', () => {
  it('accepts both versions on a command body and an event', () => {
    for (const version of [1, 2] as const) {
      expect(
        CommandBody.safeParse({ ...base, version, type: 'device.probe', payload: {} }).success,
      ).toBe(true);
      expect(
        DeviceEvent.safeParse(event('device.heartbeat', { activeSessions: 0 }, version)).success,
      ).toBe(true);
    }
    expect(
      CommandBody.safeParse({ ...base, version: 3, type: 'device.probe', payload: {} }).success,
    ).toBe(false);
  });

  it('offers a version in auth.response and reads one back from auth.result', () => {
    const response = {
      kind: 'auth.response',
      deviceId: `dev_${hex32}`,
      nonce: 'n'.repeat(40),
      signature: 'sig',
      bridgeVersion: '0.1.0',
      protocolVersion: 2,
    };
    expect(AuthResponse.safeParse(response).success).toBe(true);
    expect(AuthResponse.safeParse({ ...response, protocolVersion: 1 }).success).toBe(true);
    expect(AuthResponse.safeParse({ ...response, protocolVersion: 3 }).success).toBe(false);

    // Absent means 1: a v1 gateway answers exactly as it does today.
    const v1Result = AuthResult.safeParse({
      kind: 'auth.result',
      ok: true,
      serverKeys: { k1: 'AAAA' },
    });
    expect(v1Result.success).toBe(true);
    if (v1Result.success) expect(v1Result.data.protocolVersion).toBeUndefined();
    expect(
      AuthResult.safeParse({ kind: 'auth.result', ok: true, protocolVersion: 2 }).success,
    ).toBe(true);
  });

  it('carries the recipient key set and features on auth.result', () => {
    const r = AuthResult.safeParse({
      kind: 'auth.result',
      ok: true,
      protocolVersion: 2,
      recipientKeys: {
        v: 1,
        userId: `usr_${hex32}`,
        keys: [
          {
            kid,
            x25519: 'A'.repeat(43),
            name: "Waleed's iPhone",
            registeredAt: '2026-09-17T00:00:00.000Z',
          },
        ],
        features: { imessage: true },
        issuedAt: '2026-09-17T00:00:00.000Z',
      },
      recipientKeysSignature: { keyId: 'k1', signature: 'sig' },
      features: { imessage: true },
    });
    expect(r.success).toBe(true);
  });

  it('names the two v2 domain separators', () => {
    expect(SEAL_CONTEXT).toBe('pagr.seal.v1');
    expect(RECIPIENT_KEY_SET_CONTEXT).toBe('pagr.recipient-keys.v1:');
  });
});

describe('protocol v2 — sealed frames', () => {
  it('parses a session.frame carrying a sealed envelope', () => {
    const r = DeviceEvent.safeParse(
      event('session.frame', {
        sessionId: `ses_${hex32}`,
        projectId: `proj_${hex32}`,
        provider: 'claude',
        seq: 7,
        kind: 'assistant',
        at: '2026-09-17T00:00:00.000Z',
        providerRecordId: 'rec-1',
        sealed,
        meta: { ...frameMeta, turnId: 't1', status: 'streaming', final: false },
      }),
    );
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'session.frame') {
      expect(r.data.payload.sealed.aad.seq).toBe(7);
      expect(r.data.payload.meta.truncated).toBe(false);
    }
  });

  it('refuses an envelope whose fields are the wrong size, or whose kid is not a fingerprint', () => {
    const bad = (patch: Record<string, unknown>) =>
      SealedEnvelope.safeParse({ ...sealed, ...patch }).success;
    expect(bad({ epk: 'A'.repeat(42) })).toBe(false);
    expect(bad({ nonce: 'B'.repeat(24) })).toBe(false);
    expect(
      bad({
        recipients: [{ kid: 'not-a-fingerprint', nonce: 'B'.repeat(16), wrap: 'C'.repeat(64) }],
      }),
    ).toBe(false);
    expect(bad({ recipients: [] })).toBe(false);
    expect(bad({ aad: { ...sealed.aad, kind: 'not_a_kind' } })).toBe(false);
    expect(SealedEnvelope.safeParse(sealed).success).toBe(true);
  });

  it('keeps no path anywhere in an aad or a frame handle', () => {
    expect(
      SealedEnvelope.safeParse({ ...sealed, aad: { ...sealed.aad, sessionId: '/Users/x/code' } })
        .success,
    ).toBe(false);
    expect(
      CommandBody.safeParse({
        ...base,
        type: 'project.register_handle',
        payload: { handle: '/Users/x/code' },
      }).success,
    ).toBe(false);
  });

  it('carries every frame kind the phone can render', () => {
    expect(FrameKind.options).toEqual([
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'diff',
      'terminal',
      'thinking',
      'question',
      'approval_preview',
      'system',
      'imessage',
      'handoff',
      'review',
    ]);
  });
});

describe('protocol v2 — commands', () => {
  const cmd = (type: string, payload: unknown) => CommandBody.safeParse({ ...base, type, payload });

  it('adds the six v2 commands', () => {
    expect(cmd('repo.scan', {}).success).toBe(true);
    expect(cmd('keys.sync', {}).success).toBe(true);
    expect(
      cmd('project.register_handle', { handle: `rh_${hex32}`, displayName: 'pagr' }).success,
    ).toBe(true);
    expect(
      cmd('agent.answer_question', {
        questionId: `qst_${hex32}`,
        sessionId: `ses_${hex32}`,
        providerRequestId: 'req-1',
        answers: [{ questionIndex: 0, optionIndexes: [1], freeText: 'because' }],
      }).success,
    ).toBe(true);
    expect(cmd('session.list_history', { sinceDays: 30, limit: 50 }).success).toBe(true);
    expect(
      cmd('session.backfill', { sessionId: `ses_${hex32}`, fromSeq: 0, maxBytes: 65_536 }).success,
    ).toBe(true);
  });

  it('keeps `decision` required on an approval response and makes `optionId` optional', () => {
    const payload = {
      approvalId: `apr_${hex32}`,
      sessionId: `ses_${hex32}`,
      providerRequestId: 'req-1',
      previewHash: 'f'.repeat(64),
      decision: 'allow' as const,
    };
    expect(cmd('agent.respond_to_approval', payload).success).toBe(true);
    const withOption = cmd('agent.respond_to_approval', { ...payload, optionId: 'allow_always' });
    expect(withOption.success).toBe(true);
    const { decision: _decision, ...noDecision } = payload;
    expect(cmd('agent.respond_to_approval', noDecision).success).toBe(false);
  });

  it('still has no generic shell or filesystem command after the v2 additions', () => {
    for (const forbidden of ['shell', 'exec', 'filesystem', 'spawn', 'read_any', 'write_any']) {
      expect(CommandType.options.some((t) => t.includes(forbidden))).toBe(false);
    }
  });
});

describe('protocol v2 — events', () => {
  it('parses the v1 approval.requested shape and the v2 one', () => {
    const v1 = DeviceEvent.safeParse(
      event(
        'approval.requested',
        {
          approvalId: `apr_${hex32}`,
          sessionId: `ses_${hex32}`,
          projectId: `proj_${hex32}`,
          provider: 'codex',
          providerRequestId: 'req-1',
          actionType: 'command_execution',
          preview: 'npm run db:migrate',
          previewHash: 'f'.repeat(64),
          expiresAt: '2026-09-17T00:10:00.000Z',
        },
        1,
      ),
    );
    expect(v1.success).toBe(true);
    if (v1.success && v1.data.type === 'approval.requested') {
      expect(v1.data.payload.preview).toBe('npm run db:migrate');
      expect(v1.data.payload.options).toBeUndefined();
    }

    // v2 seals the preview into its own frame, so the plaintext one defaults away.
    const v2 = DeviceEvent.safeParse(
      event('approval.requested', {
        approvalId: `apr_${hex32}`,
        sessionId: `ses_${hex32}`,
        projectId: `proj_${hex32}`,
        provider: 'claude',
        providerRequestId: 'req-1',
        actionType: 'command_execution',
        previewHash: 'f'.repeat(64),
        expiresAt: '2026-09-17T00:10:00.000Z',
        options: [
          { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', label: 'Reject' },
        ],
        riskTier: 'B',
        frameSeq: 12,
        imessage: 'Claude wants to run a command',
      }),
    );
    expect(v2.success).toBe(true);
    if (v2.success && v2.data.type === 'approval.requested') {
      expect(v2.data.payload.preview).toBe('');
      expect(v2.data.payload.options?.[0]?.kind).toBe('allow_once');
      expect(v2.data.payload.riskTier).toBe('B');
    }
  });

  it('rejects an approval option kind the phone cannot render', () => {
    expect(ApprovalOption.safeParse({ optionId: 'x', kind: 'maybe', label: 'Maybe' }).success).toBe(
      false,
    );
    expect(
      ApprovalOption.safeParse({ optionId: 'allow_session', kind: 'allow_session', label: 'Allow' })
        .success,
    ).toBe(true);
  });

  it('parses approval.applied and a locally-resolved approval with its source', () => {
    expect(
      DeviceEvent.safeParse(
        event('approval.applied', {
          approvalId: `apr_${hex32}`,
          sessionId: `ses_${hex32}`,
          optionId: 'allow_once',
          applied: true,
          appliedAs: 'allow_once',
        }),
      ).success,
    ).toBe(true);

    const v1 = DeviceEvent.safeParse(
      event('approval.resolved_locally', { approvalId: `apr_${hex32}`, resolution: 'allowed' }, 1),
    );
    expect(v1.success).toBe(true);
    if (v1.success && v1.data.type === 'approval.resolved_locally') {
      expect(v1.data.payload.answeredElsewhere).toBe(false);
    }
    expect(
      DeviceEvent.safeParse(
        event('approval.resolved_locally', {
          approvalId: `apr_${hex32}`,
          resolution: 'allowed',
          source: 'terminal',
          answeredElsewhere: true,
        }),
      ).success,
    ).toBe(true);
  });

  it('parses a question asked and answered', () => {
    expect(
      DeviceEvent.safeParse(
        event('question.asked', {
          questionId: `qst_${hex32}`,
          sessionId: `ses_${hex32}`,
          projectId: `proj_${hex32}`,
          provider: 'claude',
          providerRequestId: 'req-1',
          seq: 12,
          meta: {
            answerable: false,
            reason: 'terminal_dialog',
            multiSelect: [false],
            optionCount: [3],
            secret: [false],
          },
          expiresAt: '2026-09-17T00:10:00.000Z',
        }),
      ).success,
    ).toBe(true);
    expect(
      DeviceEvent.safeParse(
        event('question.answered', { questionId: `qst_${hex32}`, answeredElsewhere: true }),
      ).success,
    ).toBe(true);
  });

  it('parses a v1 session summary and a v2 one on session.updated', () => {
    const summary = {
      sessionId: `ses_${hex32}`,
      projectId: `proj_${hex32}`,
      provider: 'claude',
      status: 'working',
      startedAt: '2026-09-17T00:00:00.000Z',
      updatedAt: '2026-09-17T00:00:00.000Z',
    };
    const v1 = DeviceEvent.safeParse(event('session.updated', summary, 1));
    expect(v1.success).toBe(true);
    if (v1.success && v1.data.type === 'session.updated') {
      expect(v1.data.payload.controlLevel).toBeUndefined();
      expect(v1.data.payload.activeTurn).toBe(false);
    }
    expect(
      DeviceEvent.safeParse(
        event('session.updated', {
          ...summary,
          controlLevel: 'approvals_only',
          origin: 'terminal',
          projectStatus: 'unregistered',
          lastSeq: 41,
        }),
      ).success,
    ).toBe(true);
  });

  it('parses a v1 hello and a v2 hello', () => {
    const hello = {
      bridgeVersion: '0.1.0',
      protocolVersion: 1,
      platform: 'darwin',
      agents: [],
      projects: [],
      sessions: [],
    };
    expect(DeviceEvent.safeParse(event('device.hello', hello, 1)).success).toBe(true);
    expect(
      DeviceEvent.safeParse(
        event('device.hello', {
          ...hello,
          protocolVersion: 2,
          capabilities: ['frames.v1', 'seal.v1', 'questions.v1'],
          floor: { lifted: ['git_push'] },
          channel: { serverInstalled: true, shimOnPath: true, boundSessions: 2, mode: 'default' },
          recipientKeyIds: [kid],
        }),
      ).success,
    ).toBe(true);
  });

  it('adds the v2 ack error codes and a typed send_instruction result', () => {
    for (const errorCode of ['unknown_question', 'rate_limited', 'not_negotiated']) {
      expect(
        DeviceEvent.safeParse(
          event('command.ack', { commandId: `cmd_${hex32}`, status: 'failed', errorCode }),
        ).success,
      ).toBe(true);
    }
    expect(SendInstructionResult.safeParse({ delivered: 'steered' }).success).toBe(true);
    expect(SendInstructionResult.safeParse({ delivered: 'sent' }).success).toBe(false);
    expect(
      RepoScanResult.safeParse({
        repos: [{ handle: `rh_${hex32}`, displayName: 'pagr', registeredAs: `proj_${hex32}` }],
        truncated: false,
      }).success,
    ).toBe(true);
    // A scan result can never carry a path.
    expect(
      RepoScanResult.safeParse({ repos: [{ handle: '/Users/x/code', displayName: 'x' }] }).success,
    ).toBe(false);
  });
});

describe('protocol v2 — gateway frames', () => {
  it('parses the three new gateway frames', () => {
    expect(GatewayFrame.safeParse({ kind: 'ack', cursors: { [`ses_${hex32}`]: 12 } }).success).toBe(
      true,
    );
    expect(
      GatewayFrame.safeParse({
        kind: 'keys.updated',
        recipientKeys: {
          v: 1,
          userId: `usr_${hex32}`,
          keys: [],
          features: { imessage: false },
          issuedAt: '2026-09-17T00:00:00.000Z',
        },
        recipientKeysSignature: { keyId: 'k1', signature: 'sig' },
      }).success,
    ).toBe(true);
    expect(
      GatewayFrame.safeParse({ kind: 'settings.updated', features: { imessage: true } }).success,
    ).toBe(true);
  });

  it('still parses every v1 gateway frame', () => {
    expect(GatewayFrame.safeParse({ kind: 'ping' }).success).toBe(true);
    expect(GatewayFrame.safeParse({ kind: 'auth.challenge', nonce: 'n'.repeat(40) }).success).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// handoff.v1
//
// The switch and the review, added on top of v2 and gated on a named capability rather than on a
// version. Everything here is additive: the cases above that pin v1 shapes are the proof.
// ---------------------------------------------------------------------------

const hnd = `hnd_${hex32}`;
const rev = `rev_${hex32}`;
const cmd = (type: string, payload: unknown) => CommandBody.safeParse({ ...base, type, payload });

describe('handoff.v1 — commands', () => {
  it('parses a capture, with and without the optional note', () => {
    const payload = { handoffId: hnd, sessionId: `ses_${hex32}`, to: 'codex' as const };
    expect(cmd('session.handoff.capture', payload).success).toBe(true);
    expect(
      cmd('session.handoff.capture', { ...payload, note: 'focus on the refund path' }).success,
    ).toBe(true);
  });

  it('parses review.start, review.apply and rules.migrate', () => {
    expect(
      cmd('review.start', {
        reviewId: rev,
        projectId: `proj_${hex32}`,
        reviewer: 'codex',
        range: 'HEAD~1..HEAD',
        intent: 'add partial refunds to the checkout API',
      }).success,
    ).toBe(true);
    expect(cmd('review.apply', { reviewId: rev }).success).toBe(true);
    expect(cmd('review.apply', { reviewId: rev, sessionId: `ses_${hex32}` }).success).toBe(true);
    expect(
      cmd('rules.migrate', {
        projectId: `proj_${hex32}`,
        from: 'claude',
        to: 'codex',
        consent: false,
      }).success,
    ).toBe(true);
  });

  it('refuses a malformed handoff or review id', () => {
    expect(
      cmd('session.handoff.capture', {
        handoffId: 'hnd_not-hex',
        sessionId: `ses_${hex32}`,
        to: 'codex',
      }).success,
    ).toBe(false);
    // A session id where a handoff id belongs is a different object, not a near miss.
    expect(
      cmd('session.handoff.capture', {
        handoffId: `ses_${hex32}`,
        sessionId: `ses_${hex32}`,
        to: 'codex',
      }).success,
    ).toBe(false);
    expect(cmd('review.apply', { reviewId: `rev_${'a'.repeat(31)}` }).success).toBe(false);
    // And a path is still a path wherever it is put.
    expect(cmd('review.apply', { reviewId: '/Users/x/code' }).success).toBe(false);
  });

  it('refuses a range that is not a commit range', () => {
    const start = (range: string) =>
      cmd('review.start', {
        reviewId: rev,
        projectId: `proj_${hex32}`,
        reviewer: 'claude',
        range,
        intent: 'x',
      }).success;
    expect(start('origin/main..HEAD')).toBe(true);
    expect(start('main...feat/refunds')).toBe(true);
    expect(start('HEAD')).toBe(false);
    // Nothing that could reach `git` as a flag or a second word.
    expect(start('--upload-pack=touch x..HEAD')).toBe(false);
    expect(start('a..b; rm -rf /')).toBe(false);
    expect(GitRange.safeParse('HEAD~1..HEAD').success).toBe(true);
  });

  it('adds `context` to start_session without disturbing a v1 payload', () => {
    const v1 = {
      provider: 'codex' as const,
      projectId: `proj_${hex32}`,
      sessionId: `ses_${hex32}`,
      instruction: 'run tests',
    };
    const plain = cmd('agent.start_session', v1);
    expect(plain.success).toBe(true);
    if (plain.success && plain.data.type === 'agent.start_session') {
      expect(plain.data.payload.context).toBeUndefined();
    }
    const withContext = cmd('agent.start_session', {
      ...v1,
      instruction: 'Read .pagr/handoff/hnd_…md and continue the task.',
      context: { handoffId: hnd },
    });
    expect(withContext.success).toBe(true);
    if (withContext.success && withContext.data.type === 'agent.start_session') {
      expect(withContext.data.payload.context?.handoffId).toBe(hnd);
    }
    expect(cmd('agent.start_session', { ...v1, context: { reviewId: rev } }).success).toBe(true);
    // Empty is legal (nothing is required inside it); a bad id inside it is not.
    expect(cmd('agent.start_session', { ...v1, context: {} }).success).toBe(true);
    expect(cmd('agent.start_session', { ...v1, context: { handoffId: 'hnd_x' } }).success).toBe(
      false,
    );
  });

  it('still has no generic shell or filesystem command', () => {
    for (const forbidden of ['shell', 'exec', 'filesystem', 'spawn', 'read_any', 'write_any']) {
      expect(CommandType.options.some((t) => t.includes(forbidden))).toBe(false);
    }
  });
});

describe('handoff.v1 — events', () => {
  it('walks every state of a switch on handoff.updated', () => {
    for (const state of HandoffState.options) {
      expect(
        DeviceEvent.safeParse(event('handoff.updated', { handoffId: hnd, state })).success,
      ).toBe(true);
    }
    expect(HandoffState.options).toEqual([
      'requested',
      'capturing',
      'committing',
      'stopping',
      'starting',
      'running',
      'done',
      'failed',
      'canceled',
    ]);
  });

  it('carries the per-step fields, and refuses a state or a writer it has never heard of', () => {
    const full = DeviceEvent.safeParse(
      event('handoff.updated', {
        handoffId: hnd,
        state: 'committing',
        summary: 'Add partial refunds to the checkout API',
        wipCommit: '7a1d3f9',
        writer: 'sender',
        filesChanged: 3,
        truncated: false,
      }),
    );
    expect(full.success).toBe(true);
    if (full.success && full.data.type === 'handoff.updated') {
      expect(full.data.payload.writer).toBe('sender');
      expect(full.data.payload.filesChanged).toBe(3);
    }
    expect(
      DeviceEvent.safeParse(
        event('handoff.updated', {
          handoffId: hnd,
          state: 'failed',
          error: 'pre-commit hook failed',
        }),
      ).success,
    ).toBe(true);
    expect(
      DeviceEvent.safeParse(event('handoff.updated', { handoffId: hnd, state: 'compacting' }))
        .success,
    ).toBe(false);
    expect(
      DeviceEvent.safeParse(
        event('handoff.updated', { handoffId: hnd, state: 'capturing', writer: 'cloud' }),
      ).success,
    ).toBe(false);
    // A branch name is not a commit.
    expect(
      DeviceEvent.safeParse(
        event('handoff.updated', { handoffId: hnd, state: 'committing', wipCommit: 'HEAD' }),
      ).success,
    ).toBe(false);
  });

  it('parses review.completed for each verdict and refuses any other', () => {
    for (const verdict of ['approve', 'comment', 'block']) {
      expect(
        DeviceEvent.safeParse(
          event('review.completed', { reviewId: rev, verdict, summary: 'refund path skips auth' }),
        ).success,
      ).toBe(true);
    }
    expect(
      DeviceEvent.safeParse(
        event('review.completed', { reviewId: rev, verdict: 'lgtm', summary: 'fine' }),
      ).success,
    ).toBe(false);
    expect(
      DeviceEvent.safeParse(event('review.completed', { reviewId: rev, verdict: 'approve' }))
        .success,
    ).toBe(false);
  });
});

describe('handoff.v1 — ack results', () => {
  it('types the capture ack, defaulting the two fields a clean tree leaves out', () => {
    const clean = HandoffCaptureResult.safeParse({
      writer: 'receiver',
      summary: 'Finish the refunds endpoint',
    });
    expect(clean.success).toBe(true);
    if (clean.success) {
      expect(clean.data.wipCommit).toBeUndefined();
      expect(clean.data.filesChanged).toBe(0);
      expect(clean.data.truncated).toBe(false);
    }
    expect(
      HandoffCaptureResult.safeParse({
        writer: 'sender',
        summary: 'Finish the refunds endpoint',
        wipCommit: '7a1d3f9c',
        filesChanged: 3,
        truncated: true,
      }).success,
    ).toBe(true);
    expect(
      HandoffCaptureResult.safeParse({ writer: 'sender', summary: 'x', filesChanged: -1 }).success,
    ).toBe(false);
  });

  it('types the review.start ack and the rules.migrate proposal', () => {
    expect(ReviewStartResult.safeParse({ reviewId: rev }).success).toBe(true);
    expect(ReviewStartResult.safeParse({ reviewId: `hnd_${hex32}` }).success).toBe(false);

    expect(RulesMigrateResult.safeParse({ action: 'already_present' }).success).toBe(true);
    expect(RulesMigrateResult.safeParse({ action: 'native_read' }).success).toBe(true);
    expect(RulesMigrateResult.safeParse({ action: 'none' }).success).toBe(true);
    const proposal = RulesMigrateResult.safeParse({
      action: 'write',
      sourceFile: 'CLAUDE.md',
      lineCount: 142,
      targetFile: 'AGENTS.md',
    });
    expect(proposal.success).toBe(true);
    if (proposal.success) expect(proposal.data.lineCount).toBe(142);
    expect(RulesMigrateResult.safeParse({ action: 'migrated' }).success).toBe(false);
    // The file names are named, so a path can never arrive in their place.
    expect(
      RulesMigrateResult.safeParse({ action: 'write', targetFile: '/Users/x/AGENTS.md' }).success,
    ).toBe(false);
  });
});
