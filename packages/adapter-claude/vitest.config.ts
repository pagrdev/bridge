import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'adapter-claude', include: ['src/**/*.test.ts'] } });
