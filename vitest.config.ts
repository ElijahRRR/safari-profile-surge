import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'contract',
          root: './packages/contract',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'service',
          root: './service',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          pool: 'forks',
        },
      },
      './apps/web/vitest.config.ts',
      './extension/vitest.config.ts',
    ],
  },
});
