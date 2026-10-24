import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { sfeExtensionPlugin } from './build/plugin.ts';

// 正式构建 → extension/dist（可在 Safari 中加载的扩展目录：页面、background.js、content.js、
// manifest.json、图标）。--mode harness → extension/dist-harness：只含弹窗与准备页，原生传输换成
// 演示端点 HTTP，资源用相对地址，便于本机服务在 /dev/extension/ 下提供。
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const harness = mode === 'harness';
  return {
    root,
    base: './',
    plugins: [vue(), sfeExtensionPlugin({ root, harness })],
    build: {
      outDir: harness ? 'dist-harness' : 'dist',
      emptyOutDir: true,
      sourcemap: false,
      target: 'safari17',
      modulePreload: { polyfill: false },
      rolldownOptions: {
        input: {
          popup: path.join(root, 'popup.html'),
          prepare: path.join(root, 'prepare.html'),
        },
      },
    },
  };
});
