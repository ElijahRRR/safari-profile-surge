import Foundation
import Network

/// 回环 TCP 上的一次握手与往返：连接 127.0.0.1:port → BridgeConversation（hello → 验证服务证明 → request →
/// 读一行应答，≤ 256 KiB）→ 断开。总时限 10 秒。服务不能证明持有令牌时不发送请求内容。
/// 只回报失败类别，从不记录或返回消息内容。
// P0: native_bridge_ipc —— 沙盒扩展（network.client）连接回环端口无系统提示；后台脚本休眠后被唤醒仍能往返。
final class BridgeClient {
    private let endpoint: BridgeEndpoint
    private let timeout: TimeInterval
    private let queue = DispatchQueue(label: "com.sfe.bridge-client")

    init(endpoint: BridgeEndpoint, timeout: TimeInterval = NativeBridge.timeoutSeconds) {
        self.endpoint = endpoint
        self.timeout = timeout
    }

    func send(_ handshake: BridgeHandshake, completion: @escaping (Result<Data, BridgeTransportError>) -> Void) {
        guard let port = NWEndpoint.Port(rawValue: endpoint.port) else {
            completion(.failure(.connectFailed))
            return
        }
        let parameters = NWParameters.tcp
        // 只走回环接口，且不经任何系统代理（Surge 的系统代理或增强模式都不应看到这条连接）
        parameters.requiredInterfaceType = .loopback
        parameters.preferNoProxies = true
        let connection = NWConnection(host: NWEndpoint.Host(NativeBridge.loopbackHost), port: port, using: parameters)
        let exchange = BridgeExchange(connection: connection, maxBytes: NativeBridge.maxMessageBytes, completion: completion)
        exchange.start(handshake, on: queue, timeout: timeout)
    }
}

/// 一次连接的状态，同时是 BridgeConversation 使用的行通道。所有回调都在同一个串行队列上执行，因此不需要额外加锁。
private final class BridgeExchange: BridgeLineChannel {
    private let connection: NWConnection
    private let maxBytes: Int
    private var buffer: LineBuffer
    private var started = false
    private var completion: ((Result<Data, BridgeTransportError>) -> Void)?

    init(connection: NWConnection, maxBytes: Int, completion: @escaping (Result<Data, BridgeTransportError>) -> Void) {
        self.connection = connection
        self.maxBytes = maxBytes
        self.buffer = LineBuffer(maxBytes: maxBytes)
        self.completion = completion
    }

    func start(_ handshake: BridgeHandshake, on queue: DispatchQueue, timeout: TimeInterval) {
        connection.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                guard !started else { return }
                started = true
                BridgeConversation.run(handshake, over: self) { [self] result in
                    finish(result)
                }
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

    // MARK: BridgeLineChannel

    func sendLine(_ line: Data, then done: @escaping (Bool) -> Void) {
        guard completion != nil else {
            done(false)
            return
        }
        connection.send(content: line, completion: .contentProcessed { error in
            done(error == nil)
        })
    }

    func receiveLine(then done: @escaping (Result<Data, BridgeTransportError>) -> Void) {
        // 一问一答：服务只在收到本端的下一行之后才会再发送，每一行都从空缓冲开始
        buffer = LineBuffer(maxBytes: maxBytes)
        receiveMore(done)
    }

    private func receiveMore(_ done: @escaping (Result<Data, BridgeTransportError>) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [self] data, _, isComplete, error in
            guard completion != nil else { return }
            if let data, !data.isEmpty {
                switch buffer.append(data) {
                case .line(let line):
                    done(.success(line))
                    return
                case .tooLong:
                    done(.failure(.responseTooLarge))
                    return
                case .needMore, .empty:
                    break
                }
            }
            if isComplete || error != nil {
                switch buffer.finish() {
                case .line(let line):
                    done(.success(line))
                case .tooLong:
                    done(.failure(.responseTooLarge))
                case .needMore, .empty:
                    done(.failure(.closedWithoutResponse))
                }
                return
            }
            receiveMore(done)
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
