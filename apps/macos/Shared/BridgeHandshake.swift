import CryptoKit
import Foundation
import Security

/// 原生桥 ↔ 服务的双向认证握手（docs/ARCHITECTURE.md §7.2，对应 packages/contract/src/native.ts 的
/// BridgeHello / BridgeChallenge / BridgeRequest 与 service/src/ipc/bridge-server.ts）。传输令牌从不上线路：
/// 1. 原生桥发送 `{ v, type: "hello", clientNonce }`；
/// 2. 服务回复 `{ v, type: "challenge", serverNonce, serverProof }`，
///    serverProof = HMAC-SHA256(令牌, "sfe-bridge-server\n" + clientNonce + "\n" + serverNonce)；
/// 3. 原生桥用恒定时间比较验证 serverProof，**通过之前不发送场景 ID 或消息**；通过后发送
///    `{ v, type: "request", clientProof, payload }`，payload 是 `{ bridge, message }` 的 JSON 文本，
///    clientProof = HMAC-SHA256(令牌, "sfe-bridge-client\n" + serverNonce + "\n" + clientNonce + "\n" + SHA-256(payload))；
/// 4. 服务验证 clientProof 后才处理请求，回复一行 NativeResponse 并关闭。
/// HMAC 密钥是令牌的 UTF-8 字节；随机数 32 字节，证明与摘要都是小写十六进制。证明按 payload 的原始字节计算，
/// 双方不需要对 JSON 做规范化。
struct BridgeHandshake {
    static let nonceByteCount = 32
    static let proofHexLength = 64
    static let serverLabel = "sfe-bridge-server"
    static let clientLabel = "sfe-bridge-client"

    /// 本次连接的客户端随机数（小写十六进制）。
    let clientNonce: String
    /// `{ bridge, message }` 的 JSON 文本（NativeBridge.bridgePayload）。
    let payload: String
    private let token: String

    init(token: String, payload: String, clientNonce: [UInt8]) {
        self.token = token
        self.payload = payload
        self.clientNonce = Hex.encode(clientNonce)
    }

    /// 系统随机源生成的 32 字节随机数；失败时为 nil。
    static func randomNonce() -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: nonceByteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return status == errSecSuccess ? bytes : nil
    }

    // MARK: 线路消息

    /// 第一行：只有协议版本与随机数，不含令牌、场景 ID 或消息。
    var helloLine: Data {
        // 固定三个字段，编码不会失败
        JSONLine.encode(["v": NativeBridge.protocolVersion, "type": "hello", "clientNonce": clientNonce] as [String: Any]) ?? Data()
    }

    /// 验证服务的 challenge 行；只有服务证明了持有同一令牌，才返回要发送的 request 行。
    /// 任何不符（格式、版本、随机数与本端相同、证明不符）都返回 .handshakeFailed，调用方不得再发送任何内容。
    func requestLine(answering challenge: Data) -> Result<Data, BridgeTransportError> {
        guard let object = JSONLine.decodeObject(challenge),
              JSONLine.integer(object["v"]) == NativeBridge.protocolVersion,
              object["type"] as? String == "challenge",
              let serverNonce = object["serverNonce"] as? String,
              Hex.decode(serverNonce, byteCount: Self.nonceByteCount) != nil,
              serverNonce != clientNonce,
              let proofText = object["serverProof"] as? String,
              let presented = Hex.decode(proofText, byteCount: Self.proofHexLength / 2)
        else {
            return .failure(.handshakeFailed)
        }
        let expected = Self.mac(token: token, message: Self.serverProofMessage(clientNonce: clientNonce, serverNonce: serverNonce))
        guard Self.constantTimeEqual(presented, expected) else { return .failure(.handshakeFailed) }
        let clientProof = Self.clientProof(token: token, serverNonce: serverNonce, clientNonce: clientNonce, payload: payload)
        guard let line = Self.encodeRequest(clientProof: clientProof, payload: payload) else { return .failure(.handshakeFailed) }
        return .success(line)
    }

    static func encodeRequest(clientProof: String, payload: String) -> Data? {
        JSONLine.encode(["v": NativeBridge.protocolVersion, "type": "request", "clientProof": clientProof, "payload": payload] as [String: Any])
    }

    // MARK: 证明（与 service/src/ipc/bridge-server.ts 的 bridgeServerProof / bridgeClientProof 相同）

    static func serverProof(token: String, clientNonce: String, serverNonce: String) -> String {
        Hex.encode(mac(token: token, message: serverProofMessage(clientNonce: clientNonce, serverNonce: serverNonce)))
    }

    static func clientProof(token: String, serverNonce: String, clientNonce: String, payload: String) -> String {
        Hex.encode(mac(token: token, message: "\(clientLabel)\n\(serverNonce)\n\(clientNonce)\n\(sha256Hex(payload))"))
    }

    static func sha256Hex(_ text: String) -> String {
        Hex.encode(SHA256.hash(data: Data(text.utf8)))
    }

    private static func serverProofMessage(clientNonce: String, serverNonce: String) -> String {
        "\(serverLabel)\n\(clientNonce)\n\(serverNonce)"
    }

    private static func mac(token: String, message: String) -> [UInt8] {
        let key = SymmetricKey(data: Data(token.utf8))
        return Array(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key))
    }

    /// 恒定时间比较：长度相同时总是比较全部字节。
    static func constantTimeEqual(_ lhs: [UInt8], _ rhs: [UInt8]) -> Bool {
        guard lhs.count == rhs.count else { return false }
        var difference: UInt8 = 0
        for index in lhs.indices {
            difference |= lhs[index] ^ rhs[index]
        }
        return difference == 0
    }
}

/// 小写十六进制。
enum Hex {
    private static let digits = Array("0123456789abcdef".utf8)

    static func encode<Bytes: Sequence>(_ bytes: Bytes) -> String where Bytes.Element == UInt8 {
        var out: [UInt8] = []
        for byte in bytes {
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// 只接受恰好 byteCount 字节的小写十六进制。
    static func decode(_ text: String, byteCount: Int) -> [UInt8]? {
        let chars = Array(text.utf8)
        guard chars.count == byteCount * 2 else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(byteCount)
        var index = 0
        while index < chars.count {
            guard let high = nibble(chars[index]), let low = nibble(chars[index + 1]) else { return nil }
            out.append(high << 4 | low)
            index += 2
        }
        return out
    }

    private static func nibble(_ char: UInt8) -> UInt8? {
        switch char {
        case UInt8(ascii: "0")...UInt8(ascii: "9"):
            return char - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"):
            return char - UInt8(ascii: "a") + 10
        default:
            return nil
        }
    }
}

/// 一条已连接的双向行通道。BridgeClient 用 NWConnection 实现；测试用内存中的假服务。
protocol BridgeLineChannel: AnyObject {
    /// 发送一行（含结尾换行）；完成后回调是否成功。
    func sendLine(_ line: Data, then done: @escaping (Bool) -> Void)
    /// 读取下一行（不含换行，≤ 256 KiB）。
    func receiveLine(then done: @escaping (Result<Data, BridgeTransportError>) -> Void)
}

/// 一次连接的完整步骤：hello → 验证 challenge → request → 读一行应答。每次调用恰好回调一次。
/// 服务没有证明持有令牌时以 .handshakeFailed 结束，且从不发送 request（场景 ID 与消息都不会离开本进程）。
enum BridgeConversation {
    static func run(
        _ handshake: BridgeHandshake,
        over channel: BridgeLineChannel,
        completion: @escaping (Result<Data, BridgeTransportError>) -> Void
    ) {
        channel.sendLine(handshake.helloLine) { sent in
            guard sent else {
                completion(.failure(.sendFailed))
                return
            }
            channel.receiveLine { challenge in
                switch challenge {
                case .failure(let error):
                    // 服务在 hello 之后直接断开：令牌未配置，或端口上不是本机服务
                    completion(.failure(error == .closedWithoutResponse ? .handshakeFailed : error))
                case .success(let line):
                    switch handshake.requestLine(answering: line) {
                    case .failure(let error):
                        completion(.failure(error))
                    case .success(let request):
                        channel.sendLine(request) { sent in
                            guard sent else {
                                completion(.failure(.sendFailed))
                                return
                            }
                            channel.receiveLine(then: completion)
                        }
                    }
                }
            }
        }
    }
}
