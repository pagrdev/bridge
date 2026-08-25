import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { AttachmentRef } from '@pagr/protocol';

export class AttachmentError extends Error {
  constructor(
    readonly code:
      | 'expired'
      | 'timeout'
      | 'http'
      | 'too_large'
      | 'hash_mismatch'
      | 'mime_mismatch'
      | 'network'
      | 'unsafe_url',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface FetchAttachmentOptions {
  tmpDir: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  /** Environment for the URL policy (`PAGR_ENV=local` allows plain-http loopback). */
  env?: NodeJS.ProcessEnv;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function ipv4Private(host: string): boolean {
  const o = host.split('.').map(Number);
  const [a, b] = o as [number, number];
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return true;
  return (
    a === 0 || // 0.0.0.0/8 incl. 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function ipv6Private(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  // fc00::/7 (fc.. / fd..), fe80::/10 (fe8.. .. feb..)
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  // IPv4-mapped (::ffff:a.b.c.d, or the normalized ::ffff:a0b:c0d) — defer to the v4 rules
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted?.[1]) return ipv4Private(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
}

/**
 * Attachment downloads must go to a public `https:` host. Literal IP hosts are refused
 * outright (and private / link-local / loopback ranges are named explicitly so the reason is
 * clear). With `PAGR_ENV=local`, plain `http://localhost` / `http://127.0.0.1` is also allowed.
 * Never call this with anything but the URL the cloud handed us; it never performs DNS.
 */
export function assertSafeDownloadUrl(url: string, env: NodeJS.ProcessEnv = process.env): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AttachmentError('unsafe_url', 'downloadUrl is not a valid URL');
  }
  const local = env.PAGR_ENV === 'local';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol === 'http:' && local && LOOPBACK_HOSTS.has(u.hostname)) return;
  if (u.protocol !== 'https:')
    throw new AttachmentError('unsafe_url', `downloadUrl must be https:// (got ${u.protocol}//)`);
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost'))
    throw new AttachmentError('unsafe_url', 'downloadUrl must not point at localhost');
  const v = isIP(host);
  if (v === 4 && ipv4Private(host))
    throw new AttachmentError(
      'unsafe_url',
      `downloadUrl host ${host} is a private/loopback/link-local address`,
    );
  if (v === 6 && ipv6Private(host))
    throw new AttachmentError(
      'unsafe_url',
      `downloadUrl host ${host} is a private/loopback/link-local address`,
    );
  if (v !== 0)
    throw new AttachmentError('unsafe_url', 'downloadUrl must use a hostname, not a literal IP');
}

const EXT: Record<AttachmentRef['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/webp': 'webp',
};

/** Sniff image type from magic bytes. Extension/Content-Type are never trusted. */
export function sniffImageMime(buf: Uint8Array): AttachmentRef['mimeType'] | null {
  const b = Buffer.from(buf);
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'avif'].includes(brand))
      return 'image/heic';
  }
  return null;
}

/**
 * Download a device-bound attachment to `tmp/att_<id>.<ext>` (0600) after verifying size,
 * sha256, and magic bytes. Callers must `deleteAttachment` when the agent has consumed it.
 */
export async function fetchAttachment(
  ref: AttachmentRef,
  opts: FetchAttachmentOptions,
): Promise<string> {
  const now = (opts.now ?? (() => new Date()))();
  if (Date.parse(ref.expiresAt) <= now.getTime())
    throw new AttachmentError('expired', 'attachment download authorization expired');
  assertSafeDownloadUrl(ref.downloadUrl, opts.env);
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await doFetch(ref.downloadUrl, { signal: ctl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw new AttachmentError('timeout', 'download timed out');
    throw new AttachmentError('network', err instanceof Error ? err.message : String(err));
  }
  try {
    if (!res.ok) throw new AttachmentError('http', `download failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > ref.sizeBytes)
      throw new AttachmentError('too_large', 'content-length exceeds declared size');
    const body = await readCapped(res, ref.sizeBytes, ctl.signal);
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== ref.sha256) throw new AttachmentError('hash_mismatch', 'sha256 mismatch');
    const sniffed = sniffImageMime(body);
    if (sniffed !== ref.mimeType)
      throw new AttachmentError(
        'mime_mismatch',
        `content is ${sniffed ?? 'unknown'}, expected ${ref.mimeType}`,
      );
    mkdirSync(opts.tmpDir, { recursive: true, mode: 0o700 });
    const localPath = join(opts.tmpDir, `${ref.attachmentId}.${EXT[ref.mimeType]}`);
    writeFileSync(localPath, body, { mode: 0o600 });
    return localPath;
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    if (ctl.signal.aborted) throw new AttachmentError('timeout', 'download timed out');
    throw new AttachmentError('network', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) throw new AttachmentError('timeout', 'download timed out');
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new AttachmentError('too_large', 'body exceeds declared size');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function deleteAttachment(localPath: string): void {
  try {
    unlinkSync(localPath);
  } catch {
    // already gone
  }
}

/** Remove attachments in `tmpDir` older than `olderThanMs`. Returns number removed. */
export function cleanupTmp(
  tmpDir: string,
  olderThanMs: number,
  now: () => Date = () => new Date(),
): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(tmpDir);
  } catch {
    return 0;
  }
  const cutoff = now().getTime() - olderThanMs;
  for (const name of names) {
    if (!name.startsWith('att_')) continue;
    const p = join(tmpDir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        n++;
      }
    } catch {
      // ignore
    }
  }
  return n;
}
