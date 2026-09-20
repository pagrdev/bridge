import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HANDOFF_DIR,
  type HandoffDoc,
  IpcMethodError,
  type IpcServer,
  type ProjectRecord,
  type SessionRecord,
  serialize,
  UNREGISTERED_PROJECT,
} from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from '../errors.js';
import { errJson, fakeDaemon, type Harness, harness, lastJson, plain } from './helpers.js';

/**
 * `pagr handoff` against a fake daemon.
 *
 * Every test here talks to an `IpcServer` on the harness socket and to temp directories. Nothing
 * reaches a real repository, a real `~/.claude`, a real `~/.codex` or a real agent: the two
 * methods the command calls — `handoff.capture` and `handoff.start` — are canned, and what is
 * being checked is the CLI's half of the contract. Which session it picks, what it prints, and
 * which exit code a person's script sees.
 */

const SES = 'ses_1111111111111111111111111111aaaa';
const SES2 = 'ses_2222222222222222222222222222bbbb';
const HND = 'hnd_0123456789abcdef0123456789abcdef';

let h: Harness;
let server: IpcServer | null = null;
let root: string;
let repo: string;

/** Calls the fake daemon recorded, so a test can assert what the CLI asked for. */
let calls: Array<{ method: string; params: unknown }>;

const status = () => ({ paired: true, sessions: 1, projects: 1 });

const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  path: repo,
  displayName: 'checkout-api',
  aliases: [],
  allowNonGit: false,
  addedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: SES,
  provider: 'claude',
  projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  providerSessionId: SES,
  status: 'working',
  cwd: repo,
  startedAt: '2026-09-20T05:00:00.000Z',
  updatedAt: '2026-09-20T05:00:00.000Z',
  ...over,
});

const captured = (over: Record<string, unknown> = {}) => ({
  handoffId: HND,
  from: 'claude',
  to: 'codex',
  sessionId: SES,
  projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  repo,
  path: join(repo, HANDOFF_DIR, `${HND}.md`),
  relativePath: `${HANDOFF_DIR}/${HND}.md`,
  instruction: `Read ${HANDOFF_DIR}/${HND}.md and continue the task it describes.`,
  writer: 'sender',
  summary: 'Make partial refunds work end to end.',
  wipCommit: '7a1d44f',
  filesChanged: 3,
  truncated: false,
  ...over,
});

/** A fake daemon with the two handoff methods plus the listings the CLI reads first. */
async function daemon(
  methods: Record<string, (p: unknown) => unknown>,
  over: { sessions?: SessionRecord[]; projects?: ProjectRecord[] } = {},
): Promise<IpcServer> {
  const record =
    (method: string, fn: (p: unknown) => unknown) =>
    (p: unknown): unknown => {
      calls.push({ method, params: p });
      return fn(p);
    };
  const all: Record<string, (p: unknown) => unknown> = {
    status: () => status(),
    'sessions.list': () => over.sessions ?? [session()],
    'projects.list': () => over.projects ?? [project()],
    ...methods,
  };
  server = await fakeDaemon(
    h.home,
    Object.fromEntries(Object.entries(all).map(([k, v]) => [k, record(k, v)])),
  );
  return server;
}

const paramsFor = (method: string): unknown =>
  calls.find((c) => c.method === method)?.params ?? null;

beforeEach(() => {
  h = harness();
  calls = [];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pagr-handoff-')));
  repo = join(root, 'checkout-api');
  mkdirSync(repo, { recursive: true });
  h.overrides.env = { ...h.overrides.env, HOME: root };
  h.overrides.cwd = () => repo;
});

afterEach(async () => {
  await server?.close();
  server = null;
  h.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('pagr handoff', () => {
  it('captures and starts the receiver, naming the session in this directory', async () => {
    await daemon({
      'handoff.capture': () => captured(),
      'handoff.start': () => ({
        sessionId: 'ses_3333333333333333333333333333cccc',
        status: 'working',
      }),
    });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.ok);
    expect(paramsFor('handoff.capture')).toEqual({ sessionId: SES, to: 'codex' });
    expect(paramsFor('handoff.start')).toEqual({
      handoffId: HND,
      provider: 'codex',
      projectId: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const out = plain(h.stdout);
    expect(out).toContain('claude → codex');
    expect(out).toContain(join(repo, HANDOFF_DIR, `${HND}.md`));
    expect(out).toContain('codex started');
  });

  it('--no-start prints the file path and the line to paste, and starts nothing', async () => {
    await daemon({ 'handoff.capture': () => captured() });
    const code = await h.run(['handoff', '--to', 'codex', '--no-start']);
    expect(code).toBe(EXIT.ok);
    expect(calls.some((c) => c.method === 'handoff.start')).toBe(false);
    const out = plain(h.stdout);
    expect(out).toContain(join(repo, HANDOFF_DIR, `${HND}.md`));
    expect(out).toContain('Paste this into your other agent');
    expect(out).toContain(`Read ${HANDOFF_DIR}/${HND}.md and continue the task it describes.`);
  });

  it('passes --note through to the capture', async () => {
    await daemon({ 'handoff.capture': () => captured() });
    await h.run(['handoff', '--to', 'codex', '--no-start', '--note', 'focus on the refund path']);
    expect(paramsFor('handoff.capture')).toEqual({
      sessionId: SES,
      to: 'codex',
      note: 'focus on the refund path',
    });
  });

  it('says a receiver-written handoff is a reconstruction', async () => {
    await daemon({ 'handoff.capture': () => captured({ writer: 'receiver' }) });
    await h.run(['handoff', '--to', 'codex', '--no-start']);
    expect(plain(h.stdout)).toContain("reconstructed from claude's transcript");
  });

  it('warns when the handoff was truncated', async () => {
    await daemon({ 'handoff.capture': () => captured({ truncated: true }) });
    await h.run(['handoff', '--to', 'codex', '--no-start']);
    expect(plain(h.stdout)).toContain('64 KiB cap');
  });
});

describe('picking the session', () => {
  it('uses --session when given', async () => {
    await daemon(
      { 'handoff.capture': () => captured({ sessionId: SES2 }) },
      { sessions: [session(), session({ sessionId: SES2, provider: 'codex' })] },
    );
    const code = await h.run(['handoff', '--to', 'claude', '--session', SES2, '--no-start']);
    expect(code).toBe(EXIT.ok);
    expect(paramsFor('handoff.capture')).toEqual({ sessionId: SES2, to: 'claude' });
  });

  it('refuses a --session this Mac has never heard of', async () => {
    await daemon({});
    const code = await h.run(['handoff', '--to', 'codex', '--session', SES2]);
    expect(code).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toContain(`no session ${SES2}`);
  });

  it('is a usage error, not a guess, when two sessions are live in the project', async () => {
    await daemon({}, { sessions: [session(), session({ sessionId: SES2, provider: 'codex' })] });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.usage);
    const err = plain(h.stderr);
    expect(err).toContain('2 live sessions in checkout-api');
    expect(err).toContain('--session');
    expect(err).toContain(SES2);
    expect(calls.some((c) => c.method === 'handoff.capture')).toBe(false);
  });

  it('ignores sessions that are not live', async () => {
    await daemon(
      { 'handoff.capture': () => captured() },
      { sessions: [session(), session({ sessionId: SES2, status: 'stopped' })] },
    );
    expect(await h.run(['handoff', '--to', 'codex', '--no-start'])).toBe(EXIT.ok);
    expect(paramsFor('handoff.capture')).toEqual({ sessionId: SES, to: 'codex' });
  });

  it('refuses when nothing is live in this project', async () => {
    await daemon({}, { sessions: [session({ status: 'stopped' })] });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toContain('no live session in checkout-api');
  });

  it('refuses when the directory is in no registered project', async () => {
    await daemon({}, { projects: [project({ path: join(root, 'elsewhere') })] });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toContain('in no registered project');
  });
});

/**
 * One `pagr handoff --to codex` in its own harness, torn down afterwards.
 *
 * Only the exit-code contract test needs this: it runs three different failures in one `it`, and
 * a shared daemon would let the second run see the first one's socket.
 */
async function exitCodeFor(
  methods: Record<string, (p: unknown) => unknown>,
  over: { sessions?: SessionRecord[]; projects?: ProjectRecord[] } = {},
): Promise<number> {
  const outerH = h;
  const outerServer = server;
  const outerCalls = calls;
  h = harness();
  h.overrides.env = { ...h.overrides.env, HOME: root };
  h.overrides.cwd = () => repo;
  calls = [];
  const own = await daemon(methods, over);
  try {
    return await h.run(['handoff', '--to', 'codex']);
  } finally {
    await own.close();
    h.cleanup();
    h = outerH;
    server = outerServer;
    calls = outerCalls;
  }
}

describe('exit codes', () => {
  it('2 for a --to that is not an agent', async () => {
    await daemon({});
    const code = await h.run(['handoff', '--to', 'cursor']);
    expect(code).toBe(EXIT.usage);
    expect(plain(h.stderr)).toContain('--to must be claude or codex');
  });

  it('2 when --to is missing altogether', async () => {
    await daemon({});
    expect(await h.run(['handoff'])).toBe(EXIT.usage);
  });

  it('3 when the daemon is not running', async () => {
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.daemonDown);
  });

  it('1 when the capture was attempted and failed', async () => {
    await daemon({
      'handoff.capture': () => {
        throw new IpcMethodError('provider_error', 'claude did not write the handoff within 90s');
      },
    });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.error);
    expect(plain(h.stderr)).toContain('did not write the handoff');
  });

  it('5 when the switch was refused before anything ran', async () => {
    await daemon({
      'handoff.capture': () => {
        throw new IpcMethodError('capability_unsupported', 'that directory is not a git work tree');
      },
    });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.precondition);
    expect(plain(h.stderr)).toContain('not a git work tree');
  });

  it('keeps the three apart: 1 failed, 2 ambiguous, 5 refused', async () => {
    const ambiguous = await exitCodeFor(
      {},
      { sessions: [session(), session({ sessionId: SES2 })] },
    );
    const failed = await exitCodeFor({
      'handoff.capture': () => {
        throw new IpcMethodError('provider_error', 'the pre-commit hook rejected the WIP commit');
      },
    });
    const refused = await exitCodeFor({
      'handoff.capture': () => {
        throw new IpcMethodError('capability_unsupported', 'codex is not signed in on this Mac');
      },
    });
    expect([ambiguous, failed, refused]).toEqual([EXIT.usage, EXIT.error, EXIT.precondition]);
    expect(new Set([ambiguous, failed, refused]).size).toBe(3);
  });
});

describe('when the start fails after the capture succeeded', () => {
  it('still prints the path, and exits on the start’s own code', async () => {
    await daemon({
      'handoff.capture': () => captured(),
      'handoff.start': () => {
        throw new IpcMethodError(
          'capability_unsupported',
          'another agent already holds that working tree',
        );
      },
    });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.precondition);
    expect(plain(h.stdout)).toContain(join(repo, HANDOFF_DIR, `${HND}.md`));
    expect(plain(h.stderr)).toContain('already holds that working tree');
  });

  it('does not even try for a session outside every registered project', async () => {
    await daemon({ 'handoff.capture': () => captured({ projectId: UNREGISTERED_PROJECT }) });
    const code = await h.run(['handoff', '--to', 'codex']);
    expect(code).toBe(EXIT.precondition);
    expect(calls.some((c) => c.method === 'handoff.start')).toBe(false);
    expect(plain(h.stderr)).toContain('no registered project');
    expect(plain(h.stdout)).toContain(join(repo, HANDOFF_DIR, `${HND}.md`));
  });
});

describe('--json', () => {
  it('writes exactly one document, with the path in it', async () => {
    await daemon({
      'handoff.capture': () => captured(),
      'handoff.start': () => ({ sessionId: 'ses_4444', status: 'working' }),
    });
    const code = await h.run(['handoff', '--to', 'codex', '--json']);
    expect(code).toBe(EXIT.ok);
    const doc = lastJson(h) as Record<string, unknown>;
    expect(doc.path).toBe(join(repo, HANDOFF_DIR, `${HND}.md`));
    expect(doc.handoffId).toBe(HND);
    expect(doc.started).toEqual({ sessionId: 'ses_4444', status: 'working' });
    expect(h.stdout.join('\n').trim().startsWith('{')).toBe(true);
  });

  it('reports a refused capture as the one error document', async () => {
    await daemon({
      'handoff.capture': () => {
        throw new IpcMethodError('capability_unsupported', 'codex is not signed in on this Mac');
      },
    });
    const code = await h.run(['handoff', '--to', 'codex', '--json']);
    expect(code).toBe(EXIT.precondition);
    expect(errJson(h).error).toMatchObject({
      code: 'capability_unsupported',
      exitCode: EXIT.precondition,
    });
  });

  it('carries both the finished capture and the failed start', async () => {
    await daemon({
      'handoff.capture': () => captured(),
      'handoff.start': () => {
        throw new IpcMethodError('provider_error', 'codex exited before it started');
      },
    });
    const code = await h.run(['handoff', '--to', 'codex', '--json']);
    expect(code).toBe(EXIT.error);
    const doc = lastJson(h) as Record<string, unknown>;
    expect(doc.path).toBe(join(repo, HANDOFF_DIR, `${HND}.md`));
    expect(doc.started).toBeNull();
    expect(doc.error).toMatchObject({ code: 'provider_error' });
  });
});

// ---------------------------------------------------------------------------
// pagr handoffs ls
// ---------------------------------------------------------------------------

function doc(id: string, over: Partial<HandoffDoc['frontmatter']> = {}): string {
  return serialize({
    frontmatter: {
      pagr: 'handoff/1',
      id,
      from: { provider: 'claude', sessionId: SES, origin: 'terminal' },
      to: { provider: 'codex' },
      project: { id: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'checkout-api' },
      git: { branch: 'feat/refunds', head: '3f9c1d0', wipCommit: null, dirtyBefore: false },
      writer: 'sender',
      previous: null,
      created: '2026-09-20T05:41:12Z',
      ...over,
    },
    goal: 'Make partial refunds work end to end on the checkout API.',
    done: [],
    notDone: [{ text: 'Wire the amount through', next: true }],
    decisions: [],
    filesTouched: [],
    commands: [],
    knownFailures: [],
    rulesInForce: [],
    openQuestions: [],
    extra: [],
  });
}

function writeHandoff(id: string, over: Partial<HandoffDoc['frontmatter']> = {}): void {
  const dir = join(repo, HANDOFF_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), doc(id, over));
}

describe('pagr handoffs ls', () => {
  const OLDER = 'hnd_aaaa0000000000000000000000000001';
  const NEWER = 'hnd_bbbb0000000000000000000000000002';

  it('lists what is on disk, newest first', async () => {
    writeHandoff(OLDER, { created: '2026-09-19T00:00:00Z' });
    writeHandoff(NEWER, { created: '2026-09-20T00:00:00Z' });
    await daemon({});
    const code = await h.run(['handoffs', 'ls']);
    expect(code).toBe(EXIT.ok);
    const out = plain(h.stdout);
    expect(out).toContain('claude→codex');
    expect(out).toContain('checkout-api');
    expect(out.indexOf(NEWER.slice(0, 12))).toBeLessThan(out.indexOf(OLDER.slice(0, 12)));
  });

  it('says so when there are none', async () => {
    await daemon({});
    expect(await h.run(['handoffs', 'ls'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain('no handoffs');
  });

  it('--json carries the absolute path of every file', async () => {
    writeHandoff(NEWER);
    await daemon({});
    expect(await h.run(['handoffs', 'ls', '--json'])).toBe(EXIT.ok);
    const out = lastJson(h) as { handoffs: Array<{ path: string; summary: string }> };
    expect(out.handoffs).toHaveLength(1);
    expect(out.handoffs[0]?.path).toBe(join(repo, HANDOFF_DIR, `${NEWER}.md`));
    expect(out.handoffs[0]?.summary).toContain('partial refunds');
  });

  it('shows a file it cannot parse rather than hiding it', async () => {
    mkdirSync(join(repo, HANDOFF_DIR), { recursive: true });
    writeFileSync(join(repo, HANDOFF_DIR, `${NEWER}.md`), 'not a handoff at all');
    await daemon({});
    expect(await h.run(['handoffs', 'ls'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain(NEWER.slice(0, 12));
  });

  it('works with no daemon, from the registry on disk', async () => {
    writeHandoff(NEWER);
    mkdirSync(join(h.home), { recursive: true });
    const rec = project();
    writeFileSync(join(h.home, 'projects.json'), JSON.stringify({ [rec.projectId]: rec }));
    expect(await h.run(['handoffs', 'ls'])).toBe(EXIT.ok);
    expect(plain(h.stdout)).toContain(NEWER.slice(0, 12));
  });
});
