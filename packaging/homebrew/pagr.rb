# typed: false
# frozen_string_literal: true

# Homebrew formula for the Pagr bridge CLI.
#
# Two lines below are rewritten mechanically on every release by `node scripts/release.mjs`
# (see ../RELEASING.md § "Bump the Homebrew formula"):
#
#   * `version "..."` — set to the version just published to npm. `url` interpolates it, so the
#     URL itself is real and never needs editing by hand.
#   * `sha256 "..."`  — the digest of that published tarball. The all-zero value checked in here
#     is a deliberate placeholder: the digest cannot exist until the tarball is on the registry,
#     and `brew install` refuses a mismatched digest, so the placeholder can never install
#     anything. The release script substitutes the real one.
#
# The formula installs the published npm tarball of `@pagr/cli` with Homebrew's bundled Node,
# which is why there is no build step here and no lockfile to keep in sync. `pagr` is a pure
# TypeScript CLI: no native addons of its own, and `@napi-rs/keyring` (macOS Keychain) ships
# prebuilt binaries for both arm64 and x86_64.
class Pagr < Formula
  desc "Connect your Mac's Claude Code and Codex sessions to Pagr"
  homepage "https://github.com/pagrdev/bridge"
  # RELEASE: `scripts/release.mjs` rewrites this line. Declared before `url` so the interpolation
  # below resolves; no leading `v`.
  version "0.1.0"
  url "https://registry.npmjs.org/@pagr/cli/-/cli-#{version}.tgz"
  # RELEASE: `scripts/release.mjs` rewrites this line with `shasum -a 256` of the tarball above.
  # All zeros = not yet released.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "Apache-2.0"

  # The bridge is macOS-only: it talks to the macOS Keychain and installs a launchd agent.
  depends_on :macos
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Finish setup with:

        pagr connect          # generate the device key and pair this Mac
        pagr project add . --name MyApp
        pagr daemon install   # install + start the launchd agent

      The daemon opens one outbound TLS WebSocket. It never listens on a port, and your
      Claude Code / Codex credentials never leave this machine.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pagr --version")
    # `pagr doctor` exits 0 on an unpaired machine, but it probes the login Keychain, which
    # `brew test`'s sandbox has no session for. `--help` is the part that is safe to assert here;
    # the unpaired `doctor` run is covered by RELEASING.md § "Post-release smoke".
    system bin/"pagr", "--help"
  end
end
