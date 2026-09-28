import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests drive real git processes; Windows runners need more than the 5 s default under load.
    testTimeout: 30_000,
    // Run git like a fresh machine or CI runner: no global/system config, so no user identity.
    env: {
      GIT_CONFIG_GLOBAL: path.join(tmpdir(), 'turnback-no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  },
});
