import { release } from 'node:os';
import { z } from 'zod';
import { updateConfig } from './config.js';
import type { DeviceIdentity } from './identity.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const PairStartResponse = z.object({
  pairingId: z.string().min(1),
  code: z.string().min(1),
  pairUrl: z.string().url(),
  expiresAt: z.string(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

export const PairStatusResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('rejected') }),
  z.object({
    status: z.literal('completed'),
    deviceId: z.string().regex(/^dev_[0-9a-f]{32}$/),
    userId: z.string().regex(/^usr_[0-9a-f]{32}$/),
    gatewayUrl: z.string().url(),
    serverKeys: z.record(z.string()),
  }),
]);
export type PairStatusResponse = z.infer<typeof PairStatusResponse>;

export interface PairingOptions {
  apiUrl: string;
  deviceName: string;
  identity: DeviceIdentity;
  bridgeVersion: string;
  fetch?: FetchFn;
  osVersion?: string;
}

export class PairingError extends Error {
  constructor(
    readonly code: 'http' | 'invalid_response' | 'expired' | 'rejected' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

async function requestJson(fetchFn: FetchFn, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchFn(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok)
    throw new PairingError('http', `${init.method ?? 'GET'} ${url} → HTTP ${res.status}`);
  return res.json();
}

/** Ask the cloud for a pairing code. Only the PUBLIC key leaves the machine. */
export async function startPairing(opts: PairingOptions): Promise<PairStartResponse> {
  const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const raw = await requestJson(
    fetchFn,
    `${opts.apiUrl.replace(/\/$/, '')}/v1/devices/pair/start`,
    {
      method: 'POST',
      body: JSON.stringify({
        publicKey: opts.identity.publicKeyRaw,
        deviceName: opts.deviceName,
        platform: 'darwin',
        osVersion: opts.osVersion ?? release(),
        bridgeVersion: opts.bridgeVersion,
      }),
    },
  );
  const parsed = PairStartResponse.safeParse(raw);
  if (!parsed.success) throw new PairingError('invalid_response', 'unexpected pair/start response');
  return parsed.data;
}

export interface PollOptions {
  apiUrl: string;
  pairingId: string;
  fetch?: FetchFn;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type PairingCompleted = Extract<PairStatusResponse, { status: 'completed' }>;

/** Poll until the user approves in the browser (or the code expires). */
export async function pollPairing(opts: PollOptions): Promise<PairingCompleted> {
  const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.timeoutMs ?? 10 * 60_000);
  const url = `${opts.apiUrl.replace(/\/$/, '')}/v1/devices/pair/status/${encodeURIComponent(opts.pairingId)}`;
  for (;;) {
    const raw = await requestJson(fetchFn, url, { method: 'GET' });
    const parsed = PairStatusResponse.safeParse(raw);
    if (!parsed.success)
      throw new PairingError('invalid_response', 'unexpected pair/status response');
    const s = parsed.data;
    if (s.status === 'completed') return s;
    if (s.status === 'expired') throw new PairingError('expired', 'pairing code expired');
    if (s.status === 'rejected') throw new PairingError('rejected', 'pairing rejected');
    if (now() >= deadline) throw new PairingError('timeout', 'pairing timed out');
    await sleep(opts.intervalMs ?? 2000);
  }
}

/** Persist the pairing result into `config.json` (no secrets). */
export function persistPairing(
  configFile: string,
  result: PairingCompleted,
  extra: { apiUrl: string; deviceName: string; now?: () => Date },
): void {
  updateConfig(configFile, {
    deviceId: result.deviceId,
    userId: result.userId,
    gatewayUrl: result.gatewayUrl,
    serverKeys: result.serverKeys,
    apiUrl: extra.apiUrl,
    deviceName: extra.deviceName,
    pairedAt: (extra.now ?? (() => new Date()))().toISOString(),
  });
}

/** Full flow: start → poll → persist. */
export async function pair(
  opts: PairingOptions & {
    configFile: string;
    onCode?: (r: PairStartResponse) => void;
    poll?: Partial<PollOptions>;
  },
): Promise<PairingCompleted> {
  const started = await startPairing(opts);
  opts.onCode?.(started);
  const done = await pollPairing({
    apiUrl: opts.apiUrl,
    pairingId: started.pairingId,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...opts.poll,
  });
  persistPairing(opts.configFile, done, { apiUrl: opts.apiUrl, deviceName: opts.deviceName });
  return done;
}
