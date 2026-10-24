// CLI 原语表测试共用的示例参数（合成数据）：每个带参数的原语都有一组能通过参数校验的值。

import { FAKE_SAFARI_PATH, FAKE_VERIFY_HOST } from '../../src/surge/fake.js';

export const CLI_PATH = '/Applications/Surge.app/Contents/Applications/surge-cli';

export const SAMPLE_RULE = `PROCESS-NAME,${FAKE_SAFARI_PATH},REJECT`;

export const CLI_SAMPLE_ARGS: Record<string, unknown[]> = {
  checkProfile: ['/tmp/sfe-candidate/日常-Safari环境.conf'],
  getGroupMembers: ['SFE-ROUTE'],
  getGroupSelection: ['SFE-ROUTE'],
  selectGroupPolicy: ['SFE-ROUTE', 'SFE-N-E0001-US01-v001'],
  matchRule: [{ host: FAKE_VERIFY_HOST, processPath: FAKE_SAFARI_PATH, protocol: 'UDP' }],
  killRequest: ['42'],
  updateExternalResource: ['policy-path:sfe-nodes.list'],
  addTempRule: [SAMPLE_RULE],
  removeTempRule: [SAMPLE_RULE],
};
