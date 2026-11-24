import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@agent-hub/protocol': path.join(rootDir, 'packages/protocol/src/index.ts'),
      '@agent-hub/adapters': path.join(rootDir, 'packages/adapters/src/index.ts'),
      '@agent-hub/runtime': path.join(rootDir, 'packages/runtime/src/index.ts'),
      '@agent-hub/companion': path.join(rootDir, 'packages/companion/src/index.ts'),
      '@agent-hub/hub': path.join(rootDir, 'packages/hub/src/index.ts')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
