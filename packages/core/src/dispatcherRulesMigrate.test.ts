import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentConnectionStatus,
  CommandBody,
  DeviceEvent,
  EventPayload,
  Provider,
  RulesMigrateResult,
} from '@pagr/protocol';
import { DeviceEvent as DeviceEventSchema } from '@pagr/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from './adapters/fake.js';
import type { CodingAgentAdapter } from './adapters/types.js';
import { Dispatcher } from './dispatcher.js';
import { ProjectRegistry } from './projects.js';
import { AGENTS_MD, CLAUDE_MD, NATIVE_AGENTS_MD_VERSION } from './rules/convert.js';
import { SessionStore } from './sessions.js';
import { ids, makeBody } from './testFixtures.js';
import { useTempHome } from './testUtil.js';

/**
 * `rules.migrate` as a device command: the two separately-signed steps ADR 0019 decision 6
 * requires, from the cloud's side of the wire.
 *
 * The command surface adds three things to `migrateRules` and is tested for exactly those: the
 * project id resolves locally (the cloud never names a directory), the command is v2-only, and
 * the ack carries the line count and the two file names — and nothing that could rebuild a path.
 *
 * Everything runs under a temp HOME; no real repository and no real `~/.claude` is touched.
 */
describe('Dispatcher · rules.migrate', () => {
  const t = useTempHome('pagr-rules-cmd-');
  const deviceId = ids.dev();
  let registry: ProjectRegistry;
  let events: DeviceEvent[];
  let now: Date;
  let home: string;
  let repo: string;
  let projectId: string;
  let claudeVersion: string;

  /** A Claude whose probe reports whatever version the test needs. */
  class VersionedClaude extends FakeAdapter {
    override async probe(): Promise<AgentConnectionStatus> {
      return { ...(await super.probe()), providerVersion: claudeVersion };
    }
  }

  const build = (): Dispatcher =>
    new Dispatcher({
      deviceId,
      adapters: new Map<Provider, CodingAgentAdapter>([
        ['claude', new VersionedClaude('claude')],
        ['codex', new FakeAdapter('codex')],
      ]),
      registry,
      sessions: new SessionStore(),
      emit: (e) => {
        DeviceEventSchema.parse(e);
        events.push(e);
      },
      tmpDir: join(home, '.pagr', 'tmp'),
      bridgeVersion: '0.1.0',
      policyFile: join(home, '.pagr', 'policy.json'),
      now: () => now,
      osVersion: '25.0.0',
    });

  beforeEach(() => {
    now = new Date('2026-09-20T12:00:00Z');
    events = [];
    claudeVersion = '2.1.100';
    home = join(t.home, 'home');
    repo = join(home, 'checkout-api');
    mkdirSync(join(repo, '.git'), { recursive: true });
    registry = new ProjectRegistry({
      home,
      pagrHome: join(home, '.pagr'),
      file: join(home, '.pagr', 'projects.json'),
    });
    projectId = registry.add(repo, { displayName: 'checkout-api' }).projectId;
  });

  /** A verified command body, as the guard would hand one to the dispatcher. */
  const command = (payload: unknown, version = 2): CommandBody =>
    ({
      ...makeBody('rules.migrate', payload as never, { deviceId, now }),
      version,
    }) as CommandBody;

  const migrate = async (
    d: Dispatcher,
    o: { from: Provider; to: Provider; consent: boolean; projectId?: string; version?: number },
  ) =>
    d.handle(
      command(
        {
          projectId: o.projectId ?? projectId,
          from: o.from,
          to: o.to,
          consent: o.consent,
        },
        o.version ?? 2,
      ),
    );

  const ack = (e: DeviceEvent) => e.payload as EventPayload<'command.ack'>;
  const result = (e: DeviceEvent) => ack(e).result as RulesMigrateResult;

  it('proposes without writing, quoting the real line count', async () => {
    writeFileSync(join(repo, CLAUDE_MD), '# rules\n\nalways run the tests\n');
    const d = build();

    const e = await migrate(d, { from: 'claude', to: 'codex', consent: false });
    expect(ack(e).status).toBe('completed');
    expect(result(e)).toEqual({
      action: 'write',
      sourceFile: CLAUDE_MD,
      targetFile: AGENTS_MD,
      lineCount: 5,
    });
    expect(existsSync(join(repo, AGENTS_MD))).toBe(false);
  });

  it('writes only on the second, consented command', async () => {
    writeFileSync(join(repo, CLAUDE_MD), '# rules\n\nalways run the tests\n');
    const d = build();

    await migrate(d, { from: 'claude', to: 'codex', consent: false });
    expect(existsSync(join(repo, AGENTS_MD))).toBe(false);

    const e = await migrate(d, { from: 'claude', to: 'codex', consent: true });
    expect(ack(e).status).toBe('completed');
    expect(result(e)).toMatchObject({ action: 'write', targetFile: AGENTS_MD });
    expect(readFileSync(join(repo, AGENTS_MD), 'utf8')).toContain('always run the tests');
  });

  it('refuses an existing AGENTS.md instead of overwriting it', async () => {
    const theirs = '# hand-written\n\nnever touch this\n';
    writeFileSync(join(repo, CLAUDE_MD), '# rules\n\nalways run the tests\n');
    writeFileSync(join(repo, AGENTS_MD), theirs);
    const d = build();

    const e = await migrate(d, { from: 'claude', to: 'codex', consent: true });
    expect(ack(e).status).toBe('completed');
    expect(result(e).action).toBe('already_present');
    expect(readFileSync(join(repo, AGENTS_MD), 'utf8')).toBe(theirs);
  });

  it('asks the receiving Claude for its version, and writes no shim for a new one', async () => {
    writeFileSync(join(repo, AGENTS_MD), '# rules\n');
    claudeVersion = NATIVE_AGENTS_MD_VERSION;
    const d = build();

    expect(result(await migrate(d, { from: 'codex', to: 'claude', consent: false }))).toEqual({
      action: 'native_read',
      sourceFile: AGENTS_MD,
    });
    await migrate(d, { from: 'codex', to: 'claude', consent: true });
    expect(existsSync(join(repo, CLAUDE_MD))).toBe(false);
  });

  it('writes the one-line shim for an older Claude', async () => {
    writeFileSync(join(repo, AGENTS_MD), '# rules\n');
    claudeVersion = '2.1.276';
    const d = build();

    expect(result(await migrate(d, { from: 'codex', to: 'claude', consent: false }))).toEqual({
      action: 'write',
      sourceFile: AGENTS_MD,
      targetFile: CLAUDE_MD,
      lineCount: 1,
    });
    await migrate(d, { from: 'codex', to: 'claude', consent: true });
    expect(readFileSync(join(repo, CLAUDE_MD), 'utf8')).toBe(`@${AGENTS_MD}\n`);
  });

  it('is a v2 command, and an unknown project is unknown_project', async () => {
    const d = build();
    expect(
      ack(await migrate(d, { from: 'claude', to: 'codex', consent: false, version: 1 })),
    ).toMatchObject({ status: 'failed', errorCode: 'not_negotiated' });

    expect(
      ack(
        await migrate(d, {
          from: 'claude',
          to: 'codex',
          consent: false,
          projectId: `proj_${'0'.repeat(32)}`,
        }),
      ),
    ).toMatchObject({ status: 'failed', errorCode: 'unknown_project' });
  });

  it('never puts a path, or the rules themselves, on the wire', async () => {
    writeFileSync(join(repo, CLAUDE_MD), '# rules\n\nthe secret is hunter2\n');
    const d = build();

    await migrate(d, { from: 'claude', to: 'codex', consent: false });
    await migrate(d, { from: 'claude', to: 'codex', consent: true });
    const wire = JSON.stringify(events);
    expect(wire).not.toContain(t.home);
    expect(wire).not.toContain('hunter2');
  });
});
