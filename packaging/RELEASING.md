# Releasing the Pagr bridge

Everything in this repo ships as npm packages under the `@pagr` scope, plus a Homebrew formula
that wraps the CLI tarball. There is no CI: every step below runs on a maintainer's Mac.

> **Before the first release**, replace the placeholder repository URL
> (`https://github.com/stagberry-labs/pagr-bridge`) in every `package.json` and in
> `packaging/homebrew/pagr.rb` with the real one. npm renders it on the package page and
> Homebrew audit checks it.

## What ships

| Package | Path | Notes |
| --- | --- | --- |
| `@pagr/protocol` | `packages/protocol` | Typed command/event schemas. Public so anyone can audit what the cloud may ask for. |
| `@pagr/bridge-core` | `packages/core` | Daemon, IPC, transport, project registry. |
| `@pagr/bridge-adapter-codex` | `packages/adapter-codex` | Codex `app-server` adapter. |
| `@pagr/bridge-adapter-claude` | `packages/adapter-claude` | Claude Code adapter + the `PermissionRequest` hook. |
| `@pagr/cli` | `apps/cli` | The `pagr` binary. This is what users install. |
| `@pagr/claude-channel` | `integrations/claude-channel` | **Optional.** Research-preview Claude Code channel server. Nothing else depends on it at runtime. |

The root `pagr-bridge` package is `private: true` and is never published.

## Publish order

`pnpm publish -r` walks the workspace in topological order and rewrites `workspace:*` ranges into
the real version numbers it is publishing, so a single command is enough — but the order it
produces matters if a publish fails halfway, so it is written out here:

1. `@pagr/protocol`
2. `@pagr/bridge-core` (depends on 1)
3. `@pagr/bridge-adapter-codex`, `@pagr/bridge-adapter-claude` (depend on 1, 2)
4. `@pagr/cli` (depends on 1–3)
5. `@pagr/claude-channel` (depends on 1, 2, and `@pagr/bridge-adapter-claude`)

If a publish fails partway, re-run `pnpm publish -r`: pnpm skips versions already on the registry.

## Steps

### 1. Gate

```bash
pnpm install
pnpm biome check --write .
pnpm typecheck
pnpm vitest run
```

All three must be clean. Nothing below is safe on a red tree.

### 2. Bump versions

Every package moves together — a mixed-version workspace makes `workspace:*` rewriting hard to
reason about, and the CLI reports a single `bridgeVersion` to the gateway.

```bash
pnpm -r --filter='!pagr-bridge' exec npm version <new-version> --no-git-tag-version
```

Then update `CLI_VERSION` in `apps/cli/src/context.ts` to match — it is the version the CLI
prints and the `bridgeVersion` the gateway sees, and it is not read from `package.json`.

### 3. Build and inspect the tarballs

```bash
pnpm build
pnpm -r --filter='!pagr-bridge' exec npm pack --dry-run
```

Check the reported file counts and sizes against the last release. Reference figures at 0.1.0:

| Package | Packed | Unpacked | Files |
| --- | --- | --- | --- |
| `@pagr/protocol` | 18.2 kB | 239.6 kB | 9 |
| `@pagr/bridge-core` | 77.8 kB | 329.1 kB | 97 |
| `@pagr/bridge-adapter-codex` | 32.9 kB | 143.7 kB | 37 |
| `@pagr/bridge-adapter-claude` | 36.2 kB | 143.6 kB | 42 |
| `@pagr/cli` | 31.7 kB | 129.9 kB | 65 |
| `@pagr/claude-channel` | 13.7 kB | 45.9 kB | 22 |

`@pagr/protocol` and `@pagr/bridge-core` compile their tests into `dist` (their tsconfigs do not
exclude `*.test.ts`, so `pnpm typecheck` covers test files too). Their `files` arrays carry
negation patterns — `"!dist/**/*.test.*"`, `"!dist/testUtil.*"`, `"!dist/testFixtures.*"` — to
keep that out of the tarball. A sudden jump usually means one of those was dropped, or `dist`
was not cleaned before building. `rm -rf packages/*/dist apps/*/dist integrations/*/dist && pnpm build`
gives a reproducible tree.

Also confirm the CLI tarball still contains `dist/bin.js` with its executable bit — `pagr`'s
`bin` entry points at it.

### 4. Re-run the compliance checklist

ADR 0001 §Consequences: the Claude Code compliance checklist (handoff §09.16) must be re-run
before **every** public release. In particular re-read
<https://code.claude.com/docs/en/legal-and-compliance> and confirm the unmodified-binary
carve-out still stands. If it does not, `cli-hooks` degrades to API-key-only via config and that
change ships *before* the release, not after.

### 5. Publish

```bash
npm whoami                       # must be a maintainer of the @pagr scope
pnpm publish -r --access public  # rewrites workspace:* → real versions
```

`publishConfig.access: public` is set on every package, so `--access public` is belt and braces
for a first-time scoped publish.

Verify:

```bash
npm view @pagr/cli version
npx --yes @pagr/cli@<new-version> --version
```

### 6. Tag and cut the GitHub release

```bash
git commit -am "release: v<new-version>"
git tag -a v<new-version> -m "v<new-version>"
git push && git push --tags
gh release create v<new-version> --generate-notes
```

### 7. Bump the Homebrew formula

`packaging/homebrew/pagr.rb` is a template: `url`, `version`, and `sha256` are placeholders.

```bash
V=<new-version>
curl -fsSLO "https://registry.npmjs.org/@pagr/cli/-/cli-$V.tgz"
shasum -a 256 "cli-$V.tgz"
```

Replace, in the formula:

- `url` → `https://registry.npmjs.org/@pagr/cli/-/cli-$V.tgz`
- `version` → `$V`
- `sha256` → the digest printed above

Then copy it into the tap repository (`Formula/pagr.rb`) and verify locally before pushing:

```bash
brew install --build-from-source ./pagr.rb
brew test pagr
brew audit --strict --online pagr
brew uninstall pagr
```

`@pagr/claude-channel` is deliberately **not** in the formula. It is a research-preview add-on;
users who want it run `npm i -g @pagr/claude-channel` and then `pagr claude channel-setup`.

### 8. Post-release smoke on a clean machine

```bash
npm install -g @pagr/cli
pagr --version
pagr doctor
```

`pagr doctor` exercises the local checks (binaries, launch agent, socket) without needing a
paired account.
