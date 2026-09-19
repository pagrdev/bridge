import { release } from 'node:os';
import { PROTOCOL_VERSION } from '@pagr/protocol';
import { z } from 'zod';
import { updateConfig } from './config.js';
import { compareVersions } from './events.js';
import type { DeviceIdentity } from './identity.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Codes are stable: the CLI maps each one to a message, a hint and an exit code, and those
 * mappings are under test. Add a code rather than overloading an existing one.
 */
export type PairingErrorCode =
  /** The request never got an HTTP response: DNS, refused, reset, TLS, or a per-request timeout. */
  | 'network'
  /** 5xx (after retries) — the API is up but broken. */
  | 'server_error'
  /** 404 — wrong API URL, or an API too old to know this route. */
  | 'not_found'
  /** 426 / minBridgeVersion / protocolVersion mismatch — this CLI is too old (or too new). */
  | 'unsupported'
  /** 401 / 403. */
  | 'unauthorized'
  /** Any other non-2xx. */
  | 'http'
  /** Not JSON at all (an HTML error page / proxy portal), or JSON of the wrong shape. */
  | 'invalid_response'
  /** The pairing code lapsed before it was approved. */
  | 'expired'
  /** Someone declined the request in the dashboard. */
  | 'rejected'
  /** The code was already redeemed (by another device, or a second `connect`). */
  | 'used'
  /** We stopped waiting for the user to approve. */
  | 'timeout';

export interface PairingErrorOptions {
  hint?: string;
  status?: number;
  /** A short, already-flattened excerpt of the body, safe to print. */
  detail?: string;
  cause?: unknown;
}

export class PairingError extends Error {
  readonly hint: string | undefined;
  readonly status: number | undefined;
  readonly detail: string | undefined;
  constructor(
    readonly code: PairingErrorCode,
    message: string,
    o: PairingErrorOptions = {},
  ) {
    super(message);
    this.name = 'PairingError';
    this.hint = o.hint;
    this.status = o.status;
    this.detail = o.detail;
    if (o.cause !== undefined) this.cause = o.cause;
  }
  /** Transient failures are worth retrying inside a single `connect`. */
  get retryable(): boolean {
    return this.code === 'network' || this.code === 'server_error';
  }
}

export const PairStartResponse = z.object({
  pairingId: z.string().min(1),
  code: z.string().min(1),
  pairUrl: z.string().url(),
  expiresAt: z.string(),
  /** Optional server-side gate: refuse to pair a bridge older than this. */
  minBridgeVersion: z.string().optional(),
  /** Optional: the device-protocol version the API speaks. */
  protocolVersion: z.number().int().optional(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

/**
 * The account-side facts the API attaches to a completed pairing. Every field is read
 * leniently — `.default(false).catch(false)` — because this CLI is installed once and then
 * talks to an API that keeps moving: a field the server has not shipped yet, or has renamed,
 * must degrade to "not done" and never to a crashed `pagr connect`. Unknown fields are dropped
 * by zod, so the server may add more at any time.
 */
export const OnboardingFacts = z.object({
  /** A card-backed trial or subscription exists. Agents refuse to work without it. */
  entitled: z.boolean().default(false).catch(false),
  /** A phone is attached to the account, so agents can text the person. */
  messagingLinked: z.boolean().default(false).catch(false),
  hasProject: z.boolean().default(false).catch(false),
  claudeConnected: z.boolean().default(false).catch(false),
  codexConnected: z.boolean().default(false).catch(false),
});
export type OnboardingFacts = z.infer<typeof OnboardingFacts>;

export const PairStatusResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('rejected') }),
  z.object({ status: z.literal('used') }),
  z.object({
    status: z.literal('completed'),
    deviceId: z.string().regex(/^dev_[0-9a-f]{32}$/),
    userId: z.string().regex(/^usr_[0-9a-f]{32}$/),
    gatewayUrl: z.string().url(),
    serverKeys: z.record(z.string()),
    /** Added by the API alongside onboarding; absent on an older server. */
    onboarding: OnboardingFacts.optional(),
    /** The number to text, or null on a provider with no published line. */
    productNumber: z.string().nullable().optional(),
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
  /** Sent so the cloud can invalidate the device this pairing replaces (`connect --force`). */
  replacesDeviceId?: string;
  /** Per-request ceiling; a hung connection must never hang `pagr connect`. */
  requestTimeoutMs?: number;
  /** Retries for transient (network / 5xx) failures. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with the measured clock skew (ms, positive = this Mac is ahead) when known. */
  onClockSkew?: (skewMs: number) => void;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MAX_DETAIL = 160;

/** One-line, length-capped excerpt of a response body, safe to show a user. */
export function bodyExcerpt(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const looksLikeHtml = (text: string, contentType: string): boolean =>
  contentType.includes('html') || /^\s*<(?:!doctype|html|head|body)/i.test(text);

/**
 * Dig the errno out of whatever undici threw. A refused connection arrives as
 * `TypeError: fetch failed` whose `cause` is an `AggregateError` holding the real
 * `ECONNREFUSED` — so we have to walk `cause` AND `errors`, or every network failure
 * degrades to the useless "fetch failed".
 */
function errnoOf(err: unknown, depth = 0): string | undefined {
  if (!err || depth > 5) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code !== 'ERR_INVALID_STATE') return code;
  const nested = (err as { errors?: unknown }).errors;
  if (Array.isArray(nested))
    for (const e of nested) {
      const found = errnoOf(e, depth + 1);
      if (found) return found;
    }
  return errnoOf((err as { cause?: unknown }).cause, depth + 1);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const FETCH_FAILURES: Record<string, { message: (host: string) => string; hint: string }> = {
  ENOTFOUND: {
    message: (h) => `cannot resolve ${h} (DNS lookup failed)`,
    hint: 'check your internet connection and DNS, or pass --api-url if you meant a local stack',
  },
  EAI_AGAIN: {
    message: (h) => `cannot resolve ${h} (DNS temporarily unavailable)`,
    hint: 'your network is not ready yet — reconnect to Wi-Fi and retry',
  },
  ECONNREFUSED: {
    message: (h) => `${h} refused the connection`,
    hint: 'nothing is listening there — is the API URL right? (--api-url / PAGR_API_URL)',
  },
  ECONNRESET: {
    message: (h) => `${h} reset the connection`,
    hint: 'a proxy or firewall is cutting the connection; retry, or try off the VPN',
  },
  ETIMEDOUT: {
    message: (h) => `${h} did not respond (connection timed out)`,
    hint: 'outbound HTTPS looks blocked; the bridge only needs outbound TLS on 443',
  },
  EHOSTUNREACH: {
    message: (h) => `${h} is unreachable`,
    hint: 'check your network connection',
  },
  ENETUNREACH: {
    message: () => 'the network is unreachable',
    hint: 'check your network connection',
  },
  CERT_HAS_EXPIRED: {
    message: (h) => `the TLS certificate for ${h} has expired`,
    hint: "check this Mac's clock and date, then retry",
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    message: (h) => `could not verify the TLS certificate for ${h}`,
    hint: 'a TLS-intercepting proxy is in the way; pagr will not skip certificate verification',
  },
  SELF_SIGNED_CERT_IN_CHAIN: {
    message: (h) => `the TLS certificate for ${h} is self-signed`,
    hint: 'a TLS-intercepting proxy is in the way; pagr will not skip certificate verification',
  },
};

/** Map a thrown fetch/abort error onto a `network` PairingError with a plain-language message. */
export function describeFetchFailure(url: string, err: unknown, timeoutMs: number): PairingError {
  const host = safeHost(url);
  if (err instanceof Error && err.name === 'AbortError')
    return new PairingError('network', `${host} did not respond within ${timeoutMs}ms`, {
      hint: 'the API may be slow or a proxy is holding the connection; retry, or check your VPN',
      cause: err,
    });
  const code = errnoOf(err);
  const known = code ? FETCH_FAILURES[code] : undefined;
  if (known)
    return new PairingError('network', known.message(host), { hint: known.hint, cause: err });
  const raw = err instanceof Error ? err.message : String(err);
  return new PairingError('network', `could not reach ${host}: ${raw}`, {
    hint: 'check your network, or pass --api-url / set PAGR_API_URL',
    cause: err,
  });
}

interface JsonResult {
  json: unknown;
  response: Response;
}

export interface RequestOptions {
  timeoutMs?: number;
  method?: string;
  body?: string;
}

/** One HTTP round-trip that can only fail as a `PairingError`. */
async function requestJson(
  fetchFn: FetchFn,
  url: string,
  o: RequestOptions = {},
): Promise<JsonResult> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: o.method ?? 'GET',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: controller.signal,
      ...(o.body === undefined ? {} : { body: o.body }),
    });
  } catch (err) {
    throw describeFetchFailure(url, err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
  const text = await safeText(response);
  if (!response.ok) throw httpError(url, response, text);
  const contentType = (response.headers?.get('content-type') ?? '').toLowerCase();
  if (looksLikeHtml(text, contentType))
    throw new PairingError('invalid_response', `${safeHost(url)} returned an HTML page, not JSON`, {
      status: response.status,
      detail: bodyExcerpt(text),
      hint: 'a captive portal or proxy is intercepting the request, or --api-url points at the website instead of the API',
    });
  try {
    return { json: JSON.parse(text), response };
  } catch {
    throw new PairingError('invalid_response', `${safeHost(url)} returned a malformed JSON body`, {
      status: response.status,
      detail: bodyExcerpt(text),
      hint: 'update the CLI (`npm i -g @pagr/cli@latest`); if it persists, run `pagr doctor --json` and send it to support',
    });
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function httpError(url: string, response: Response, text: string): PairingError {
  const status = response.status;
  const detail = bodyExcerpt(text);
  const host = safeHost(url);
  if (status === 404)
    return new PairingError('not_found', `${host} has no pairing endpoint (HTTP 404)`, {
      status,
      detail,
      hint: 'the API URL is wrong or the server is older than this CLI — check --api-url / PAGR_API_URL',
    });
  if (status === 401 || status === 403)
    return new PairingError('unauthorized', `${host} rejected the request (HTTP ${status})`, {
      status,
      detail,
      hint: 'this Mac is not allowed to pair with that API — check the API URL, or contact support',
    });
  if (status === 426)
    return new PairingError('unsupported', 'this version of the pagr CLI is no longer supported', {
      status,
      detail,
      hint: 'update with `npm i -g @pagr/cli@latest`, then run `pagr connect` again',
    });
  if (status === 410)
    return new PairingError('expired', 'the pairing code expired', {
      status,
      detail,
      hint: 'run `pagr connect` again for a fresh code',
    });
  if (status === 409)
    return new PairingError('used', 'that pairing code was already used', {
      status,
      detail,
      hint: 'run `pagr connect` again for a fresh code',
    });
  if (status >= 500)
    return new PairingError('server_error', `${host} returned HTTP ${status}`, {
      status,
      detail,
      hint: 'the Pagr API is having trouble — retry in a minute, then run `pagr doctor`',
    });
  return new PairingError('http', `${host} returned HTTP ${status}`, {
    status,
    detail,
    hint: 'run `pagr doctor --json` and send the output to support',
  });
}

/** `Date:` header vs the local clock. Positive = this Mac is ahead of the server. */
export function clockSkewMs(response: Response, localNowMs: number): number | null {
  const header = response.headers?.get('date');
  if (!header) return null;
  const server = Date.parse(header);
  if (!Number.isFinite(server)) return null;
  return localNowMs - server;
}

/** Skew beyond this breaks signed-command expiry windows, so it is worth shouting about. */
export const MAX_TOLERABLE_CLOCK_SKEW_MS = 60_000;

/** Human phrasing for a measured skew, e.g. "2m ahead of". */
export function describeClockSkew(skewMs: number): string {
  const abs = Math.abs(skewMs);
  const unit =
    abs >= 3600_000
      ? `${Math.round(abs / 3600_000)}h`
      : abs >= 60_000
        ? `${Math.round(abs / 60_000)}m`
        : `${Math.round(abs / 1000)}s`;
  return `${unit} ${skewMs > 0 ? 'ahead of' : 'behind'}`;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * NOT unref-ed, deliberately. An unref-ed timer lets Node's event loop drain while we are
 * waiting between polls, so `pagr connect` would print the pairing code and then exit 0
 * silently the moment it went idle. The wait IS the work here.
 */
export const sleepMs = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultSleep = sleepMs;

async function withRetries<T>(
  attempts: number,
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err instanceof PairingError) || !err.retryable || i === attempts) throw err;
      await sleep(Math.min(4000, 500 * 2 ** i));
    }
  }
  throw last;
}

/** Ask the cloud for a pairing code. Only the PUBLIC key leaves the machine. */
export async function startPairing(opts: PairingOptions): Promise<PairStartResponse> {
  const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const url = `${opts.apiUrl.replace(/\/$/, '')}/v1/devices/pair/start`;
  const body = JSON.stringify({
    publicKey: opts.identity.publicKeyRaw,
    deviceName: opts.deviceName,
    platform: 'darwin',
    osVersion: opts.osVersion ?? release(),
    bridgeVersion: opts.bridgeVersion,
    protocolVersion: PROTOCOL_VERSION,
    ...(opts.replacesDeviceId ? { replacesDeviceId: opts.replacesDeviceId } : {}),
  });
  const { json, response } = await withRetries(opts.retries ?? 2, sleep, () =>
    requestJson(fetchFn, url, {
      method: 'POST',
      body,
      ...(opts.requestTimeoutMs === undefined ? {} : { timeoutMs: opts.requestTimeoutMs }),
    }),
  );
  const skew = clockSkewMs(response, now());
  if (skew !== null) opts.onClockSkew?.(skew);
  const parsed = PairStartResponse.safeParse(json);
  if (!parsed.success)
    throw new PairingError(
      'invalid_response',
      'the API returned an unexpected pair/start response',
      {
        ...(parsed.error.issues[0]
          ? {
              detail: `${parsed.error.issues[0].path.join('.') || '(root)'}: ${parsed.error.issues[0].message}`,
            }
          : {}),
        hint: 'update the CLI (`npm i -g @pagr/cli@latest`) — this API speaks a newer pairing shape',
      },
    );
  assertSupported(parsed.data, opts.bridgeVersion);
  return parsed.data;
}

/** Refuse to continue against an API this CLI cannot speak to correctly. */
export function assertSupported(started: PairStartResponse, bridgeVersion: string): void {
  if (started.minBridgeVersion && compareVersions(bridgeVersion, started.minBridgeVersion) < 0)
    throw new PairingError(
      'unsupported',
      `this Mac runs pagr ${bridgeVersion} but the server requires ${started.minBridgeVersion} or newer`,
      { hint: 'run `npm i -g @pagr/cli@latest`, then `pagr connect` again' },
    );
  if (started.protocolVersion !== undefined && started.protocolVersion !== PROTOCOL_VERSION)
    throw new PairingError(
      'unsupported',
      `the API speaks device protocol v${started.protocolVersion}; this CLI speaks v${PROTOCOL_VERSION}`,
      {
        hint:
          started.protocolVersion > PROTOCOL_VERSION
            ? 'run `npm i -g @pagr/cli@latest`, then `pagr connect` again'
            : 'this CLI is newer than the API — point --api-url at the right environment',
      },
    );
}

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

export interface PollProgress {
  attempt: number;
  elapsedMs: number;
  remainingMs: number;
  /** Set when the last attempt failed transiently and we are retrying. */
  transientError?: PairingError;
}

export interface PollOptions {
  apiUrl: string;
  pairingId: string;
  fetch?: FetchFn;
  intervalMs?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  /** Consecutive transient failures tolerated before giving up. */
  maxTransientFailures?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (p: PollProgress) => void;
  /** Aborts the poll loop (Ctrl-C). */
  signal?: AbortSignal;
}

export type PairingCompleted = Extract<PairStatusResponse, { status: 'completed' }>;

export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;

/**
 * Poll until the user approves in the browser. Never loops forever: bounded by `timeoutMs`,
 * and by `maxTransientFailures` consecutive network/5xx errors. Transient failures do NOT
 * abort the flow — a laptop flipping from Wi-Fi to LTE mid-approval must still succeed.
 */
export async function pollPairing(opts: PollOptions): Promise<PairingCompleted> {
  const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const maxTransient = opts.maxTransientFailures ?? 5;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const url = `${opts.apiUrl.replace(/\/$/, '')}/v1/devices/pair/status/${encodeURIComponent(opts.pairingId)}`;
  let transientRun = 0;
  let lastTransient: PairingError | null = null;
  const progress = (attempt: number, transientError?: PairingError) =>
    opts.onProgress?.({
      attempt,
      elapsedMs: now() - startedAt,
      remainingMs: Math.max(0, deadline - now()),
      ...(transientError ? { transientError } : {}),
    });
  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw canceledError();
    let json: unknown;
    try {
      json = (
        await requestJson(fetchFn, url, {
          method: 'GET',
          ...(opts.requestTimeoutMs === undefined ? {} : { timeoutMs: opts.requestTimeoutMs }),
        })
      ).json;
      transientRun = 0;
      lastTransient = null;
    } catch (err) {
      if (!(err instanceof PairingError) || !err.retryable) throw err;
      lastTransient = err;
      if (++transientRun > maxTransient)
        throw new PairingError(
          err.code,
          `lost contact with the API while waiting for approval: ${err.message}`,
          {
            hint: err.hint ?? 'check your network and run `pagr connect` again',
            ...(err.status === undefined ? {} : { status: err.status }),
            cause: err,
          },
        );
      progress(attempt, err);
      if (now() >= deadline) throw pollTimeout(timeoutMs);
      await sleep(intervalMs);
      continue;
    }
    const parsed = PairStatusResponse.safeParse(json);
    if (!parsed.success) throw unexpectedStatus(json, parsed.error.issues[0]?.message);
    const s = parsed.data;
    if (s.status === 'completed') return s;
    if (s.status === 'expired')
      throw new PairingError('expired', 'the pairing code expired before it was approved', {
        hint: 'run `pagr connect` again — codes are short-lived and nothing was registered',
      });
    if (s.status === 'rejected')
      throw new PairingError('rejected', 'the pairing request was declined in the dashboard', {
        hint: 'run `pagr connect` again and approve it with the account you want to use',
      });
    if (s.status === 'used')
      throw new PairingError('used', 'that pairing code was already used by another device', {
        hint: 'run `pagr connect` again for a fresh code',
      });
    progress(attempt, lastTransient ?? undefined);
    if (now() >= deadline) throw pollTimeout(timeoutMs);
    await sleep(intervalMs);
  }
}

const pollTimeout = (timeoutMs: number) =>
  new PairingError(
    'timeout',
    `nobody approved this Mac within ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`,
    {
      hint: 'nothing was registered — run `pagr connect` again and approve the code in the browser',
    },
  );

const canceledError = () =>
  new PairingError('timeout', 'pairing canceled', { hint: 'run `pagr connect` again' });

const KNOWN_STATUSES = new Set(['pending', 'expired', 'rejected', 'used', 'completed']);

/**
 * Distinguish "the API speaks a status we have never heard of" (update the CLI) from "a status
 * we know, with a payload we cannot trust" (the API is broken, or something is rewriting it).
 */
function unexpectedStatus(json: unknown, issue: string | undefined): PairingError {
  const seen =
    json && typeof json === 'object' && typeof (json as { status?: unknown }).status === 'string'
      ? (json as { status: string }).status
      : undefined;
  if (seen && !KNOWN_STATUSES.has(seen))
    return new PairingError(
      'unsupported',
      `the API reported pairing status "${seen}", which this CLI does not understand`,
      {
        ...(issue === undefined ? {} : { detail: issue }),
        hint: 'update the CLI with `npm i -g @pagr/cli@latest`',
      },
    );
  return new PairingError(
    'invalid_response',
    seen
      ? `the API returned a "${seen}" pairing status with a payload this CLI cannot read`
      : 'the API returned an unexpected pair/status response',
    {
      ...(issue === undefined ? {} : { detail: issue }),
      hint: 'update the CLI with `npm i -g @pagr/cli@latest`; if it persists, run `pagr doctor --json` and send it to support',
    },
  );
}

// ---------------------------------------------------------------------------
// persist
// ---------------------------------------------------------------------------

/**
 * Persist the pairing result into `config.json` (no secrets) in ONE atomic write, so a crash
 * or Ctrl-C can never leave a half-paired config.
 */
export function persistPairing(
  configFile: string,
  result: PairingCompleted,
  extra: {
    apiUrl: string;
    deviceName: string;
    now?: () => Date;
    gatewayUrl?: string;
    /** Recorded so `status` and `doctor` can read the account facts later (see BridgeConfig). */
    pairingId?: string;
  },
): void {
  updateConfig(configFile, {
    deviceId: result.deviceId,
    userId: result.userId,
    gatewayUrl: extra.gatewayUrl ?? result.gatewayUrl,
    serverKeys: result.serverKeys,
    apiUrl: extra.apiUrl,
    deviceName: extra.deviceName,
    pairedAt: (extra.now ?? (() => new Date()))().toISOString(),
    ...(extra.pairingId ? { pairingId: extra.pairingId } : {}),
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
  persistPairing(opts.configFile, done, {
    apiUrl: opts.apiUrl,
    deviceName: opts.deviceName,
    pairingId: started.pairingId,
  });
  return done;
}

// ---------------------------------------------------------------------------
// onboarding
// ---------------------------------------------------------------------------

/**
 * What the account still needs, read back through the pairing this Mac already holds.
 *
 * The api has no device-signed HTTP auth, so there is no credential the CLI could present to
 * ask "is a phone linked yet?". What it does have is the pairing id — a random id only this Mac
 * holds — on a route that already answers with the user id, and which keeps answering after the
 * code has been spent. That is the whole mechanism: no session, no token, no new protocol.
 *
 * `onboarding: null` means the server did not send the block at all (an api older than this
 * CLI). Callers must treat that as "unknown" and skip their step, never as "nothing is done".
 */
export interface OnboardingStatus {
  onboarding: OnboardingFacts | null;
  productNumber: string | null;
}

export interface OnboardingReadOptions {
  apiUrl: string;
  pairingId: string;
  fetch?: FetchFn;
  requestTimeoutMs?: number;
}

const statusUrl = (apiUrl: string, pairingId: string) =>
  `${apiUrl.replace(/\/$/, '')}/v1/devices/pair/status/${encodeURIComponent(pairingId)}`;

/**
 * One read of the enriched pair status. Throws `PairingError` like the rest of this module;
 * callers that only want to decorate a report (`status`, `doctor`) catch and print "unknown".
 */
export async function readOnboarding(opts: OnboardingReadOptions): Promise<OnboardingStatus> {
  const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const { json } = await requestJson(fetchFn, statusUrl(opts.apiUrl, opts.pairingId), {
    method: 'GET',
    ...(opts.requestTimeoutMs === undefined ? {} : { timeoutMs: opts.requestTimeoutMs }),
  });
  return toOnboardingStatus(json);
}

function toOnboardingStatus(json: unknown): OnboardingStatus {
  const parsed = PairStatusResponse.safeParse(json);
  if (!parsed.success || parsed.data.status !== 'completed')
    return { onboarding: null, productNumber: null };
  return {
    onboarding: parsed.data.onboarding ?? null,
    productNumber: parsed.data.productNumber ?? null,
  };
}

const ProductLineResponse = z.object({ productNumber: z.string().nullable().default(null) });

/**
 * `GET /v1/messaging/line` — the number to text, for the steps that need it before anybody is
 * signed in. Public and rate-limited; `null` on a provider with no published line, where the
 * conversation has to be started by us instead.
 */
export async function readProductNumber(opts: {
  apiUrl: string;
  fetch?: FetchFn;
  requestTimeoutMs?: number;
}): Promise<string | null> {
  const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const { json } = await requestJson(
    fetchFn,
    `${opts.apiUrl.replace(/\/$/, '')}/v1/messaging/line`,
    {
      method: 'GET',
      ...(opts.requestTimeoutMs === undefined ? {} : { timeoutMs: opts.requestTimeoutMs }),
    },
  );
  const parsed = ProductLineResponse.safeParse(json);
  return parsed.success ? parsed.data.productNumber : null;
}

/** Why `pollOnboarding` stopped. None of them is an error: setup continues either way. */
export type OnboardingOutcome =
  /** `until` came true. */
  | 'satisfied'
  /** The server never sent an `onboarding` block — an api older than this CLI. */
  | 'unsupported'
  /** We stopped waiting. The Mac is finished and working; the account step is not. */
  | 'timeout'
  /** Ctrl-C. */
  | 'canceled'
  /** The api could not be reached often enough to keep asking. */
  | 'error';

export interface OnboardingPollResult extends OnboardingStatus {
  outcome: OnboardingOutcome;
  /** Set when `outcome` is `error`; the last thing that went wrong. */
  error?: PairingError;
}

export interface PollOnboardingOptions extends OnboardingReadOptions {
  /** Stop as soon as this is true of the facts. */
  until: (facts: OnboardingFacts) => boolean;
  intervalMs?: number;
  timeoutMs?: number;
  maxTransientFailures?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (p: PollProgress & { status: OnboardingStatus }) => void;
  signal?: AbortSignal;
}

export const DEFAULT_ONBOARDING_POLL_INTERVAL_MS = 3000;

/**
 * Poll the enriched pair status until `until` holds, or we run out of patience.
 *
 * Unlike `pollPairing` this NEVER throws: every way it can end is a reportable outcome. A person
 * whose Mac is paired, whose daemon is connected and whose agents are signed in has a working
 * install; whether they have got round to texting Pagr yet is not something `pagr connect` may
 * fail over, and a network wobble at that point certainly is not.
 */
export async function pollOnboarding(opts: PollOnboardingOptions): Promise<OnboardingPollResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? DEFAULT_ONBOARDING_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const maxTransient = opts.maxTransientFailures ?? 5;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let last: OnboardingStatus = { onboarding: null, productNumber: null };
  let transientRun = 0;

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) return { ...last, outcome: 'canceled' };
    try {
      last = await readOnboarding(opts);
      transientRun = 0;
    } catch (err) {
      if (!(err instanceof PairingError) || !err.retryable || ++transientRun > maxTransient)
        return {
          ...last,
          outcome: 'error',
          ...(err instanceof PairingError ? { error: err } : {}),
        };
      opts.onProgress?.({
        attempt,
        elapsedMs: now() - startedAt,
        remainingMs: Math.max(0, deadline - now()),
        transientError: err,
        status: last,
      });
      if (now() >= deadline) return { ...last, outcome: 'timeout' };
      await sleep(intervalMs);
      continue;
    }
    // An api that answers the route but carries no onboarding block will never carry one:
    // asking again for ten minutes would be a lie dressed as patience.
    if (!last.onboarding) return { ...last, outcome: 'unsupported' };
    if (opts.until(last.onboarding)) return { ...last, outcome: 'satisfied' };
    opts.onProgress?.({
      attempt,
      elapsedMs: now() - startedAt,
      remainingMs: Math.max(0, deadline - now()),
      status: last,
    });
    if (now() >= deadline) return { ...last, outcome: 'timeout' };
    await sleep(intervalMs);
  }
}
