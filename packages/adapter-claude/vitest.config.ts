import { defineConfig } from 'vitest/config';

// The fixture `claude` is a real child process; under a loaded machine a 5s ceiling flakes.
export default defineConfig({
  test: { name: 'adapter-claude', include: ['src/**/*.test.ts'], testTimeout: 30_000 },
});
