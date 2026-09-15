# Releasing the Pagr bridge

Everything in this repo ships as npm packages under the `@pagr` scope, plus a Homebrew formula
that wraps the CLI tarball. There is no CI: every step below runs on a maintainer's Mac, and
`scripts/release.mjs` is the gate that CI would otherwise be.

## What ships

| Package | Path | Notes |
| --- | --- | --- |
| `@pagr/protocol` | `packages/protocol` | Typed command/event schemas. Public so anyone can audit what the cloud may ask for. |
| `@pagr/bridge-core` | `packages/core` | Daemon, IPC, transport, project registry. |
| `@pagr/bridge-adapter-codex` | `packages/adapter-codex` | Codex `app-server` adapter. |
| `@pagr/bridge-adapter-claude` | `packages/adapter-claude` | Claude Code adapter + the `PermissionRequest` hook. |
| `@pagr/cli` | `apps/cli` | The `pagr` binary. This is what users install. |
| `@pagr/claude-channel` | `integrations/claude-channel` | **Optional.** Research-preview Claude Code channel server. Nothing else depends on it at runtime. |

The root `pagr-bridge` package is `private: true` and is never published. `integrations/claude-code-plugin`
has no `package.json`: it is a Claude Code plugin, distributed through a plugin marketplace, not npm.

Every publishable package carries `license`, `author`, `repository` (with `directory`), `homepage`,
`bugs`, `files`, `main`/`types`/`exports`, `engines.node >= 22` and `publishConfig.access: public`.
Those fields are asserted by `scripts/release.test.mjs`, so `pnpm gate` fails if one goes missing —
they are not a checklist item here.

## Publish order

`scripts/release.mjs` publishes one package at a time, in the topological order it derives from the
workspace's own `dependencies`, so a run that dies halfway can be resumed by re-running it (already
published versions are skipped, never republished):

1. `@pagr/protocol`
2. `@pagr/bridge-core` (depends on 1)
3. `@pagr/bridge-adapter-codex`, `@pagr/bridge-adapter-claude` (depend on 1, 2)
4. `@pagr/cli` (depends on 1–3)
5. `@pagr/claude-channel` (depends on 1, 2, and `@pagr/bridge-adapter-claude`)

Cross-package dependencies are all `workspace:*`. `pnpm publish` rewrites that to the exact version
being published (`"@pagr/protocol": "0.2.0"`, not a range), which is why every package has to move
together — see the next step.

## Steps

### 1. Bump versions

Every package moves together: a mixed-version workspace makes the `workspace:*` rewrite ambiguous,
and the CLI reports a single `bridgeVersion` to the gateway.

```bash
pnpm -r --filter='!pagr-bridge' exec npm version <new-version> --no-git-tag-version
git commit -am "release: v<new-version>"
```

Nothing else to edit. `apps/cli/src/version.ts` reads the version out of `apps/cli/package.json` at
run time — `pagr --version` and the `bridgeVersion` the gateway sees can no longer disagree with
what npm shipped, and `apps/cli/src/__tests__/version.test.ts` asserts it.

Commit before releasing: `scripts/release.mjs` refuses a dirty tree, because a tarball that matches
no commit is not something anyone can audit afterwards.

### 2. Dry run

```bash
node scripts/release.mjs
```

That is the whole release, minus the publish. It:

- refuses a dirty working tree;
- refuses a workspace whose publishable packages disagree about their version;
- refuses a package missing any of the metadata listed above;
- runs `pnpm gate` (lint + typecheck + tests) and stops if it is red;
- wipes `dist/` and rebuilds, so the tarballs are reproducible;
- checks `dist/bin.js` is still executable (Homebrew installs it as-is; a lost `+x` is EACCES for
  every Homebrew user and nobody else);
- asks the registry which versions already exist, and stops if there is nothing left to publish;
- prints `npm pack --dry-run` for each package.

Check the reported file counts and sizes against the last release. Reference figures at 0.1.0:

| Package | Packed | Unpacked | Files |
| --- | --- | --- | --- |
| `@pagr/protocol` | 18.2 kB | 239.8 kB | 9 |
| `@pagr/bridge-core` | 117.1 kB | 487.7 kB | 109 |
| `@pagr/bridge-adapter-codex` | 36.3 kB | 155.2 kB | 37 |
| `@pagr/bridge-adapter-claude` | 40.1 kB | 156.2 kB | 42 |
| `@pagr/cli` | 59.6 kB | 241.6 kB | 69 |
| `@pagr/claude-channel` | 13.7 kB | 46.0 kB | 22 |

`@pagr/protocol` and `@pagr/bridge-core` compile their tests into `dist` (their tsconfigs do not
exclude `*.test.ts`, so `pnpm typecheck` covers test files too). Their `files` arrays carry
negation patterns — `"!dist/**/*.test.*"`, `"!dist/testUtil.*"`, `"!dist/testFixtures.*"` — to
keep that out of the tarball. A sudden jump usually means one of those was dropped.

### 3. Re-run the compliance checklist

ADR 0001 §Consequences: the Claude Code compliance checklist (handoff §09.16) must be re-run
before **every** public release. In particular re-read
<https://code.claude.com/docs/en/legal-and-compliance> and confirm the unmodified-binary
carve-out still stands. If it does not, `cli-hooks` degrades to API-key-only via config and that
change ships *before* the release, not after.

### 4. Publish

```bash
npm whoami                       # must be a maintainer of the @pagr scope
node scripts/release.mjs --yes
```

`--yes` is the only thing that makes this script run `npm publish`; without it every run above is a
dry run. There is no interactive confirmation on purpose — an irreversible action should not be one
stray newline away.

Useful variants:

```bash
node scripts/release.mjs --yes --tag next          # pre-release dist-tag
node scripts/release.mjs --yes --only @pagr/cli    # resume a partial release
```

Verify:

```bash
npm view @pagr/cli version
npx --yes @pagr/cli@<new-version> --version
```

### 5. Homebrew formula

`node scripts/release.mjs --yes` downloads the published `@pagr/cli` tarball and rewrites
`packaging/homebrew/pagr.rb` for you: the `version` line, and the `sha256` line (which is an
all-zero placeholder in git, because the digest cannot exist before the tarball does). The `url`
interpolates `version`, so it is never edited by hand.

Commit the formula, then copy it into the tap repository (`Formula/pagr.rb`) and verify before
pushing:

```bash
brew install --build-from-source ./pagr.rb
brew test pagr
brew audit --strict --online pagr
brew uninstall pagr
```

`@pagr/claude-channel` is deliberately **not** in the formula. It is a research-preview add-on;
users who want it run `npm i -g @pagr/claude-channel` and then `pagr claude channel-setup`.

### 6. Tag and cut the GitHub release

```bash
git commit -am "release: v<new-version> (homebrew)"
git tag -a v<new-version> -m "v<new-version>"
git push && git push --tags
gh release create v<new-version> --generate-notes
```

### 7. Post-release smoke on a clean machine

```bash
npm install -g @pagr/cli
pagr --version
pagr doctor
```

`pagr doctor` must exit **0** here. An unpaired Mac is a correct install, not a broken one: the
pairing, API, gateway and daemon checks report `warn`/`skip` with the next command to run, and the
report ends with `not paired yet — run \`pagr connect\``. `pagr doctor --json` carries
`"paired": false` alongside `"ok": true`, which is the pair a scripted smoke test should assert.

Only real faults fail: a Keychain that will not open, a `config.json` that will not parse, a
configured API URL that nothing answers, or a daemon that was installed and does not reply. Note
that the network checks are skipped entirely unless something actually chose an API URL
(`--api-url`, `PAGR_API_URL`, or a `config.json` written by `pagr connect`), so this smoke test
needs no network.
