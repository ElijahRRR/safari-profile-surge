import Foundation
import Network

/// 回环 TCP 上的一次 NDJSON 往返：连接 127.0.0.1:port → 发送一行 → 读取一行（≤ 256 KiB）→ 断开。
/// 总时限 10 秒。只回报失败类别，从不记录或返回消息内容。
// P0: native_bridge_ipc —— 沙盒扩展（network.client）连接回环端口无系统提示；后台脚本休眠后被唤醒仍能往返。
final class BridgeClient {
    private let endpoint: BridgeEndpoint
    private let timeout: TimeInterval
    private let queue = DispatchQueue(label: "com.sfe.bridge-client")

    init(endpoint: BridgeEndpoint, timeout: TimeInterval = NativeBridge.timeoutSeconds) {
        self.endpoint = endpoint
        self.timeout = timeout
    }

    func roundTrip(_ line: Data, completion: @escaping (Result<Data, BridgeTransportError>) -> Void) {
        guard let port = NWEndpoint.Port(rawValue: endpoint.port) else {
            completion(.failure(.connectFailed))
            return
        }
        let parameters = NWParameters.tcp
        // 只走回环接口，且不经任何系统代理（Surge 的系统代理或增强模式都不应看到这条连接）
        parameters.requiredInterfaceType = .loopback
        parameters.preferNoProxies = true
        let connection = NWConnection(host: NWEndpoint.Host(NativeBridge.loopbackHost), port: port, using: parameters)
        let exchange = BridgeExchange(connection: connection, line: line, maxBytes: NativeBridge.maxMessageBytes, completion: completion)
        exchange.start(on: queue, timeout: timeout)
    }
}

/// 一次往返的状态。所有回调都在同一个串行队列上执行，因此不需要额外加锁。
private final class BridgeExchange {
    private let connection: NWConnection
    private let line: Data
    private var buffer: LineBuffer
    private var completion: ((Result<Data, BridgeTransportError>) -> Void)?

    init(connection: NWConnection, line: Data, maxBytes: Int, completion: @escaping (Result<Data, BridgeTransportError>) -> Void) {
        self.connection = connection
        self.line = line
        self.buffer = LineBuffer(maxBytes: maxBytes)
        self.completion = completion
    }

    func start(on queue: DispatchQueue, timeout: TimeInterval) {
        connection.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                send()
            case .waiting, .failed:
                // 回环端口没有监听时 NWConnection 进入 waiting 并自行重试；这里直接按无法连接处理
                finish(.failure(.connectFailed))
            case .cancelled:
                finish(.failure(.closedWithoutResponse))
            default:
                break
            }
        }
        // 计时器持有本对象直到超时；结束后再触发不会有任何效果
        queue.asyncAfter(deadline: .now() + timeout) { [self] in
            finish(.failure(.timeout))
        }
        connection.start(queue: queue)
    }

    private func send() {
        connection.send(content: line, completion: .contentProcessed { [self] error in
            if error != nil {
                finish(.failure(.sendFailed))
                return
            }
            receive()
        })
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [self] data, _, isComplete, error in
            guard completion != nil else { return }
            if let data, !data.isEmpty {
                switch buffer.append(data) {
                case .line(let response):
                    finish(.success(response))
                    return
                case .tooLong:
                    finish(.failure(.responseTooLarge))
                    return
                case .needMore, .empty:
                    break
                }
            }
            if isComplete || error != nil {
                switch buffer.finish() {
                case .line(let response):
                    finish(.success(response))
                case .tooLong:
                    finish(.failure(.responseTooLarge))
                case .needMore, .empty:
                    finish(.failure(.closedWithoutResponse))
                }
                return
            }
            receive()
        }
    }

    private func finish(_ result: Result<Data, BridgeTransportError>) {
        guard let completion else { return }
        self.completion = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        completion(result)
    }
}
