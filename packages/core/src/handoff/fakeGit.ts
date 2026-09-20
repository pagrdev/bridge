import { join } from 'node:path';
import type { ExecFileLike } from '../git.js';

/**
 * A repository, faked at the process boundary.
 *
 * `git.ts` is the only module in this repository allowed to spawn git, and there is a test that
 * greps for anything else that does. So a switch is exercised by substituting the RUNNER rather
 * than by building a work tree and running commits in it: every `git` the handoff path takes is
 * answered from {@link FakeRepo}, in the same argv the real module uses.
 *
 * `ensureExcluded` is the exception and stays real — it writes `.git/info/exclude` with `fs`,
 * not with git — which is exactly the part these tests want to see actually happen.
 */
export interface FakeRepo {
  /** The work tree root `rev-parse --show-toplevel` answers with. */
  root: string;
  /** `status --porcelain` entries. A successful commit empties it, as a real one would. */
  dirty: string[];
  /** Current `HEAD`. A successful commit moves it to {@link nextSha}. */
  head: string;
  nextSha: string;
  /** When set, `git commit` fails with this on stderr (a hook's complaint, say). */
  commitError?: string;
  /** What `rev-parse --git-path hooks` answers. `git.ts` stats it to name a hook failure. */
  hooksDir?: string;
  /** Every argv this repository was asked for, in order. */
  log: string[];
}

export function newFakeRepo(root: string, over: Partial<FakeRepo> = {}): FakeRepo {
  return {
    root,
    dirty: [],
    head: 'a'.repeat(40),
    nextSha: 'b'.repeat(40),
    log: [],
    ...over,
  };
}

/** `execFile`'s failure: an Error carrying the child's exit code and stderr. */
const failure = (stderr: string, code = 1): Error =>
  Object.assign(new Error('Command failed: git'), { code, stderr, stdout: '' });

/** How many times this repository was asked to do `argv` (`'commit'`, `'add -A'`, …). */
export const gitCalls = (repo: FakeRepo, prefix: string): number =>
  repo.log.filter((l) => l.startsWith(prefix)).length;

export function fakeGit(repo: FakeRepo): ExecFileLike {
  return (_file, args, _options, callback) => {
    const argv = args.join(' ');
    repo.log.push(argv);
    if (argv === 'rev-parse --show-toplevel') return callback(null, `${repo.root}\n`, '');
    if (argv === 'rev-parse --absolute-git-dir')
      return callback(null, `${join(repo.root, '.git')}\n`, '');
    if (argv === 'rev-parse --git-path hooks')
      return callback(null, `${repo.hooksDir ?? join(repo.root, '.git', 'hooks')}\n`, '');
    if (argv === 'rev-parse HEAD') return callback(null, `${repo.head}\n`, '');
    if (argv === 'status --porcelain=v1 -z')
      return callback(null, repo.dirty.map((e) => `${e}\0`).join(''), '');
    if (argv === 'add -A') return callback(null, '', '');
    if (args[0] === 'commit') {
      if (repo.commitError) return callback(failure(repo.commitError), '', repo.commitError);
      repo.head = repo.nextSha;
      repo.dirty = [];
      return callback(null, '', '');
    }
    return callback(failure(`unexpected: git ${argv}`, 128), '', `unexpected: git ${argv}`);
  };
}
