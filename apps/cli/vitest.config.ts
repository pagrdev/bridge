import { defineConfig } from 'vitest/config';

// Tests here drive real `codex app-server` / `claude` fixture children, so the whole suite runs
// dozens of node processes in parallel. The default 5s ceiling is a load flake, not a bug signal.
export default defineConfig({
  test: {
    name: 'cli',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // No test may hold this Mac awake for real (see packages/core/vitest.config.ts).
    env: { PAGR_KEEP_AWAKE: '0' },
  },
});
