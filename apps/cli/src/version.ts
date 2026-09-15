import { readFileSync } from 'node:fs';

/** Reported when `package.json` cannot be read at all — obviously wrong, never a plausible lie. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/**
 * This package's own `package.json`, resolved relative to this module.
 *
 * `src/version.ts` and `dist/version.js` are both exactly one directory below the package root,
 * and npm always puts `package.json` at the root of a tarball regardless of `files`, so the same
 * relative URL works from a checkout, from `tsx`, from vitest and from an installed `@pagr/cli`.
 */
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

export function readPackageVersion(url: URL = PACKAGE_JSON_URL): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0) return version;
  } catch {
    // Fall through: a CLI that cannot read its own manifest must still run.
  }
  return UNKNOWN_VERSION;
}

/**
 * The version `pagr --version` prints and the `bridgeVersion` the gateway is told.
 *
 * Read from `package.json` rather than written out here: a hand-maintained literal is one more
 * thing a release can forget, and the two silently disagreeing means the gateway's compatibility
 * checks are made against a version that was never published.
 */
export const CLI_VERSION: string = readPackageVersion();
