import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 生产构建输出到 apps/web/dist，由本机服务作为静态文件提供（同源，不需要 CORS）。
// 开发时 /api 与 /auth 代理到本机服务（默认 127.0.0.1:61847）。
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:61847', changeOrigin: true },
      '/auth': { target: 'http://127.0.0.1:61847', changeOrigin: true },
      '/dev': { target: 'http://127.0.0.1:61847', changeOrigin: true },
    },
  },
});
