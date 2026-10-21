// 同一进程内三台测试服务之间的连接登记：前置服务的出站本地端口、出口服务转发到回显服务的出站本地端口。
// 回显服务据此回答“这条连接经过哪个测试节点、是否经过前置”，作为链路的正面证据。

export interface ExitHop {
  user: string | null;
  throughFront: boolean;
  target: string;
  at: number;
}

export class ConnectionRegistry {
  private readonly frontOut = new Set<number>();
  private readonly exitOut = new Map<number, ExitHop>();

  addFrontOutbound(localPort: number | undefined): void {
    if (localPort) this.frontOut.add(localPort);
  }

  removeFrontOutbound(localPort: number | undefined): void {
    if (localPort) this.frontOut.delete(localPort);
  }

  /** 出口服务收到的连接来自前置服务的出站端口。 */
  isFromFront(remotePort: number | undefined): boolean {
    return remotePort !== undefined && this.frontOut.has(remotePort);
  }

  addExitOutbound(localPort: number | undefined, hop: ExitHop): void {
    if (localPort) this.exitOut.set(localPort, hop);
  }

  removeExitOutbound(localPort: number | undefined): void {
    if (localPort) this.exitOut.delete(localPort);
  }

  lookupExit(remotePort: number | undefined): ExitHop | null {
    return remotePort === undefined ? null : (this.exitOut.get(remotePort) ?? null);
  }
}
