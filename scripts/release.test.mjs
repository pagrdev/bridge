import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertSameVersion,
  bumpFormula,
  FORMULA,
  isPublished,
  manifestProblems,
  PLACEHOLDER_SHA256,
  parseArgs,
  publishable,
  readWorkspace,
  sha256Of,
  tarballUrl,
  topoOrder,
} from './release.mjs';

const pkg = (name, version = '1.0.0', deps = {}, extra = {}) => ({
  dir: `/w/${name}`,
  rel: `packages/${name}`,
  manifest: { name, version, dependencies: deps, ...extra },
});

describe('release · argument parsing', () => {
  it('is a dry run unless --yes is passed explicitly', () => {
    expect(parseArgs([]).yes).toBe(false);
    expect(parseArgs(['--tag', 'next']).yes).toBe(false);
    expect(parseArgs(['--yes']).yes).toBe(true);
  });

  it('defaults the dist-tag to latest and accepts an override', () => {
    expect(parseArgs([]).tag).toBe('latest');
    expect(parseArgs(['--tag', 'next']).tag).toBe('next');
  });

  it('rejects anything it does not understand rather than ignoring it', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['-y'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--only'])).toThrow(/--only needs a package name/);
  });

  it('splits --only on commas', () => {
    expect(parseArgs(['--only', '@pagr/cli,@pagr/protocol']).only).toEqual([
      '@pagr/cli',
      '@pagr/protocol',
    ]);
  });
});

describe('release · publish order', () => {
  it('puts every dependency before its dependents', () => {
    const order = topoOrder([
      pkg('cli', '1.0.0', { core: 'workspace:*', protocol: 'workspace:*' }),
      pkg('core', '1.0.0', { protocol: 'workspace:*' }),
      pkg('protocol'),
    ]).map((p) => p.manifest.name);
    expect(order).toEqual(['protocol', 'core', 'cli']);
  });

  it('ignores third-party dependencies', () => {
    const order = topoOrder([pkg('core', '1.0.0', { zod: '^3.25.0' })]);
    expect(order.map((p) => p.manifest.name)).toEqual(['core']);
  });

  it('refuses a cycle instead of silently dropping a package', () => {
    expect(() =>
      topoOrder([pkg('a', '1.0.0', { b: 'workspace:*' }), pkg('b', '1.0.0', { a: 'workspace:*' })]),
    ).toThrow(/dependency cycle/);
  });

  it('agrees with the real workspace: protocol first, cli after its adapters', () => {
    const order = topoOrder(publishable(readWorkspace())).map((p) => p.manifest.name);
    expect(order[0]).toBe('@pagr/protocol');
    expect(order.indexOf('@pagr/bridge-core')).toBeLessThan(order.indexOf('@pagr/cli'));
    expect(order.indexOf('@pagr/bridge-adapter-claude')).toBeLessThan(order.indexOf('@pagr/cli'));
    expect(order.indexOf('@pagr/bridge-adapter-codex')).toBeLessThan(order.indexOf('@pagr/cli'));
    expect(order.indexOf('@pagr/bridge-adapter-claude')).toBeLessThan(
      order.indexOf('@pagr/claude-channel'),
    );
  });
});

describe('release · version agreement', () => {
  it('accepts a workspace that moves together', () => {
    expect(assertSameVersion([pkg('a', '0.2.0'), pkg('b', '0.2.0')])).toBe('0.2.0');
  });

  it('refuses a workspace that does not, and names the offenders', () => {
    expect(() => assertSameVersion([pkg('a', '0.2.0'), pkg('b', '0.1.0')])).toThrow(/b/);
  });
});

describe('release · registry check', () => {
  it('treats a found version as published', () => {
    expect(isPublished('@pagr/cli', '0.1.0', () => ({ kind: 'found' }))).toBe(true);
  });

  it('treats a 404 as not published', () => {
    expect(isPublished('@pagr/cli', '0.1.0', () => ({ kind: 'missing' }))).toBe(false);
  });

  it('refuses to guess when npm answers with anything else', () => {
    expect(() =>
      isPublished('@pagr/cli', '0.1.0', () => ({ kind: 'error', message: 'ENOTFOUND' })),
    ).toThrow(/could not ask npm/);
  });
});

describe('release · Homebrew formula', () => {
  const formula = readFileSync(FORMULA, 'utf8');

  it('ships with the all-zero sha256 placeholder and a real interpolated URL', () => {
    expect(formula).toContain(`sha256 "${PLACEHOLDER_SHA256}"`);
    expect(formula).toContain('url "https://registry.npmjs.org/@pagr/cli/-/cli-#{version}.tgz"');
    expect(formula).not.toMatch(/-VERSION\.tgz|version "VERSION"/);
  });

  it('declares version before url, so the interpolation resolves', () => {
    expect(formula.indexOf('\n  version "')).toBeLessThan(formula.indexOf('\n  url "'));
  });

  it('rewrites exactly the version and sha256 lines', () => {
    const digest = 'a'.repeat(64);
    const out = bumpFormula(formula, { version: '1.2.3', sha256: digest });
    expect(out).toContain('version "1.2.3"');
    expect(out).toContain(`sha256 "${digest}"`);
    // the URL is derived, never rewritten
    expect(out).toContain('url "https://registry.npmjs.org/@pagr/cli/-/cli-#{version}.tgz"');
    expect(out.split('\n').length).toBe(formula.split('\n').length);
  });

  it('throws rather than writing a formula it did not fully understand', () => {
    expect(() =>
      bumpFormula('class Pagr < Formula\nend\n', { version: '1.0.0', sha256: '0' }),
    ).toThrow(/no `version/);
    expect(() =>
      bumpFormula('  version "1.0.0"\n', { version: '1.0.0', sha256: '0'.repeat(64) }),
    ).toThrow(/no `sha256/);
  });

  it('builds the tarball URL the formula points at', () => {
    expect(tarballUrl('1.2.3')).toBe('https://registry.npmjs.org/@pagr/cli/-/cli-1.2.3.tgz');
  });

  it('hashes bytes the way `shasum -a 256` does', () => {
    expect(sha256Of(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

/**
 * BR-19 / OPS-3. These fields are what npm renders, what GitHub links, and what stops Node 18
 * from installing something it cannot run. They are trivial to forget and invisible until a user
 * hits them, so the gate asserts them rather than a release checklist.
 */
describe('release · every publishable package is release-ready', () => {
  const targets = publishable(readWorkspace());

  it('finds the six packages RELEASING.md documents', () => {
    expect(targets.map((p) => p.manifest.name).sort()).toEqual([
      '@pagr/bridge-adapter-claude',
      '@pagr/bridge-adapter-codex',
      '@pagr/bridge-core',
      '@pagr/claude-channel',
      '@pagr/cli',
      '@pagr/protocol',
    ]);
  });

  it('never treats the root package as publishable', () => {
    expect(targets.map((p) => p.manifest.name)).not.toContain('pagr-bridge');
  });

  for (const p of targets) {
    it(`${p.manifest.name} has complete metadata`, () => {
      expect(manifestProblems(p)).toEqual([]);
    });
  }

  it('gives the CLI a bin entry pointing into dist', () => {
    const cli = targets.find((p) => p.manifest.name === '@pagr/cli');
    expect(cli?.manifest.bin).toEqual({ pagr: './dist/bin.js' });
  });

  it('names a concrete problem when a field is missing', () => {
    expect(manifestProblems(pkg('x'))).toContain('license must be "Apache-2.0"');
    expect(
      manifestProblems(pkg('x', '1.0.0', { '@pagr/protocol': 'workspace:^' })).some((m) =>
        m.includes('workspace:*'),
      ),
    ).toBe(true);
  });
});
