import { createApp } from 'vue';
import '@sfe/easyquick/tokens.css';
import '@sfe/easyquick/easyquick.css';
import '@sfe/easyquick/app.css';
import App from './App.vue';
import { createConsoleRouter } from './router';
import { CONSOLE_KEY, createConsoleContext } from './store/context';
import { THEME_KEY, createTheme } from './store/theme';

// 主题在挂载前应用，避免先闪一次浅色（CSP 不允许内联脚本，不能放进 index.html）。
const theme = createTheme();
const ctx = createConsoleContext();
const router = createConsoleRouter();

const app = createApp(App);
app.provide(CONSOLE_KEY, ctx);
app.provide(THEME_KEY, theme);
app.use(router);
app.mount('#app');

// 相对时间与实测有效期每秒刷新一次。
setInterval(() => ctx.store.tick(), 1000);
void ctx.bootstrap();
