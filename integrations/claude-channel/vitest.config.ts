import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'claude-channel', include: ['src/**/*.test.mts'] } });
