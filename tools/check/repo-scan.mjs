// 仓库秘密扫描与测试夹具检查（npm run check 的一部分）。只扫描 Git 跟踪的文件。
// 1. 私钥、证书、Surge http-api 密钥、明显的密码赋值、带读取令牌的本机资源服务地址（D10）；2. 测试夹具与文档中的 IP 只允许
//    RFC 5737/3849 文档地址、回环、私有与链路本地测试段之外的真实地址都报错。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const SKIP = [/^package-lock\.json$/, /^packages\/easyquick\/src\/easyquick\.css$/, /\.(png|jpg|woff2?|ico)$/, /^tools\/check\/repo-scan\.mjs$/];
// 本机资源服务地址的路径中是读取令牌（64 位十六进制）：文档与夹具只写 `<token>` 之类的占位，测试在运行时拼出合成令牌。
// 不限于 policy-path= 之后：日志、快照或文档中抄出的地址同样报错。
const LOOPBACK_TOKEN_URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/[0-9a-f]{32,}/i;
const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, '私钥'],
  [/http-api\s*=\s*[A-Za-z0-9]{6,}@/, 'Surge http-api 密钥'],
  [/\bpassword\s*=\s*(?!<|\$\{|\.\.\.|xxx|example|placeholder|‹)[^\s,"'`]{6,}/i, '疑似明文密码'],
  [/\bAKIA[0-9A-Z]{16}\b/, '云访问密钥'],
  [LOOPBACK_TOKEN_URL_RE, '带读取令牌的本机资源服务地址'],
];

// 自检：上面的规则必须报出合成的令牌地址，并放过占位写法（规则写错时扫描会静默放行）。
{
  const hex = '0123456789abcdef'.repeat(4);
  const must = [`policy-path=http://127.0.0.1:20001/${hex}/sfe-nodes.list`, `policy-path = https://localhost/${hex.slice(0, 32)}`, `GET http://[::1]:20001/${hex.toUpperCase()}/x`];
  const mustNot = [
    'policy-path=http://127.0.0.1:<port>/<token>/sfe-nodes.list',
    'policy-path=http://127.0.0.1:20001/<token>/sfe-nodes.list',
    'policy-path=http://127.0.0.1:20001/***',
    'policy-path=sfe-nodes.list',
    `https://example.test/${hex}`,
  ];
  for (const t of must) if (!LOOPBACK_TOKEN_URL_RE.test(t)) throw new Error('repo-scan 自检失败：本机资源服务地址规则没有报出合成令牌');
  for (const t of mustNot) if (LOOPBACK_TOKEN_URL_RE.test(t)) throw new Error('repo-scan 自检失败：本机资源服务地址规则误报了占位写法');
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ALLOWED_V4 = [/^127\./, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^255\./, /^1\.2\.3\.4$/];
const VERSIONISH = /^\d+\.\d+\.\d+\.\d+$/;

let problems = 0;
for (const f of files) {
  if (SKIP.some((r) => r.test(f))) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [re, label] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      problems++;
      console.error(`${f}: 发现${label}（第 ${text.slice(0, m.index).split('\n').length} 行）`);
    }
  }
  if (/(^|\/)(test|tests|fixtures)\//.test(f) || f.startsWith('docs/') || f.startsWith('design/')) {
    for (const m of text.matchAll(IPV4)) {
      const ip = m[0];
      if (ip.split('.').some((o) => Number(o) > 255)) continue;
      // 五段及以上的点分数字是版本或构建号（例如 Safari 构建号 22625.1.29.11.28），不是 IPv4
      if (/\d\.$/.test(text.slice(Math.max(0, m.index - 2), m.index)) || /^\.\d/.test(text.slice(m.index + ip.length, m.index + ip.length + 2))) continue;
      if (ALLOWED_V4.some((r) => r.test(ip))) continue;
      if (VERSIONISH.test(ip) && /version|v\d|build/i.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
      problems++;
      console.error(`${f}: 测试夹具或文档中出现非文档用 IP ${ip}`);
    }
  }
}
if (problems) {
  console.error(`仓库检查失败：${problems} 处问题`);
  process.exit(1);
}
console.log(`仓库检查通过：${files.length} 个文件`);
