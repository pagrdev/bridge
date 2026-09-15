#!/usr/bin/env node
/**
 * Release the Pagr bridge to npm, and rewrite the Homebrew formula to match.
 *
 * There is no CI (solo repo, gated locally), so this script is the gate. It is a **dry run by
 * default**: it will happily do everything up to and including `npm pack --dry-run`, and it will
 * not run `npm publish` unless you pass `--yes`. Publishing is irreversible — npm unpublish is
 * limited to 72 hours and leaves the version permanently burned — so the confirmation is a flag,
 * never a prompt that a stray newline can answer.
 *
 * It refuses to run at all when:
 *   - the working tree is dirty (the tarball would not match any commit),
 *   - the publishable packages disagree about their version,
 *   - `pnpm gate` (lint + typecheck + tests) is red,
 *   - every target version is already on the registry (nothing to do).
 *
 * A version already on the registry is skipped rather than republished, so a publish that died
 * halfway can be resumed by re-running the same command.
 *
 * Usage:
 *   node scripts/release.mjs                 # dry run: check, gate, build, pack, report
 *   node scripts/release.mjs --yes           # the same, then actually publish
 *   node scripts/release.mjs --yes --tag next
 *   node scripts/release.mjs --only @pagr/cli --yes
 *
 * Version bumps are NOT done here — see packaging/RELEASING.md § "Bump versions". Bump, commit,
 * then run this against the clean tree.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FORMULA = join(ROOT, 'packaging', 'homebrew', 'pagr.rb');
/** All zeros = "not released yet"; `brew install` refuses a digest that does not match. */
export const PLACEHOLDER_SHA256 = '0'.repeat(64);

const NPM_DIR_GLOBS = ['apps', 'packages', 'integrations'];

// ---------------------------------------------------------------- workspace --

/** Every workspace package, private ones included. */
export function readWorkspace(root = ROOT) {
  const out = [];
  for (const group of NPM_DIR_GLOBS) {
    let entries;
    try {
      entries = readdirSync(join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(root, group, e.name);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      out.push({ dir, rel: relative(root, dir), manifest });
    }
  }
  return out;
}

export const publishable = (pkgs) => pkgs.filter((p) => p.manifest.private !== true);

/**
 * Dependency order. `pnpm publish -r` walks topologically on its own, but publishing one package
 * at a time is what makes a half-finished release resumable, and then the order is ours to get
 * right: a dependent published before its dependency is a broken version on the registry that
 * cannot be taken back.
 */
export function topoOrder(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.manifest.name, p]));
  const seen = new Set();
  const out = [];
  const visit = (pkg, stack) => {
    if (seen.has(pkg.manifest.name)) return;
    if (stack.includes(pkg.manifest.name))
      throw new Error(`dependency cycle: ${[...stack, pkg.manifest.name].join(' → ')}`);
    for (const dep of Object.keys(pkg.manifest.dependencies ?? {})) {
      const target = byName.get(dep);
      if (target) visit(target, [...stack, pkg.manifest.name]);
    }
    seen.add(pkg.manifest.name);
    out.push(pkg);
  };
  for (const p of pkgs) visit(p, []);
  return out;
}

/** Every publishable package ships the same version, or the `workspace:*` rewrite is a guess. */
export function assertSameVersion(pkgs) {
  const versions = new Map();
  for (const p of pkgs) {
    const list = versions.get(p.manifest.version) ?? [];
    list.push(p.manifest.name);
    versions.set(p.manifest.version, list);
  }
  if (versions.size !== 1) {
    const detail = [...versions]
      .map(([v, names]) => `  ${v}: ${names.join(', ')}`)
      .sort()
      .join('\n');
    throw new Error(`publishable packages disagree about the version:\n${detail}`);
  }
  return [...versions.keys()][0];
}

/**
 * Every field npm, GitHub and Homebrew read off a published package. Missing metadata is not
 * cosmetic: no `repository` means no provenance link and no "this is really theirs" signal on
 * the npm page, and a missing `engines` lets Node 18 install a package that cannot run.
 */
export function manifestProblems(pkg) {
  const m = pkg.manifest;
  const problems = [];
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  need(m.license === 'Apache-2.0', 'license must be "Apache-2.0"');
  need(typeof m.author === 'string' && m.author.length > 0, 'author is missing');
  need(typeof m.description === 'string' && m.description.length > 0, 'description is missing');
  need(m.repository?.url?.startsWith('git+https://github.com/'), 'repository.url is missing');
  need(m.repository?.directory === pkg.rel, `repository.directory must be "${pkg.rel}"`);
  need(typeof m.homepage === 'string' && m.homepage.startsWith('https://'), 'homepage is missing');
  need(typeof m.bugs?.url === 'string' && m.bugs.url.startsWith('https://'), 'bugs.url is missing');
  need(m.publishConfig?.access === 'public', 'publishConfig.access must be "public"');
  need(m.engines?.node === '>=22', 'engines.node must be ">=22"');
  need(Array.isArray(m.files) && m.files.length > 0, 'files is missing');
  need(typeof m.main === 'string', 'main is missing');
  need(typeof m.types === 'string', 'types is missing');
  need(Boolean(m.exports?.['.']), 'exports["."] is missing');
  for (const [dep, range] of Object.entries(m.dependencies ?? {}))
    need(
      !range.startsWith('workspace:') || range === 'workspace:*',
      `${dep}: use "workspace:*" (pnpm rewrites it to the exact published version), got "${range}"`,
    );
  return problems;
}

// -------------------------------------------------------------------- shell --

const run = (file, args, opts = {}) =>
  execFileSync(file, args, { cwd: ROOT, encoding: 'utf8', ...opts });

const runLoud = (file, args, opts = {}) => run(file, args, { stdio: 'inherit', ...opts });

/** Is `name@version` already on the registry? Throws on any answer that is not a clean yes/no. */
export function isPublished(name, version, view = defaultView) {
  const res = view(`${name}@${version}`);
  if (res.kind === 'found') return true;
  if (res.kind === 'missing') return false;
  throw new Error(`could not ask npm about ${name}@${version}: ${res.message}`);
}

function defaultView(spec) {
  try {
    run('npm', ['view', spec, 'version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { kind: 'found' };
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/E404|is not in this registry|no such package/i.test(text)) return { kind: 'missing' };
    return { kind: 'error', message: text.trim() || String(err) };
  }
}

// ------------------------------------------------------------------ formula --

/**
 * Rewrite the two mechanical lines in the Homebrew formula. The `url` interpolates `version`, so
 * it is never edited — which is the point: a hand-edited URL is how a formula ends up pointing at
 * a tarball from the previous release.
 */
export function bumpFormula(source, { version, sha256 }) {
  // Matched, not diffed: re-releasing the same version must still rewrite the digest, so
  // "the replacement changed nothing" is never evidence that the line was missing.
  const versionLine = /^([ \t]*)version "[^"]*"$/m;
  const shaLine = /^([ \t]*)sha256 "[0-9a-f]{64}"$/m;
  if (!versionLine.test(source)) throw new Error('no `version "..."` line found in the formula');
  if (!shaLine.test(source)) throw new Error('no `sha256 "..."` line found in the formula');
  return source
    .replace(versionLine, `$1version "${version}"`)
    .replace(shaLine, `$1sha256 "${sha256}"`);
}

export const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

export const tarballUrl = (version) => `https://registry.npmjs.org/@pagr/cli/-/cli-${version}.tgz`;

// --------------------------------------------------------------------- args --

export function parseArgs(argv) {
  const opts = { yes: false, tag: 'latest', only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') opts.yes = true;
    else if (a === '--tag') opts.tag = argv[++i] ?? 'latest';
    else if (a === '--only') opts.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument "${a}" (try --help)`);
  }
  if (opts.only && opts.only.length === 0) throw new Error('--only needs a package name');
  return opts;
}

const USAGE = `node scripts/release.mjs [--yes] [--tag <dist-tag>] [--only <name,...>]

  (no flags)  dry run — check, gate, build, pack, report. Publishes nothing.
  --yes       actually run \`npm publish\`. Irreversible.
  --tag       npm dist-tag (default: latest)
  --only      restrict to these package names, still in dependency order
`;

// --------------------------------------------------------------------- main --

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const dirty = run('git', ['status', '--porcelain']).trim();
  if (dirty)
    throw new Error(
      `working tree is dirty — commit or stash first, so the tarball matches a commit:\n${dirty}`,
    );

  const all = readWorkspace();
  let targets = topoOrder(publishable(all));
  const version = assertSameVersion(targets);

  const problems = targets.flatMap((p) =>
    manifestProblems(p).map((msg) => `  ${p.manifest.name}: ${msg}`),
  );
  if (problems.length > 0)
    throw new Error(`package metadata is not release-ready:\n${problems.join('\n')}`);

  if (opts.only) {
    const known = new Set(targets.map((p) => p.manifest.name));
    for (const name of opts.only)
      if (!known.has(name)) throw new Error(`--only ${name}: not a publishable workspace package`);
    targets = targets.filter((p) => opts.only.includes(p.manifest.name));
  }

  process.stdout.write(`\nreleasing v${version}${opts.yes ? '' : '  (DRY RUN)'}\n`);
  process.stdout.write(`publish order: ${targets.map((p) => p.manifest.name).join(' → ')}\n\n`);

  process.stdout.write('→ pnpm gate\n');
  runLoud('pnpm', ['gate']);

  process.stdout.write('\n→ clean build\n');
  runLoud('sh', ['-c', 'rm -rf packages/*/dist apps/*/dist integrations/*/dist']);
  runLoud('pnpm', ['build']);

  const bin = join(ROOT, 'apps', 'cli', 'dist', 'bin.js');
  // `bin` entries are copied verbatim into the tarball; a non-executable one makes `pagr`
  // fail with EACCES for everyone who installs from Homebrew rather than npm.
  if (!(statSync(bin).mode & 0o111)) throw new Error(`${bin} is not executable`);

  const todo = [];
  for (const p of targets) {
    if (isPublished(p.manifest.name, version)) {
      process.stdout.write(`  ${p.manifest.name}@${version} is already on npm — skipping\n`);
      continue;
    }
    todo.push(p);
  }
  if (todo.length === 0)
    throw new Error(`nothing to do: ${version} is already on npm for every target package`);

  process.stdout.write('\n→ npm pack --dry-run\n');
  for (const p of todo) runLoud('npm', ['pack', '--dry-run'], { cwd: p.dir });

  if (!opts.yes) {
    process.stdout.write(
      `\nDRY RUN — nothing was published.\n` +
        `Would publish, in order: ${todo.map((p) => p.manifest.name).join(', ')}\n` +
        `Re-run with --yes to publish v${version} to npm.\n`,
    );
    return 0;
  }

  for (const p of todo) {
    process.stdout.write(`\n→ publishing ${p.manifest.name}@${version}\n`);
    // pnpm (not npm) so `workspace:*` is rewritten to the exact version being published.
    // --no-git-checks: the clean-tree check above is ours and already ran.
    runLoud('pnpm', ['publish', '--access', 'public', '--tag', opts.tag, '--no-git-checks'], {
      cwd: p.dir,
    });
  }

  if (targets.some((p) => p.manifest.name === '@pagr/cli')) {
    process.stdout.write('\n→ updating the Homebrew formula\n');
    const url = tarballUrl(version);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
    const digest = sha256Of(Buffer.from(await res.arrayBuffer()));
    writeFileSync(FORMULA, bumpFormula(readFileSync(FORMULA, 'utf8'), { version, sha256: digest }));
    process.stdout.write(`  ${relative(ROOT, FORMULA)} → version ${version}, sha256 ${digest}\n`);
    process.stdout.write('  commit it, then copy it into the tap (see packaging/RELEASING.md)\n');
  }

  process.stdout.write(`\npublished v${version}.\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`\nrelease failed: ${err.message}\n`);
      process.exit(1);
    });
}
