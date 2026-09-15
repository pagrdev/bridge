import { defineConfig } from 'vitest/config';

// `scripts/` is not a workspace package (nothing imports it, nothing publishes it), but the
// release tooling that lives here is the only thing standing between a typo and a burned npm
// version, so it gets the same gate as everything else.
export default defineConfig({
  test: { name: 'scripts', include: ['*.test.mjs'] },
});
