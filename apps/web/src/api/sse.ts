// 增量 SSE 解析器（按 WHATWG 事件流规则）：处理任意分块边界（含跨块的 CR LF 与多字节 UTF-8）、
// id / event / data / retry 字段与注释行。只解析，不做网络与重连。

export interface SseMessage {
  /** 事件名，缺省为 message。 */
  event: string;
  data: string;
  /** 派发时的 last event ID（id 字段跨事件保留）。 */
  id: string;
}

export interface SseHandlers {
  onMessage(message: SseMessage): void;
  onComment?(text: string): void;
  onRetry?(ms: number): void;
}

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private data = '';
  private hasData = false;
  private eventType = '';
  private idBuffer = '';
  private skipLeadingLF = false;
  private started = false;

  constructor(private readonly handlers: SseHandlers) {}

  /** 当前的 last event ID（已派发或已读入的 id 字段）。 */
  get lastEventId(): string {
    return this.idBuffer;
  }

  pushBytes(chunk: Uint8Array): void {
    this.pushText(this.decoder.decode(chunk, { stream: true }));
  }

  pushText(text: string): void {
    if (text.length === 0) return;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.skipLeadingLF) {
      this.skipLeadingLF = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    this.buffer += text;
    for (;;) {
      const cr = this.buffer.indexOf('\r');
      const lf = this.buffer.indexOf('\n');
      if (cr === -1 && lf === -1) break;
      let end: number;
      let next: number;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        end = cr;
        if (cr + 1 < this.buffer.length) {
          next = this.buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
        } else {
          // CR 在块尾：下一块若以 LF 开头，属于同一个换行。
          next = cr + 1;
          this.skipLeadingLF = true;
        }
      } else {
        end = lf;
        next = lf + 1;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(next);
      this.processLine(line);
    }
  }

  /** 流结束：没有以空行结尾的半个事件按规范丢弃。 */
  end(): void {
    const rest = this.decoder.decode();
    if (rest) this.pushText(rest);
    this.buffer = '';
    this.data = '';
    this.hasData = false;
    this.eventType = '';
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) {
      this.handlers.onComment?.(line.slice(1).replace(/^ /, ''));
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.data += `${value}\n`;
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\0')) this.idBuffer = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.handlers.onRetry?.(Number(value));
        break;
      default:
        break;
    }
  }

  private dispatch(): void {
    if (!this.hasData) {
      this.eventType = '';
      return;
    }
    const data = this.data.endsWith('\n') ? this.data.slice(0, -1) : this.data;
    const message: SseMessage = { event: this.eventType || 'message', data, id: this.idBuffer };
    this.data = '';
    this.hasData = false;
    this.eventType = '';
    this.handlers.onMessage(message);
  }
}
