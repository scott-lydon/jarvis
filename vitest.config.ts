import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'design', 'web/dist'],
    // Per CLAUDE.md "cap processes to ~1 min": default test timeout 10s,
    // smoke + load tests opt-in to longer via their own scripts.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Vitest's "concurrent" defaults to file-level. We want strict per-file
    // isolation because the smoke tests hit external services with rate
    // limits; running them in parallel would multiply load.
    isolate: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
