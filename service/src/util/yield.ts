// 让出事件循环：批量的同步数据库操作（node:sqlite 是同步的）之间调用，原生桥、HTTP 与计时器得以在其间处理。

/**
 * 让出事件循环一轮（setImmediate，排在已到期的 I/O 回调之后）。一串只含微任务的 await（例如 LocalSecretStore 的同步读写包成的
 * Promise）不会让出事件循环：批量导入或清扫成千上万个秘密时整个服务（原生桥握手、普通模式请求、HTTP）会冻结到它结束。
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
