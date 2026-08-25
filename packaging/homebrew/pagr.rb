# typed: false
# frozen_string_literal: true

# Homebrew formula TEMPLATE for the Pagr bridge CLI.
#
# This file is a template: `version`, `url`, and `sha256` are placeholders and MUST be replaced
# on every release. See ../RELEASING.md § "Bump the Homebrew formula" for the exact commands.
#
# The formula installs the published npm tarball of `@pagr/cli` with Homebrew's bundled Node,
# which is why there is no build step here and no lockfile to keep in sync. `pagr` is a pure
# TypeScript CLI: no native addons of its own, and `@napi-rs/keyring` (macOS Keychain) ships
# prebuilt binaries for both arm64 and x86_64.
class Pagr < Formula
  desc "Connect your Mac's Claude Code and Codex sessions to Pagr"
  homepage "https://github.com/pagrdev/bridge"
  # RELEASE: replace VERSION with the published @pagr/cli version (no leading `v`).
  url "https://registry.npmjs.org/@pagr/cli/-/cli-VERSION.tgz"
  version "VERSION"
  # RELEASE: shasum -a 256 of the tarball above.
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
    # `doctor` runs entirely locally and exits non-zero when unpaired; just prove it runs.
    system bin/"pagr", "--help"
  end
end
