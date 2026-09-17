import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemon, type Daemon } from './daemon.js';
import { MemorySecretStore } from './keychain.js';
import { getMirrorBridge, type MirrorStatus, resetMirrorBridge } from './mirrorBridge.js';
import { projectIdFor } from './projects.js';
import { useTempHome } from './testUtil.js';

/**
 * The half of the mirror the daemon owns: turning a session's working directory into something
 * the phone can be shown, without ever letting a path out or registering a project nobody asked
 * for.
 */
describe('the daemon answers the mirror', () => {
  const t = useTempHome('pagr-daemon-mirror-');
  let daemon: Daemon;
  let home: string;
  let work: string;

  beforeEach(async () => {
    home = join(t.home, 'pagr');
    work = join(t.home, 'work');
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    daemon = await createDaemon({
      home,
      adapters: new Map(),
      secretStore: new MemorySecretStore(),
    });
  });
  afterEach(async () => {
    await daemon.stop();
    resetMirrorBridge();
  });

  it('names a registered project by its own id', () => {
    const repo = join(work, 'app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const rec = daemon.registry.add(repo);
    expect(getMirrorBridge().projectFor(join(repo, 'src'))).toEqual({
      projectId: rec.projectId,
      path: repo,
      displayName: rec.displayName,
      status: 'registered',
    });
  });

  it('reports an unregistered directory under its git root, with a handle to register it', () => {
    const repo = join(work, 'loose');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });
    const project = getMirrorBridge().projectFor(join(repo, 'src', 'deep'));
    expect(project).toMatchObject({
      projectId: projectIdFor(repo, daemon.registry.deviceSalt()),
      path: repo,
      displayName: basename(repo),
      status: 'unregistered',
    });
    expect(project?.handle).toMatch(/^rh_[0-9a-f]{32}$/);
    // Offering it is not registering it: the person still decides.
    expect(daemon.registry.list()).toHaveLength(0);
  });

  it('falls back to the directory itself when it is in no repository', () => {
    const loose = join(work, 'scratch');
    mkdirSync(loose, { recursive: true });
    expect(getMirrorBridge().projectFor(loose)).toMatchObject({
      path: loose,
      status: 'unregistered',
    });
  });

  it('puts the handle where `project.register_handle` will find it', async () => {
    const repo = join(work, 'pickme');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const handle = getMirrorBridge().projectFor(repo)?.handle as string;
    expect(daemon.status().remoteProjectPick.handles).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private command handler
    const summary = (daemon.dispatcher as any).registerRepoHandle({ handle }) as {
      projectId: string;
    };
    expect(daemon.registry.resolve(summary.projectId).path).toBe(repo);
  });

  it('carries the mirror status into `pagr doctor`', () => {
    expect(daemon.status().mirror).toBeUndefined();
    const status: MirrorStatus = {
      enabled: true,
      sessions: 1,
      filesWatched: 2,
      lastFrameAt: '2026-09-17T12:00:00.000Z',
      unknownRecordTypes: 0,
    };
    getMirrorBridge().report(status);
    expect(daemon.status().mirror).toEqual(status);
  });

  it('stops answering once the daemon has stopped', async () => {
    expect(getMirrorBridge().wired).toBe(true);
    await daemon.stop();
    expect(getMirrorBridge().wired).toBe(false);
    expect(getMirrorBridge().projectFor(work)).toBeNull();
  });
});
