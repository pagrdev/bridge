import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    include: ['src/**/*.test.ts'],
    // No test may hold this Mac awake for real. Keep-awake reads the environment, so the whole
    // suite is opted out by default; the tests that exercise it inject their own env and spawn.
    env: { PAGR_KEEP_AWAKE: '0' },
  },
});
