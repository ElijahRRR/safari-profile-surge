import Foundation
import XCTest

/// 按 Safari / JSONSerialization 的方式得到 Foundation 对象（数字与布尔值都是 NSNumber）。
func jsonObject(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> Any {
    do {
        return try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    } catch {
        XCTFail("invalid test JSON: \(error)", file: file, line: line)
        return NSNull()
    }
}

func jsonDictionary(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
    guard let dict = jsonObject(text, file: file, line: line) as? [String: Any] else {
        XCTFail("test JSON is not an object", file: file, line: line)
        return [:]
    }
    return dict
}

/// 去掉结尾换行后解析一行 JSON。
func decodeLine(_ data: Data, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
    XCTAssertEqual(data.last, 0x0A, "line must end with a newline", file: file, line: line)
    XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1, "exactly one newline", file: file, line: line)
    guard let object = JSONLine.decodeObject(data.dropLast()) else {
        XCTFail("line is not a JSON object", file: file, line: line)
        return [:]
    }
    return object
}

func errorCode(_ response: [String: Any]) -> String? {
    (response["error"] as? [String: Any])?["code"] as? String
}

func errorMessage(_ response: [String: Any]) -> String? {
    (response["error"] as? [String: Any])?["message"] as? String
}

func errorReason(_ response: [String: Any]) -> String? {
    ((response["error"] as? [String: Any])?["details"] as? [String: Any])?["reason"] as? String
}

/// 序列化后的文本（用于“不含某个值”的断言）。
func serialized(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return "" }
    return String(decoding: data, as: UTF8.self)
}

enum Fixtures {
    /// 合成的 43 字符 base64url 令牌（不是真实令牌）。
    static let token = String(repeating: "A", count: 42) + "Q"
    static let profileUUID = UUID(uuidString: "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0")!
    static let profileId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
    static let syntheticSecret = "synthetic-secret-1"
    static let accountRef = "acct:env-0001:r1"
}

/// 与 service/test/ipc/bridge-server.test.ts 共用的握手已知答案（Node 与 openssl 独立算出）：
/// Swift 原生桥与 Node 服务各自算出同样的值，才能互通。
enum HandshakeVector {
    static let token = Fixtures.token
    static let clientNonce = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
    static let serverNonce = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f"
    static let payload = #"{"bridge":{"bridgeVersion":"0.1.0+1","profileId":"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"},"message":{"type":"getCurrentState"}}"#
    static let payloadSHA256 = "8352f380e350e1ac3a602b1b49889512c1251ad98a249e159ed62ae6fb80e44e"
    static let serverProof = "3dad80eb1c48e870daab47bb1e870ba403d545132b17e8b5e3f7b918957ef0a7"
    static let clientProof = "fd9e83a80d27a034b109fd7a0be483457c30fdf24ee295a10a6c2f7d436d51f8"

    static var clientNonceBytes: [UInt8] { Hex.decode(clientNonce, byteCount: 32) ?? [] }
}

/// 内存中的假服务（BridgeLineChannel 的服务端一侧），按 service/src/ipc/bridge-server.ts 的规则回应：
/// hello → challenge（用它自己知道的 token 计算 serverProof）；request → 验证 clientProof 后回复 reply，
/// 不符则断开。`token` 可以与原生桥的不同，用来模拟不持有令牌的监听者。
final class FakeBridgeServer: BridgeLineChannel {
    enum OnHello {
        /// 正常回应 challenge。
        case challenge
        /// 收到 hello 后直接断开（例如服务未配置令牌）。
        case close
        /// 自定义 challenge 行（不含换行），参数是原生桥的 clientNonce。
        case custom((String) -> Data)
    }

    let token: String
    let serverNonce: String
    var onHello: OnHello = .challenge
    var reply: Result<Data, BridgeTransportError>
    /// 原生桥发来的每一行（含换行）。
    private(set) var received: [Data] = []
    /// 证明通过的 payload。
    private(set) var verifiedPayloads: [String] = []
    private var clientNonce = ""
    private var outbox: [Result<Data, BridgeTransportError>] = []

    init(token: String, serverNonce: String = String(repeating: "ab", count: 32), reply: Result<Data, BridgeTransportError> = .success(Data(#"{"ok":true,"data":{}}"#.utf8))) {
        self.token = token
        self.serverNonce = serverNonce
        self.reply = reply
    }

    /// 原生桥发来的 request 行解出的 payload 对象（没有则为 nil）。
    var sentPayload: [String: Any]? {
        for line in received {
            if let object = JSONLine.decodeObject(line.dropLast()), object["type"] as? String == "request",
               let text = object["payload"] as? String {
                return JSONLine.decodeObject(Data(text.utf8))
            }
        }
        return nil
    }

    func challengeLine(for clientNonce: String) -> Data {
        let object: [String: Any] = [
            "v": 1,
            "type": "challenge",
            "serverNonce": serverNonce,
            "serverProof": BridgeHandshake.serverProof(token: token, clientNonce: clientNonce, serverNonce: serverNonce),
        ]
        return (JSONLine.encode(object) ?? Data()).dropLast()
    }

    func sendLine(_ line: Data, then done: @escaping (Bool) -> Void) {
        received.append(line)
        let object = JSONLine.decodeObject(line.dropLast()) ?? [:]
        switch object["type"] as? String ?? "" {
        case "hello" where received.count == 1:
            clientNonce = object["clientNonce"] as? String ?? ""
            switch onHello {
            case .challenge:
                outbox.append(.success(challengeLine(for: clientNonce)))
            case .close:
                outbox.append(.failure(.closedWithoutResponse))
            case .custom(let make):
                outbox.append(.success(make(clientNonce)))
            }
        case "request" where received.count == 2:
            let payload = object["payload"] as? String ?? ""
            let expected = BridgeHandshake.clientProof(token: token, serverNonce: serverNonce, clientNonce: clientNonce, payload: payload)
            if object["clientProof"] as? String == expected {
                verifiedPayloads.append(payload)
                outbox.append(reply)
            } else {
                outbox.append(.failure(.closedWithoutResponse))
            }
        default:
            outbox.append(.failure(.closedWithoutResponse))
        }
        done(true)
    }

    func receiveLine(then done: @escaping (Result<Data, BridgeTransportError>) -> Void) {
        done(outbox.isEmpty ? .failure(.closedWithoutResponse) : outbox.removeFirst())
    }
}
