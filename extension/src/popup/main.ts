import { createApp } from 'vue';
import '@sfe/easyquick/tokens.css';
import '@sfe/easyquick/easyquick.css';
import '@sfe/easyquick/app.css';
import '../ui/extension.css';
import { getBrowser } from '../shared/browser';
import { createPageClient } from '../shared/messages';
import { applyTheme } from '../shared/theme';
import { installHarness } from '../harness/shim';
import App from './App.vue';
import { createPopupController } from './controller';

applyTheme();
// 演示构建（--mode harness）才安装替身；正式构建中这段被常量折叠掉。
const harness = import.meta.env.MODE === 'harness';
const browser = harness ? installHarness() : getBrowser();
const controller = createPopupController({
  browser,
  client: createPageClient(browser),
  closeWindow: harness ? undefined : () => window.close(),
});
createApp(App, { controller }).mount('#app');
