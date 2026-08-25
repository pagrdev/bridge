import { describe, expect, it } from 'vitest';
import { CommandBody, CommandType, canonicalize, DeviceEvent } from './schemas.js';

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
