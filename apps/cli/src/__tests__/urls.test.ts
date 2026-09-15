import { describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import {
  configuredApiUrl,
  DEV_API_URL,
  DEV_WEB_URL,
  PROD_API_URL,
  PROD_WEB_URL,
  resolveApiUrl,
  resolveWebUrl,
} from '../urls.js';

/**
 * These tests exist because of a launch-audit finding (OPS-1): the CLI used to compile in
 * `api.pagr.dev` / `app.pagr.dev` as its production defaults, and that domain belongs to an
 * unrelated company. A published CLI would have sent every unconfigured customer's pairing
 * request — device name, public key, platform — to a stranger's server, silently.
 *
 * The rule these pin down: with nothing configured, the CLI must REFUSE, never guess a host.
 */
describe('hosted defaults', () => {
  it('compiles in no production host', () => {
    // If someone sets these, they must set BOTH, and the refusal tests below stop applying.
    expect(PROD_API_URL).toBeNull();
    expect(PROD_WEB_URL).toBeNull();
  });

  it('refuses instead of guessing an API host when nothing is configured', () => {
    expect(() => resolveApiUrl({})).toThrowError(CliError);
    try {
      resolveApiUrl({});
    } catch (e) {
      const err = e as CliError;
      expect(err.code).toBe('no_api_url');
      // The message must tell the user what to do, not just that something is missing.
      expect(err.hint).toContain('--api-url');
      expect(err.hint).toContain('PAGR_API_URL');
    }
  });

  it('refuses instead of guessing a dashboard host when nothing is configured', () => {
    expect(() => resolveWebUrl({})).toThrowError(CliError);
  });
});

describe('precedence', () => {
  it('prefers the flag, then the environment, then the stored config', () => {
    const config = { apiUrl: 'https://api.from-config.test' } as never;
    expect(
      resolveApiUrl({ PAGR_API_URL: 'https://api.from-env.test' }, 'https://api.flag.test', config),
    ).toBe('https://api.flag.test');
    expect(resolveApiUrl({ PAGR_API_URL: 'https://api.from-env.test' }, undefined, config)).toBe(
      'https://api.from-env.test',
    );
    expect(resolveApiUrl({}, undefined, config)).toBe('https://api.from-config.test');
  });

  it('strips a trailing slash so callers can concatenate paths', () => {
    expect(resolveApiUrl({}, 'https://api.example.test/')).toBe('https://api.example.test');
  });

  it('falls back to localhost in development, never to a hosted guess', () => {
    expect(resolveApiUrl({ PAGR_DEV: '1' })).toBe(DEV_API_URL);
    expect(resolveWebUrl({ PAGR_DEV: '1' })).toBe(DEV_WEB_URL);
  });

  it('reports no configured URL when only the (absent) compiled-in default would apply', () => {
    expect(configuredApiUrl({})).toBeNull();
    expect(configuredApiUrl({ PAGR_API_URL: 'https://api.example.test' })).toBe(
      'https://api.example.test',
    );
  });
});

describe('dashboard derivation', () => {
  it('derives the dashboard from the API host rather than a compiled-in domain', () => {
    expect(resolveWebUrl({}, { apiUrl: 'https://api.example.test' } as never)).toBe(
      'https://app.example.test',
    );
  });

  it('sends a local API to the local dashboard', () => {
    expect(resolveWebUrl({}, { apiUrl: 'http://localhost:4000' } as never)).toBe(DEV_WEB_URL);
  });

  it('refuses when the API host has no derivable sibling and nothing else is set', () => {
    // A bare host with no `api.` prefix cannot be turned into a dashboard URL by guessing.
    expect(() => resolveWebUrl({}, { apiUrl: 'https://pagr-api.fly.test' } as never)).toThrowError(
      CliError,
    );
  });
});
