import { randomBytes } from 'node:crypto';
import {
  type DeviceEvent,
  type EventPayload,
  type EventType,
  PROTOCOL_VERSION,
} from '@pagr/protocol';

export const newEventId = (): string => `evt_${randomBytes(12).toString('hex')}`;
export const newApprovalId = (): string => `apr_${randomBytes(16).toString('hex')}`;

export interface MakeEventOptions {
  inReplyTo?: string;
  now?: () => Date;
  idGen?: () => string;
}

/** Build a well-formed `DeviceEvent` for this device. */
export function makeEvent<T extends EventType>(
  deviceId: string,
  type: T,
  payload: EventPayload<T>,
  opts: MakeEventOptions = {},
): DeviceEvent {
  const base = {
    version: PROTOCOL_VERSION,
    eventId: (opts.idGen ?? newEventId)(),
    deviceId,
    at: (opts.now ?? (() => new Date()))().toISOString(),
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
  };
  return { ...base, type, payload } as DeviceEvent;
}

/** Compare dotted numeric versions: negative if a < b. Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
