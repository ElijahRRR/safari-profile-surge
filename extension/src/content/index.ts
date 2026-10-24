// 登录页内容脚本入口（IIFE，运行时无 import）。每次页面加载只运行一次。
import { getBrowser } from '../shared/browser';
import { runLoginAssist } from './fill';

const MARK = '__sfeLoginAssistLoaded';
const scope = globalThis as unknown as Record<string, unknown>;

if (!scope[MARK]) {
  scope[MARK] = true;
  const b = getBrowser();
  void runLoginAssist({
    doc: document,
    pageUrl: location.href,
    sendMessage: (message) => b.runtime.sendMessage(message),
    navigate: (url) => location.assign(url),
  }).catch(() => undefined);
}
