// Vite 插件：页面构建结束后，用 esbuild 单独打包后台（ES module，自包含）与内容脚本
// （IIFE，运行时无 import），并写出 manifest.json 与占位图标。演示构建（harness）不需要这些。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { build as esbuild, type BuildOptions } from 'esbuild';
import type { Plugin } from 'vite';
import { iconPng } from './png.ts';

interface ManifestModule {
  buildManifest(): Record<string, unknown>;
  ICON_SIZES: readonly number[];
}

/**
 * src/manifest.ts 依赖 @sfe/contract 的 TS 源码；Vite 加载配置时会把工作区包当外部模块交给
 * Node，无法直接执行。这里先用 esbuild 打成一个自包含模块再加载。
 */
async function loadManifestModule(root: string): Promise<ManifestModule> {
  const result = await esbuild({
    entryPoints: [path.join(root, 'src/manifest.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'warning',
  });
  const code = result.outputFiles[0]!.text;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as ManifestModule;
}

export async function buildExtensionScripts(root: string, outDir: string): Promise<void> {
  const common: BuildOptions = {
    bundle: true,
    minify: false,
    sourcemap: false,
    target: ['safari17'],
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'warning',
    define: { 'import.meta.env.MODE': '"production"' },
  };
  await esbuild({
    ...common,
    entryPoints: [path.join(root, 'src/background/index.ts')],
    outfile: path.join(outDir, 'background.js'),
    format: 'esm',
  });
  await esbuild({
    ...common,
    entryPoints: [path.join(root, 'src/content/index.ts')],
    outfile: path.join(outDir, 'content.js'),
    format: 'iife',
  });
}

export async function writeManifestAndIcons(root: string, outDir: string): Promise<void> {
  const { buildManifest, ICON_SIZES } = await loadManifestModule(root);
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(buildManifest(), null, 2)}\n`);
  await mkdir(path.join(outDir, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) {
    await writeFile(path.join(outDir, 'icons', `icon-${size}.png`), iconPng(size, (data) => deflateSync(data, { level: 9 })));
  }
}

export function sfeExtensionPlugin(opts: { root: string; harness: boolean }): Plugin {
  let outDir = '';
  return {
    name: 'sfe-extension',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      if (opts.harness) return;
      await buildExtensionScripts(opts.root, outDir);
      await writeManifestAndIcons(opts.root, outDir);
    },
  };
}
