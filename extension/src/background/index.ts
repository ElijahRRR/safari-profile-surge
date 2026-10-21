// 后台入口（非持久后台，ES module）。
import { NATIVE_APP_ID } from '@sfe/contract';
import { getBrowser } from '../shared/browser';
import { installBackground, nativeMessagingTransport } from './background';

const b = getBrowser();
installBackground(b, nativeMessagingTransport(b, NATIVE_APP_ID));
