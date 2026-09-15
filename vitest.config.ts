import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'integrations/*/vitest.config.ts',
      'scripts/vitest.config.ts',
    ],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
});
