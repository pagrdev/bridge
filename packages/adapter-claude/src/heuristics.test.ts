import { describe, expect, it } from 'vitest';
import { clip, hintsForCommand, hintsForFiles } from './heuristics.js';

describe('hintsForCommand', () => {
  it('flags network, destructive, git push, package install, secrets, production', () => {
    expect(hintsForCommand('curl https://x.y')).toMatchObject({ networkAccess: true });
    expect(hintsForCommand('rm -rf dist')).toMatchObject({ destructive: true });
    expect(hintsForCommand('git push origin main')).toMatchObject({ gitPush: true });
    expect(hintsForCommand('git push --force')).toMatchObject({ gitPush: true, destructive: true });
    expect(hintsForCommand('pnpm add zod')).toMatchObject({ packageInstall: true });
    expect(hintsForCommand('cat .env.local')).toMatchObject({ secretsTouch: true });
    expect(hintsForCommand('npm run db:migrate')).toMatchObject({ productionHint: true });
  });

  it('is empty for benign commands', () => {
    expect(hintsForCommand('npm test')).toEqual({});
    expect(hintsForCommand('ls -la')).toEqual({});
  });

  it('detects paths outside the project', () => {
    expect(hintsForCommand('cat /etc/hosts', '/p', '/p')).toMatchObject({
      touchesOutsideProject: true,
    });
    expect(hintsForCommand('cat /p/src/a.ts', '/p', '/p')).not.toHaveProperty(
      'touchesOutsideProject',
    );
    expect(hintsForCommand('ls', '/other', '/p')).toMatchObject({ touchesOutsideProject: true });
  });
});

describe('hintsForFiles', () => {
  it('flags secrets and outside-project files', () => {
    expect(hintsForFiles(['/p/.env'], '/p')).toMatchObject({ secretsTouch: true });
    expect(hintsForFiles(['/q/x.ts'], '/p')).toMatchObject({ touchesOutsideProject: true });
    expect(hintsForFiles(['/p/x.ts'], '/p')).toEqual({});
  });
});

describe('clip', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(clip('a  b\n c', 10)).toBe('a b c');
    expect(clip('x'.repeat(20), 10)).toHaveLength(10);
    expect(clip('x'.repeat(20), 10).endsWith('…')).toBe(true);
  });
});
