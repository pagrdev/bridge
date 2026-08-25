import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
      | 'network',
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
