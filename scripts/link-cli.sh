#!/usr/bin/env bash
# Build the bridge and put `pagr` on PATH (global link). Re-run after pulling changes.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --prefer-offline >/dev/null
pnpm build
if pnpm --filter @pagr/cli link --global >/dev/null 2>&1; then
  echo "✔ linked with pnpm (global bin: $(pnpm bin -g 2>/dev/null || echo '?'))"
else
  (cd apps/cli && npm link >/dev/null)
  echo "✔ linked with npm link"
fi
command -v pagr >/dev/null && echo "✔ pagr → $(command -v pagr)" || echo "⚠ pagr not on PATH yet; add your global bin dir (pnpm bin -g / npm bin -g) to PATH"
