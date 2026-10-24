// 构建本机服务与 sfe 命令行（docs/ARCHITECTURE.md §10）：esbuild 打包为单文件 ESM，Node 内置模块保持外部引用；
// 随后把网页构建产物复制到 dist/web。网页尚未构建时只警告，不让服务构建失败。
// 登录交换页脚本（/auth/exchange.js）内嵌在服务代码中，不需要单独的资源文件。

import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serviceRoot, '..');
const dist = join(serviceRoot, 'dist');

const external = ['node:*', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
};

const entries = [
  { entry: join(serviceRoot, 'src', 'main.ts'), outfile: join(dist, 'service.mjs'), banner: undefined },
  { entry: join(serviceRoot, 'src', 'cli', 'sfe.ts'), outfile: join(dist, 'sfe.mjs'), banner: '#!/usr/bin/env node' },
];

mkdirSync(dist, { recursive: true });
let failed = false;

for (const { entry, outfile, banner } of entries) {
  if (!existsSync(entry)) {
    console.error(`[build] 缺少入口文件：${entry}`);
    failed = true;
    continue;
  }
  try {
    await build({ ...common, entryPoints: [entry], outfile, ...(banner ? { banner: { js: banner } } : {}) });
    if (banner) chmodSync(outfile, 0o755);
    console.log(`[build] ${entry.slice(serviceRoot.length + 1)} → ${outfile.slice(serviceRoot.length + 1)}`);
  } catch {
    // esbuild 已输出具体错误
    failed = true;
  }
}

const webDist = join(repoRoot, 'apps', 'web', 'dist');
const webOut = join(dist, 'web');
rmSync(webOut, { recursive: true, force: true });
if (existsSync(join(webDist, 'index.html'))) {
  cpSync(webDist, webOut, { recursive: true, dereference: false, filter: (src) => !src.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..') });
  console.log('[build] apps/web/dist → service/dist/web');
} else {
  console.warn('[build] 警告：apps/web/dist 不存在或缺少 index.html，服务将不提供网页（先运行 npm run build -w @sfe/web）');
}

if (failed) process.exitCode = 1;
