import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeviceEvent, Provider, RepoScanResult } from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { referencedIds } from './commandGuard.js';
import { Dispatcher, REPO_SCAN_MIN_INTERVAL_MS } from './dispatcher.js';
import { ProjectRegistry } from './projects.js';
import { REPO_HANDLE_TTL_MS } from './repoScan.js';
import { SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

const repo = (root: string, ...segments: string[]): string => {
  const dir = join(root, ...segments);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'config'),
    '[remote "origin"]\n\turl = git@github.com:acme/x.git\n',
  );
  return dir;
};

/**
 * `repo.scan` and `project.register_handle` on a synthetic HOME. Every assertion here is about
 * the same promise: a phone can pick a repository the Mac found without the path — or anything a
 * path could be reconstructed from — ever crossing the wire.
 */
describe('Dispatcher · remote project pick', () => {
  const t = useTempHome('pagr-repo-scan-');
  const deviceId = ids.dev();
  let registry: ProjectRegistry;
  let events: DeviceEvent[];
  let now: Date;
  let home: string;

  const build = (env: NodeJS.ProcessEnv = {}): Dispatcher =>
    new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>([['claude', new FakeAdapter('claude')]]),
      registry,
      sessions: new SessionStore(),
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      env,
      now: () => now,
      osVersion: '25.0.0',
    });

  beforeEach(() => {
    now = new Date('2026-09-17T12:00:00Z');
    home = join(t.home, 'home');
    mkdirSync(home, { recursive: true });
    repo(home, 'code', 'alpha');
    repo(home, 'Developer', 'beta');
    repo(home, 'Library', 'Caches', 'sneaky');
    registry = new ProjectRegistry({
      home,
      pagrHome: join(home, '.pagr'),
      file: join(home, '.pagr', 'projects.json'),
    });
    events = [];
  });

  const body = <T extends Parameters<typeof makeBody>[0]>(
    type: T,
    payload: Parameters<typeof makeBody<T>>[1],
  ) => makeBody(type, payload, { deviceId, now });

  const scan = async (d: Dispatcher) => d.handle(body('repo.scan', {}));
  const resultOf = (ack: DeviceEvent) => (ack.payload as { result?: unknown }).result;
  const statusOf = (ack: DeviceEvent) => ack.payload as { status: string; errorCode?: string };

  it('never returns a path', async () => {
    const d = build();
    const ack = await scan(d);
    expect(statusOf(ack).status).toBe('completed');
    const result = resultOf(ack) as RepoScanResult;
    expect(result.repos.map((r) => r.displayName).sort()).toEqual(['alpha', 'beta']);

    // Everything but the repo hint (which may carry `owner/name`) must be slash-free, and the
    // whole ack must not contain the home directory under any spelling.
    const withoutHints = JSON.stringify(result.repos.map(({ repoHint: _hint, ...rest }) => rest));
    expect(withoutHints).not.toContain('/');
    expect(JSON.stringify(ack)).not.toContain(home);
    expect(JSON.stringify(ack)).not.toContain('Library');
    for (const r of result.repos) expect(r.handle).toMatch(/^rh_[0-9a-f]{32}$/);
  });

  it('registers a repository from its handle, and says so', async () => {
    const d = build();
    const result = resultOf(await scan(d)) as RepoScanResult;
    const alpha = result.repos.find((r) => r.displayName === 'alpha');

    const ack = await d.handle(
      body('project.register_handle', { handle: alpha?.handle ?? '', displayName: 'Alpha' }),
    );
    expect(statusOf(ack).status).toBe('completed');
    const summary = resultOf(ack) as { projectId: string; displayName: string };
    expect(summary.displayName).toBe('Alpha');
    expect(registry.resolve(summary.projectId).path).toBe(join(home, 'code', 'alpha'));

    const registered = events.filter((e) => e.type === 'project.registered');
    expect(registered.length).toBe(1);
    expect((registered[0]?.payload as { projectId?: string } | undefined)?.projectId).toBe(
      summary.projectId,
    );
    expect(JSON.stringify(registered[0])).not.toContain(home);
  });

  it('registers the folder the handle named, not one the cloud chose', async () => {
    const d = build();
    const result = resultOf(await scan(d)) as RepoScanResult;
    const beta = result.repos.find((r) => r.displayName === 'beta');
    const ack = await d.handle(body('project.register_handle', { handle: beta?.handle ?? '' }));
    const summary = resultOf(ack) as { projectId: string };
    expect(registry.resolve(summary.projectId).path).toBe(join(home, 'Developer', 'beta'));
    expect(existsSync(join(home, 'Developer', 'beta'))).toBe(true);
  });

  it('reports a repository that is already a project instead of adding it twice', async () => {
    const d = build();
    const first = resultOf(await scan(d)) as RepoScanResult;
    const alpha = first.repos.find((r) => r.displayName === 'alpha');
    const summary = resultOf(
      await d.handle(body('project.register_handle', { handle: alpha?.handle ?? '' })),
    ) as { projectId: string };

    now = new Date(now.getTime() + REPO_SCAN_MIN_INTERVAL_MS);
    const second = resultOf(await scan(d)) as RepoScanResult;
    expect(second.repos.find((r) => r.displayName === 'alpha')?.registeredAs).toBe(
      summary.projectId,
    );
    expect(registry.list().length).toBe(1);
  });

  it('refuses a handle it never issued', async () => {
    const d = build();
    const ack = await d.handle(body('project.register_handle', { handle: ids.rh() }));
    expect(statusOf(ack)).toMatchObject({ status: 'failed', errorCode: 'unknown_project' });
    expect(registry.list().length).toBe(0);
  });

  it('refuses a handle that has expired', async () => {
    const d = build();
    const result = resultOf(await scan(d)) as RepoScanResult;
    const handle = result.repos[0]?.handle ?? '';

    now = new Date(now.getTime() + REPO_HANDLE_TTL_MS + 1);
    const ack = await d.handle(body('project.register_handle', { handle }));
    expect(statusOf(ack)).toMatchObject({ status: 'failed', errorCode: 'unknown_project' });
    expect(registry.list().length).toBe(0);
  });

  it('rate limits a repeated scan, and lets one through again afterwards', async () => {
    const d = build();
    expect(statusOf(await scan(d)).status).toBe('completed');

    const second = await scan(d);
    expect(statusOf(second)).toMatchObject({ status: 'failed', errorCode: 'rate_limited' });
    expect(resultOf(second)).toBeUndefined();

    now = new Date(now.getTime() + REPO_SCAN_MIN_INTERVAL_MS - 1);
    expect(statusOf(await scan(d)).errorCode).toBe('rate_limited');

    now = new Date(now.getTime() + 1);
    expect(statusOf(await scan(d)).status).toBe('completed');
  });

  it('is off when PAGR_REMOTE_PROJECT_PICK=0, and says so in both directions', async () => {
    const d = build({ PAGR_REMOTE_PROJECT_PICK: '0' });
    expect(statusOf(await scan(d))).toMatchObject({
      status: 'failed',
      errorCode: 'capability_unsupported',
    });
    expect(
      statusOf(await d.handle(body('project.register_handle', { handle: ids.rh() }))),
    ).toMatchObject({ status: 'failed', errorCode: 'capability_unsupported' });

    const hello = await d.probe();
    expect(hello.capabilities ?? []).not.toContain('repo_scan.v1');
    expect(d.remoteProjectPick()).toEqual({ enabled: false, handles: 0 });
  });

  it('advertises repo_scan.v1 while it is on', async () => {
    const d = build();
    const hello = await d.probe();
    expect(hello.capabilities).toContain('repo_scan.v1');
    await scan(d);
    expect(d.remoteProjectPick()).toEqual({ enabled: true, handles: 2 });
  });
});

describe('referencedIds', () => {
  const deviceId = ids.dev();

  it('sends neither command to the registry: a handle is not an id', () => {
    // A guard lookup would have to be told about the scan cache, and would answer the same
    // question the dispatcher answers a line later — where an unknown handle is already refused.
    expect(referencedIds(makeBody('repo.scan', {}, { deviceId }))).toEqual({});
    expect(
      referencedIds(makeBody('project.register_handle', { handle: ids.rh() }, { deviceId })),
    ).toEqual({});
  });
});
