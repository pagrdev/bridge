import { describe, expect, it } from 'vitest';
import { hintsForCommand, hintsForFiles, SECRETS } from './heuristics.js';

/**
 * The credential pattern stopped being cosmetic when the device floor started refusing on it, so
 * the line between "a credential file" and "a source file with `token` in the name" is pinned.
 */
describe('SECRETS', () => {
  it('matches real credential and key material', () => {
    for (const s of [
      'cat .env.local',
      '/p/.env',
      'cat ~/.ssh/id_ed25519',
      'cat ~/.aws/credentials',
      'cat server.pem',
      'cat ~/.npmrc',
      'echo $OPENAI_API_KEY',
      'export SUPABASE_SERVICE_ROLE=x',
      'security find-generic-password -s x',
    ])
      expect(SECRETS.test(s), s).toBe(true);
  });

  it('does not match ordinary source files that merely say token or secret', () => {
    for (const s of [
      'src/auth/token.ts',
      'Write src/tokenizer.ts',
      'npm test',
      'ls -la',
      'git push origin main',
      'docs/secrets-policy.md',
    ])
      expect(SECRETS.test(s), s).toBe(false);
    expect(hintsForFiles(['/p/src/token.ts'], '/p')).toEqual({});
    expect(hintsForCommand('npm test')).toEqual({});
  });
});
