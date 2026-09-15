import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentLeaseRegistry } from './attachmentLease.js';

describe('AttachmentLeaseRegistry', () => {
  const dir = '/tmp/pagr-lease-test/tmp';
  const mk = (o: { ttlMs?: number; now?: () => Date } = {}) => {
    const removed: string[] = [];
    const reg = new AttachmentLeaseRegistry({
      dir,
      remove: (p) => removed.push(p),
      ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    return { reg, removed };
  };
  const p = (name: string) => join(dir, name);

  it('holds files across the call that started the turn, and frees them when it ends', () => {
    const { reg, removed } = mk();
    reg.acquire('ses_1', [p('att_a.png')]);
    expect(reg.pathsFor('ses_1')).toEqual([p('att_a.png')]);
    expect(removed).toEqual([]);
    expect(reg.noteTurnEnded('ses_1')).toBe(1);
    expect(removed).toEqual([p('att_a.png')]);
    expect(reg.pathsFor('ses_1')).toEqual([]);
  });

  it('ignores the second end report for one turn (adapters send status AND event)', () => {
    const { reg, removed } = mk();
    reg.acquire('ses_1', [p('att_a.png')]);
    reg.acquire('ses_1', [p('att_b.png')]); // a follow-up queued behind the running turn
    reg.noteTurnEnded('ses_1');
    reg.noteTurnEnded('ses_1'); // duplicate report for the same turn
    expect(removed).toEqual([p('att_a.png')]);
    // the queued turn starts and ends: now its own images go
    reg.noteTurnStarted('ses_1');
    reg.noteTurnEnded('ses_1');
    expect(removed).toEqual([p('att_a.png'), p('att_b.png')]);
  });

  it('releases everything a stopped session held, and everything at shutdown', () => {
    const { reg, removed } = mk();
    reg.acquire('ses_1', [p('att_a.png'), p('att_b.png')]);
    reg.acquire('ses_1', [p('att_c.png')]);
    expect(reg.releaseSession('ses_1')).toBe(3);
    expect(removed).toHaveLength(3);
    reg.acquire('ses_2', [p('att_d.png')]);
    expect(reg.releaseAll()).toBe(1);
    expect(reg.size).toBe(0);
  });

  it('sweeps a lease whose turn never reported an end', () => {
    let now = new Date('2026-08-24T12:00:00Z');
    const { reg, removed } = mk({ ttlMs: 60_000, now: () => now });
    reg.acquire('ses_1', [p('att_a.png')]);
    now = new Date(now.getTime() + 59_000);
    expect(reg.sweep()).toBe(0);
    now = new Date(now.getTime() + 2_000);
    expect(reg.sweep()).toBe(1);
    expect(removed).toEqual([p('att_a.png')]);
    expect(reg.size).toBe(0);
  });

  it('never unlinks outside the attachments directory', () => {
    const { reg, removed } = mk();
    reg.acquire('ses_1', [
      join(dir, '..', 'config.json'),
      `${dir}/../../etc/hosts`,
      dir,
      p('att_ok.png'),
    ]);
    expect(reg.releaseAll()).toBe(1);
    expect(removed).toEqual([p('att_ok.png')]);
  });
});
