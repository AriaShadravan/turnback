import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run git like a fresh machine or CI runner: no global/system config, so no user identity.
    env: {
      GIT_CONFIG_GLOBAL: path.join(tmpdir(), 'turnback-no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  },
});
