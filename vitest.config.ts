import { defineConfig } from 'vitest/config';

export default defineConfig({
  // React component tests (web/) use the automatic JSX runtime
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'scripts/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
