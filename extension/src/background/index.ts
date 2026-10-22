// 后台入口（非持久后台，ES module）。installBackground 同步注册全部监听器，必须在脚本顶层调用，
// 不能放进 await 或其他事件回调之后：后台被闹钟或消息唤醒时，事件派发前监听器就要已注册。
import { NATIVE_APP_ID } from '@sfe/contract';
import { getBrowser } from '../shared/browser';
import { installBackground, nativeMessagingTransport } from './background';

const b = getBrowser();
installBackground(b, nativeMessagingTransport(b, NATIVE_APP_ID));
