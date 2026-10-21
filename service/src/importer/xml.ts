// 只为导入 XLSX 准备的最小 XML 分词器：元素、属性、文本、CDATA、注释与处理指令（跳过）、
// 5 个预定义实体与数字字符引用。任何 `<!DOCTYPE`、`<!ENTITY` 等声明一律拒绝，未知实体也拒绝，
// 因此不存在实体展开或外部实体读取的路径。

export type XmlEvent =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

export type XmlErrorReason = 'dtd' | 'malformed';

export class XmlError extends Error {
  readonly reason: XmlErrorReason;
  constructor(reason: XmlErrorReason, message: string) {
    super(message);
    this.name = 'XmlError';
    this.reason = reason;
  }
}

const NAME_RE = /^[A-Za-z_:À-￿][A-Za-z0-9_:.\-·À-￿]*$/;
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function isWs(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** 解码 5 个预定义实体与数字字符引用；其他实体（含自定义实体）视为结构错误。 */
export function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 12) throw new XmlError('malformed', '存在未结束的实体引用');
    const ref = raw.slice(amp + 1, semi);
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const digits = hex ? ref.slice(2) : ref.slice(1);
      if (!(hex ? /^[0-9A-Fa-f]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) throw new XmlError('malformed', '字符引用不正确');
      const cp = Number.parseInt(digits, hex ? 16 : 10);
      if (!isXmlChar(cp)) throw new XmlError('malformed', '字符引用超出允许范围');
      out += String.fromCodePoint(cp);
    } else {
      const v = PREDEFINED[ref];
      if (v === undefined) throw new XmlError('dtd', '使用了未声明的实体');
      out += v;
    }
    i = semi + 1;
  }
  return out;
}

/** 去掉命名空间前缀：x:sheetData → sheetData。 */
export function localName(name: string): string {
  const c = name.indexOf(':');
  return c === -1 ? name : name.slice(c + 1);
}

/**
 * 逐个产出事件。自闭合元素在 open（selfClosing=true）之后紧跟一个 close，调用方只需处理成对事件。
 * 检查标签配对、单一根元素、属性不重复；根元素外的非空白文本视为结构错误。
 */
export function* xmlEvents(text: string): Generator<XmlEvent> {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: string[] = [];
  let sawRoot = false;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = text.slice(i, textEnd);
      if (stack.length === 0) {
        if (raw.trim() !== '') throw new XmlError('malformed', '根元素之外存在文本');
      } else {
        yield { type: 'text', text: decodeXmlEntities(raw) };
      }
    }
    if (lt === -1) break;

    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('malformed', '处理指令未结束');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('malformed', '注释未结束');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw new XmlError('malformed', 'CDATA 位于根元素之外');
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('malformed', 'CDATA 未结束');
      yield { type: 'text', text: text.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // DOCTYPE、ENTITY、ELEMENT、ATTLIST 等声明一律拒绝，不区分是否“无害”。
      throw new XmlError('dtd', '包含 DTD 或实体声明');
    }
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) throw new XmlError('malformed', '结束标签未闭合');
      const name = text.slice(lt + 2, end).trimEnd();
      const open = stack.pop();
      if (open === undefined || open !== name) throw new XmlError('malformed', '标签未正确配对');
      yield { type: 'close', name };
      i = end + 1;
      continue;
    }

    // 开始标签
    let j = lt + 1;
    while (j < n && !isWs(text[j]) && text[j] !== '>' && text[j] !== '/') j++;
    const name = text.slice(lt + 1, j);
    if (!NAME_RE.test(name)) throw new XmlError('malformed', '元素名不正确');
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let selfClosing = false;
    for (;;) {
      const before = j;
      while (j < n && isWs(text[j])) j++;
      if (j >= n) throw new XmlError('malformed', '开始标签未闭合');
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/') {
        if (text[j + 1] !== '>') throw new XmlError('malformed', '开始标签不正确');
        selfClosing = true;
        j += 2;
        break;
      }
      if (j === before) throw new XmlError('malformed', '属性之间缺少空白');
      const nameStart = j;
      while (j < n && !isWs(text[j]) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/') j++;
      const attrName = text.slice(nameStart, j);
      if (!NAME_RE.test(attrName)) throw new XmlError('malformed', '属性名不正确');
      while (j < n && isWs(text[j])) j++;
      if (text[j] !== '=') throw new XmlError('malformed', '属性缺少值');
      j++;
      while (j < n && isWs(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") throw new XmlError('malformed', '属性值缺少引号');
      const valueEnd = text.indexOf(quote, j + 1);
      if (valueEnd === -1) throw new XmlError('malformed', '属性值未结束');
      const rawValue = text.slice(j + 1, valueEnd);
      if (rawValue.includes('<')) throw new XmlError('malformed', '属性值包含非法字符');
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) throw new XmlError('malformed', '属性重复');
      attrs[attrName] = decodeXmlEntities(rawValue);
      j = valueEnd + 1;
    }
    if (stack.length === 0 && sawRoot) throw new XmlError('malformed', '存在多个根元素');
    sawRoot = true;
    yield { type: 'open', name, attrs, selfClosing };
    if (selfClosing) yield { type: 'close', name };
    else stack.push(name);
    i = j;
  }
  if (stack.length > 0) throw new XmlError('malformed', '元素未闭合');
  if (!sawRoot) throw new XmlError('malformed', '缺少根元素');
}

export interface XmlElement {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/** 小部件（工作簿、关系、内容类型）用的简易树；工作表与共享字符串用流式事件处理。 */
export function parseXmlTree(text: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  for (const ev of xmlEvents(text)) {
    if (ev.type === 'open') {
      const el: XmlElement = { name: ev.name, local: localName(ev.name), attrs: ev.attrs, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(el);
      else root = el;
      stack.push(el);
    } else if (ev.type === 'close') {
      stack.pop();
    } else {
      const top = stack[stack.length - 1];
      if (top) top.text += ev.text;
    }
  }
  if (!root) throw new XmlError('malformed', '缺少根元素');
  return root;
}

/** 按本地名取属性（忽略前缀），例如 r:id → id。优先带前缀的匹配，用于区分 r:id 与普通 id。 */
export function attrByLocal(attrs: Record<string, string>, local: string, prefixed = false): string | undefined {
  for (const [k, v] of Object.entries(attrs)) {
    const hasPrefix = k.includes(':');
    if (prefixed && !hasPrefix) continue;
    if (!prefixed && hasPrefix) continue;
    if (localName(k) === local) return v;
  }
  return undefined;
}
