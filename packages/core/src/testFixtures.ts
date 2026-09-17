import { randomBytes } from 'node:crypto';
import { type CommandBody, type CommandType, canonicalize } from '@pagr/protocol';
import { generateKeyPairPem, rawPublicKeyFromPem, signWithPem } from './identity.js';

export const hex32 = () => randomBytes(16).toString('hex');
export const ids = {
  usr: () => `usr_${hex32()}`,
  dev: () => `dev_${hex32()}`,
  proj: () => `proj_${hex32()}`,
  ses: () => `ses_${hex32()}`,
  cmd: () => `cmd_${hex32()}`,
  apr: () => `apr_${hex32()}`,
  att: () => `att_${hex32()}`,
  qst: () => `qst_${hex32()}`,
  rh: () => `rh_${hex32()}`,
};

/** A fake cloud signer: holds a server keypair and produces signed envelopes. */
export class FakeServerSigner {
  readonly privateKeyPem: string;
  readonly publicKeyRaw: string;
  constructor(readonly keyId = 'k1') {
    const kp = generateKeyPairPem();
    this.privateKeyPem = kp.privateKeyPem;
    this.publicKeyRaw = rawPublicKeyFromPem(kp.publicKeyPem);
  }
  get trustedKeys(): Record<string, string> {
    return { [this.keyId]: this.publicKeyRaw };
  }
  sign(body: unknown): { body: unknown; keyId: string; signature: string } {
    return {
      body,
      keyId: this.keyId,
      signature: signWithPem(this.privateKeyPem, canonicalize(body)),
    };
  }
}

export interface BodyOpts {
  deviceId: string;
  userId?: string;
  now?: Date;
  ttlMs?: number;
  commandId?: string;
  nonce?: string;
  idempotencyKey?: string;
}

export function makeBody<T extends CommandType>(
  type: T,
  payload: Extract<CommandBody, { type: T }>['payload'],
  o: BodyOpts,
): CommandBody {
  const now = o.now ?? new Date();
  return {
    version: 1,
    commandId: o.commandId ?? ids.cmd(),
    userId: o.userId ?? `usr_${'a'.repeat(32)}`,
    deviceId: o.deviceId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (o.ttlMs ?? 60_000)).toISOString(),
    nonce: o.nonce ?? randomBytes(16).toString('hex'),
    idempotencyKey: o.idempotencyKey ?? `idem_${hex32()}`,
    type,
    payload,
  } as CommandBody;
}
