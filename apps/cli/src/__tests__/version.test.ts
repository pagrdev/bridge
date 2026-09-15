import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from '../context.js';
import { readPackageVersion, UNKNOWN_VERSION } from '../version.js';
import { harness } from './helpers.js';

const packageJsonUrl = new URL('../../package.json', import.meta.url);
const manifestVersion = (JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version: string })
  .version;

/**
 * OPS-3. `CLI_VERSION` used to be a literal in `context.ts` that a release had to remember to
 * bump by hand. When it drifts, `pagr --version` and the `bridgeVersion` the gateway uses for
 * compatibility checks both describe a build that was never published.
 */
describe('CLI_VERSION comes from package.json', () => {
  it('matches the manifest exactly', () => {
    expect(CLI_VERSION).toBe(manifestVersion);
    expect(CLI_VERSION).not.toBe(UNKNOWN_VERSION);
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
  });

  it('is what `pagr --version` prints', async () => {
    const h = harness();
    try {
      await h.run(['--version']);
      expect(h.stdout.join('\n').trim()).toBe(manifestVersion);
    } finally {
      h.cleanup();
    }
  });

  it('is the bridgeVersion the gateway is told', async () => {
    const h = harness();
    try {
      const { createContext } = await import('../context.js');
      expect(createContext({ env: {} }).bridgeVersion).toBe(manifestVersion);
    } finally {
      h.cleanup();
    }
  });

  it('degrades to an obviously-wrong version rather than crashing on an unreadable manifest', () => {
    const h = harness();
    try {
      const missing = new URL(`file://${h.home}/no-such-package.json`);
      expect(readPackageVersion(missing)).toBe(UNKNOWN_VERSION);
      const garbage = new URL(`file://${h.home}/garbage.json`);
      writeFileSync(garbage, 'not json');
      expect(readPackageVersion(garbage)).toBe(UNKNOWN_VERSION);
      const versionless = new URL(`file://${h.home}/versionless.json`);
      writeFileSync(versionless, '{"name":"x"}');
      expect(readPackageVersion(versionless)).toBe(UNKNOWN_VERSION);
    } finally {
      h.cleanup();
    }
  });
});
