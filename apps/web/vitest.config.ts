import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    name: 'web',
    root: './apps/web',
    include: ['test/**/*.test.ts'],
    environment: 'happy-dom',
  },
});
