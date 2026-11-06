// 从 EasyQuick UI 设计系统的 tokens.json 生成 tokens.css（浅色 :root + [data-theme="dark"]）。
// 用法：node tools/design/gen-tokens-css.mjs <tokens.json> <out.css>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out] = process.argv;
if (!src || !out) {
  console.error('usage: gen-tokens-css.mjs <tokens.json> <out.css>');
  process.exit(2);
}
const tokens = JSON.parse(readFileSync(src, 'utf8'));
const cssName = (name) => `--${name.replace(/\./g, '\\.')}`;
const resolve = (v) => (typeof v === 'string' ? v.replace(/^\{([A-Za-z0-9_.-]+)\}$/, (_, n) => `var(${cssName(n)})`) : String(v));

const themes = tokens.color.themes.map((t) => t.id);
const primary = themes[0];
const lines = { [primary]: [], dark: [] };

for (const t of tokens.color.tokens) {
  const value = t.value;
  if (typeof value === 'string') {
    lines[primary].push(`  ${cssName(t.name)}: ${resolve(value)};`);
    continue;
  }
  lines[primary].push(`  ${cssName(t.name)}: ${resolve(value[primary])};`);
  for (const theme of themes.slice(1)) {
    if (value[theme] !== undefined && value[theme] !== value[primary]) {
      lines[theme].push(`  ${cssName(t.name)}: ${resolve(value[theme])};`);
    }
  }
}
for (const family of ['spacing', 'radius', 'shadow', 'gradient', 'blur']) {
  for (const t of tokens[family]?.tokens ?? []) lines[primary].push(`  ${cssName(t.name)}: ${resolve(t.value)};`);
}
for (const [k, v] of Object.entries(tokens.type.families)) lines[primary].push(`  --font-${k}: ${v};`);

const css = [
  `/* ${tokens.name} — generated from tokens.json by tools/design/gen-tokens-css.mjs; do not edit by hand */`,
  ':root {',
  ...lines[primary],
  '}',
  '',
  '[data-theme="dark"] {',
  ...lines.dark,
  '}',
  '',
].join('\n');
writeFileSync(out, css);
console.log(`wrote ${out}: ${lines[primary].length} base + ${lines.dark.length} dark declarations`);
