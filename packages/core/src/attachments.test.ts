import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AttachmentRef } from '@pagr/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeDownloadUrl,
  cleanupTmp,
  deleteAttachment,
  fetchAttachment,
  fetchAttachment as fetchAttachmentRaw,
  sniffImageMime,
} from './attachments.js';
import { ids } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 2)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const LOCAL = { PAGR_ENV: 'local' };

describe('attachments', () => {
  const t = useTempHome('pagr-att-');
  let server: Server;
  let base: string;
  const routes = new Map<string, (res: import('node:http').ServerResponse) => void>();
  beforeAll(async () => {
    server = createServer((req, res) => {
      const h = routes.get(req.url ?? '');
      if (h) h(res);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    routes.set('/png', (res) => res.end(PNG));
    routes.set('/jpeg', (res) => res.end(JPEG));
    routes.set('/big', (res) => res.end(Buffer.concat([PNG, Buffer.alloc(1000)])));
    routes.set('/hang', () => undefined);
    routes.set('/500', (res) => {
      res.statusCode = 500;
      res.end();
    });
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const ref = (path: string, buf: Buffer, over: Partial<AttachmentRef> = {}): AttachmentRef => ({
    attachmentId: ids.att(),
    downloadUrl: `${base}${path}`,
    sha256: sha(buf),
    sizeBytes: buf.length,
    mimeType: 'image/png',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  });

  it('downloads, verifies, writes 0600 and deletes', async () => {
    const r = ref('/png', PNG);
    const p = await fetchAttachment(r, { tmpDir: join(t.home, 'tmp'), env: LOCAL });
    expect(p).toBe(join(t.home, 'tmp', `${r.attachmentId}.png`));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    deleteAttachment(p);
    expect(existsSync(p)).toBe(false);
    deleteAttachment(p); // idempotent
  });

  it('rejects hash mismatch, mime mismatch, oversize, http error, expired, timeout', async () => {
    const tmpDir = join(t.home, 'tmp');
    const fetchAttachment = (r: AttachmentRef, o: { tmpDir: string; timeoutMs?: number }) =>
      fetchAttachmentRaw(r, { ...o, env: LOCAL });
    await expect(
      fetchAttachment(ref('/png', PNG, { sha256: 'a'.repeat(64) }), { tmpDir }),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
    await expect(fetchAttachment(ref('/jpeg', JPEG), { tmpDir })).rejects.toMatchObject({
      code: 'mime_mismatch',
    });
    await expect(fetchAttachment(ref('/big', PNG), { tmpDir })).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(fetchAttachment(ref('/500', PNG), { tmpDir })).rejects.toMatchObject({
      code: 'http',
    });
    await expect(
      fetchAttachment(ref('/png', PNG, { expiresAt: new Date(Date.now() - 1000).toISOString() }), {
        tmpDir,
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    await expect(
      fetchAttachment(ref('/hang', PNG), { tmpDir, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(existsSync(tmpDir) ? statSync(tmpDir).isDirectory() : true).toBe(true);
  });

  it('sniffs magic bytes', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0'))).toBe('image/heic');
    expect(sniffImageMime(Buffer.from('<html>'))).toBeNull();
  });

  it('cleanupTmp removes only old att_ files', () => {
    const tmpDir = join(t.home, 'tmp');
    const old = join(tmpDir, 'att_old.png');
    const fresh = join(tmpDir, 'att_new.png');
    const other = join(tmpDir, 'keep.txt');
    mkdirSync(tmpDir, { recursive: true });
    for (const f of [old, fresh, other]) writeFileSync(f, 'x');
    const past = new Date(Date.now() - 48 * 3600_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(cleanupTmp(tmpDir, 24 * 3600_000)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(cleanupTmp(join(t.home, 'missing'), 1)).toBe(0);
  });

  it('refuses non-https and private/literal-IP download URLs before fetching (finding 10)', async () => {
    const tmpDir = join(t.home, 'tmp');
    let fetched = 0;
    const fetch = async () => {
      fetched++;
      return new Response(PNG);
    };
    const attempt = (downloadUrl: string, env: Record<string, string> = {}) =>
      fetchAttachment(ref('/png', PNG, { downloadUrl }), { tmpDir, fetch, env });
    const bad = [
      'http://example.com/a.png',
      'ftp://example.com/a.png',
      'https://10.0.0.5/a.png',
      'https://172.16.3.4/a.png',
      'https://172.31.255.255/a.png',
      'https://192.168.1.1/a.png',
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/a.png',
      'https://0.0.0.0/a.png',
      'https://[::1]/a.png',
      'https://[fe80::1]/a.png',
      'https://[fc00::1]/a.png',
      'https://[fd12::1]/a.png',
      'https://8.8.8.8/a.png',
      'https://[2001:db8::1]/a.png',
      'https://localhost/a.png',
      'http://localhost/a.png',
      'not a url',
    ];
    for (const u of bad) {
      await expect(attempt(u), u).rejects.toMatchObject({ code: 'unsafe_url' });
    }
    expect(fetched).toBe(0);
    await expect(attempt('https://cdn.example.com/a.png')).resolves.toMatch(/\.png$/);
    expect(fetched).toBe(1);
    // PAGR_ENV=local additionally allows plain-http loopback, but nothing else.
    await expect(attempt('http://localhost:3000/a.png', LOCAL)).resolves.toMatch(/\.png$/);
    await expect(attempt('http://127.0.0.1:3000/a.png', LOCAL)).resolves.toMatch(/\.png$/);
    await expect(attempt('http://10.0.0.5/a.png', LOCAL)).rejects.toMatchObject({
      code: 'unsafe_url',
    });
    await expect(attempt('http://example.com/a.png', LOCAL)).rejects.toMatchObject({
      code: 'unsafe_url',
    });
    expect(() => assertSafeDownloadUrl('https://[::ffff:10.0.0.1]/x')).toThrow(
      /unsafe_url|private/i,
    );
    expect(() => assertSafeDownloadUrl('https://cdn.example.com/x')).not.toThrow();
  });
});
