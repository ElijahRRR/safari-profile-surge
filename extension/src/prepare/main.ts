import { createApp } from 'vue';
import '@sfe/easyquick/tokens.css';
import '@sfe/easyquick/easyquick.css';
import '@sfe/easyquick/app.css';
import '../ui/extension.css';
import { getBrowser } from '../shared/browser';
import { createPageClient } from '../shared/messages';
import { readPrepareParams } from '../shared/pages';
import { applyTheme } from '../shared/theme';
import { harnessNavigate, harnessVerifyFetch, installHarness } from '../harness/shim';
import App from './App.vue';
import { createPrepareController } from './controller';

applyTheme();
// 演示构建（--mode harness）才安装替身；正式构建中这段被常量折叠掉。
const harness = import.meta.env.MODE === 'harness';
const browser = harness ? installHarness() : getBrowser();
const { operationId, intent } = readPrepareParams(location.search);
const controller = createPrepareController(operationId, intent, {
  browser,
  client: createPageClient(browser),
  fetchImpl: harness ? (url) => harnessVerifyFetch(url) : (url, init) => fetch(url, init),
  navigate: harness ? harnessNavigate : (url) => location.assign(url),
});
createApp(App, { controller }).mount('#app');
