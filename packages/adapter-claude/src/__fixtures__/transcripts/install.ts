import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Materialise the sanitised transcript fixtures into a temp `$HOME`.
 *
 * Every transcript test runs against one of these, never against the real `~/.claude`: the mirror
 * reads a directory that belongs to another program and the only safe way to test it is to own
 * that directory completely.
 *
 * The fixtures are real Claude Code records with the content replaced — the shapes, field names
 * and record types are what this Mac's `claude` writes (verified 2026-09-17), and nothing in them
 * came from anybody's session.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The session and directory every fixture record names. */
export const FIXTURE_SESSION_ID = '11111111-2222-3333-4444-555555555555';
export const FIXTURE_CWD = '/tmp/pagr-mirror-fixture';
export const FIXTURE_PROJECT_DIR = '-tmp-pagr-mirror-fixture';
export const FIXTURE_PID = 4242;

export interface InstalledFixtures {
  home: string;
  projectDir: string;
  /** `<session>.jsonl` — the file Claude would be appending to. */
  transcript: string;
  supersededSource: string;
  subagentDir: string;
  sessionsDir: string;
  pidFile: string;
  /** Every line of `session-main.jsonl`, for feeding the tailer a slice at a time. */
  mainLines: string[];
  supersededLines: string[];
  subagentLines: string[];
}

const read = (name: string): string => fs.readFileSync(path.join(here, name), 'utf8');
const lines = (text: string): string[] => text.split('\n').filter((l) => l.trim().length > 0);

/**
 * Lay out `<home>/.claude/{projects,sessions}` with the spill file, the subagent and its sidecar
 * already in place. The transcript itself is NOT written: tests append to it themselves, because
 * how the bytes arrive is the thing being tested.
 */
export function installTranscriptFixtures(home: string): InstalledFixtures {
  const projectDir = path.join(home, '.claude', 'projects', FIXTURE_PROJECT_DIR);
  const sessionDir = path.join(projectDir, FIXTURE_SESSION_ID);
  const spillDir = path.join(sessionDir, 'tool-results');
  const subagentDir = path.join(sessionDir, 'subagents');
  const sessionsDir = path.join(home, '.claude', 'sessions');
  for (const d of [projectDir, spillDir, subagentDir, sessionsDir])
    fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(path.join(spillDir, 'bash1.txt'), read('bash1-spill.txt'));
  fs.writeFileSync(path.join(subagentDir, 'agent-a1.meta.json'), read('subagent.meta.json'));

  const pidFile = path.join(sessionsDir, `${FIXTURE_PID}.json`);
  fs.writeFileSync(pidFile, read('pid-session.json'), { mode: 0o644 });
  // The 0600 sibling Claude keeps its messaging secret in. Written so a test can prove the
  // discovery walk never opens it.
  fs.writeFileSync(path.join(sessionsDir, `${FIXTURE_PID}.abc123.key`), 'never-read\n', {
    mode: 0o600,
  });

  return {
    home,
    projectDir,
    transcript: path.join(projectDir, `${FIXTURE_SESSION_ID}.jsonl`),
    supersededSource: path.join(projectDir, `${FIXTURE_SESSION_ID}.jsonl.superseded-1758103200000`),
    subagentDir,
    sessionsDir,
    pidFile,
    mainLines: lines(read('session-main.jsonl').replaceAll('{{HOME}}', home)),
    supersededLines: lines(read('session-superseded.jsonl')),
    subagentLines: lines(read('subagent.jsonl')),
  };
}

/** Append whole lines to a file, the way Claude Code writes them. */
export function appendLines(file: string, toAppend: string[]): void {
  fs.appendFileSync(file, `${toAppend.join('\n')}\n`);
}
