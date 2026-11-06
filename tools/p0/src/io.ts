// 终端输出与交互。所有打印的文本都先经 redactSummary（原始输出只进限权目录）；
// 唯一例外是 test-servers 打印的合成测试节点行（只对本机测试服务有效）。

import { createInterface } from 'node:readline/promises';
import { redactSummary } from './redact.js';

export interface Output {
  /** 一行说明（自动脱敏）。 */
  line(text?: string): void;
  /** 标题。 */
  heading(text: string): void;
  /** 简单表格（单元格自动脱敏）。 */
  table(rows: ReadonlyArray<ReadonlyArray<string>>): void;
  /** JSON 块（字符串值自动脱敏）。 */
  json(value: unknown): void;
  /** 不经脱敏的原样输出：只用于合成测试凭据的节点行。 */
  unredacted(text: string): void;
  warn(text: string): void;
}

export interface Prompter {
  /** 返回用户输入（去掉首尾空白）。非交互时返回 null。 */
  ask(question: string): Promise<string | null>;
  /** 需要输入 yes 才算确认。 */
  confirm(question: string): Promise<boolean>;
  /** 等待回车。 */
  pause(message: string): Promise<void>;
}

function redactValue(value: unknown, home: string | null): unknown {
  if (typeof value === 'string') return redactSummary(value, { home });
  if (Array.isArray(value)) return value.map((v) => redactValue(v, home));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, home)]));
  }
  return value;
}

export function pad(text: string, width: number): string {
  // 中文字符按 2 列计算宽度。
  let w = 0;
  for (const ch of text) w += /[ᄀ-￿]/.test(ch) ? 2 : 1;
  return w >= width ? text : text + ' '.repeat(width - w);
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[ᄀ-￿]/.test(ch) ? 2 : 1;
  return w;
}

export function formatTable(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(...rows.map((r) => displayWidth(r[c] ?? '')))));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : pad(cell, widths[c]!))).join('  ').trimEnd()).join('\n');
}

export function createConsoleOutput(opts: { home: string | null; write?: (s: string) => void; writeErr?: (s: string) => void }): Output {
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s: string) => void process.stderr.write(s));
  const r = (s: string): string => redactSummary(s, { home: opts.home });
  return {
    line: (text = '') => write(`${r(text)}\n`),
    heading: (text) => write(`\n== ${r(text)} ==\n`),
    table: (rows) => write(`${formatTable(rows.map((row) => row.map((c) => r(c))))}\n`),
    json: (value) => write(`${JSON.stringify(redactValue(value, opts.home), null, 2)}\n`),
    unredacted: (text) => write(`${text}\n`),
    warn: (text) => writeErr(`注意：${r(text)}\n`),
  };
}

/** 收集输出的实现（测试用）。 */
export function createMemoryOutput(): Output & { text(): string; lines: string[] } {
  const lines: string[] = [];
  const out = createConsoleOutput({ home: null, write: (s) => lines.push(s), writeErr: (s) => lines.push(s) });
  return Object.assign(out, { lines, text: () => lines.join('') });
}

export function createConsolePrompter(opts: { interactive: boolean; assumeYes: boolean }): Prompter {
  async function ask(question: string): Promise<string | null> {
    if (!opts.interactive) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(`${question} `)).trim();
    } finally {
      rl.close();
    }
  }
  return {
    ask,
    async confirm(question) {
      if (opts.assumeYes) return true;
      const answer = await ask(`${question}（输入 yes 确认）`);
      return answer === 'yes';
    },
    async pause(message) {
      if (!opts.interactive) return;
      await ask(`${message}（完成后按回车）`);
    },
  };
}

/** 按脚本回答的提问器（测试用）。 */
export function createScriptedPrompter(answers: string[], opts: { assumeYes?: boolean } = {}): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const queue = [...answers];
  return {
    asked,
    async ask(question) {
      asked.push(question);
      return queue.length > 0 ? queue.shift()! : null;
    },
    async confirm(question) {
      asked.push(question);
      if (opts.assumeYes) return true;
      return (queue.shift() ?? '') === 'yes';
    },
    async pause(message) {
      asked.push(message);
      queue.shift();
    },
  };
}
