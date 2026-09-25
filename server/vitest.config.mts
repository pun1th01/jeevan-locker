import os from 'node:os';
import { defineConfig } from 'vitest/config';

// Each worker signs chain transactions with its own Hardhat account (1..19), so the cap keeps every worker
// on a dedicated nonce. The chain and mongod also need CPU, hence one core left for them.
const maxWorkers = Math.max(1, Math.min(os.availableParallelism() - 1, 8));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/globalSetup.ts'],
    setupFiles: ['test/support/perFile.ts'],
    // forks, not threads: the per-file setup chdirs into a temp directory, which worker threads cannot do.
    pool: 'forks',
    isolate: true,
    maxWorkers,
    // vi.stubEnv changes are reverted after every test, so one test's env override can never reach the next.
    unstubEnvs: true,
    testTimeout: 30_000,
    // A cold machine (first run after a reboot) takes ~15 s just to import the app into a worker.
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
});
