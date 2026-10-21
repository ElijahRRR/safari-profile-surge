import Foundation

/// 原生桥传输地址。首版只有候选 A：回环 TCP（docs/ARCHITECTURE.md §2，由 P0 native_bridge_ipc 定案）。
struct BridgeEndpoint: Equatable {
    let port: UInt16
}

struct BridgeCredentials {
    let endpoint: BridgeEndpoint
    /// 每次安装随机生成的传输令牌：只在内存与 0600 文件中，从不记录。
    let token: String
}

/// App Group 容器中的 bridge.json（{ transport: "tcp", port }）与 bridge.token，由宿主 App 写入、扩展只读。
enum BridgeFiles {
    static let configFileName = "bridge.json"
    static let tokenFileName = "bridge.token"
    /// Info.plist 中的 App Group 标识（$(DEVELOPMENT_TEAM).sfe，与 entitlements 中的 $(TeamIdentifierPrefix)sfe 相同）。
    static let appGroupInfoKey = "SFEAppGroupIdentifier"
    static let maxConfigBytes = 4 * 1024
    static let maxTokenBytes = 256

    static func appGroupIdentifier(bundle: Bundle = .main) -> String? {
        guard let value = bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
              !value.isEmpty, !value.hasPrefix("."), !value.contains("$(")
        else { return nil }
        return value
    }

    // P0: native_bridge_ipc —— 确认 Personal Team 签名下宿主 App（未沙盒）与扩展（沙盒）拿到同一个容器、
    // 不出现“访问其他 App 数据”的系统提示。
    static func containerURL(bundle: Bundle = .main) -> URL? {
        guard let group = appGroupIdentifier(bundle: bundle) else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }

    // MARK: 纯函数

    static func parseConfig(_ data: Data) -> BridgeEndpoint? {
        guard data.count <= maxConfigBytes,
              let object = JSONLine.decodeObject(data),
              object["transport"] as? String == "tcp",
              let port = JSONLine.integer(object["port"]),
              (1...65535).contains(port)
        else { return nil }
        return BridgeEndpoint(port: UInt16(port))
    }

    static func encodeConfig(_ endpoint: BridgeEndpoint) -> Data {
        // 固定两个字段，编码不会失败
        JSONLine.encode(["transport": "tcp", "port": Int(endpoint.port)] as [String: Any]) ?? Data()
    }

    /// 令牌：32 字节随机数的 base64url（无填充），恰好 43 个字符。
    static func isValidToken(_ token: String) -> Bool {
        let bytes = Array(token.utf8)
        guard bytes.count == 43 else { return false }
        return bytes.allSatisfy { byte in
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "-"), UInt8(ascii: "_"):
                return true
            default:
                return false
            }
        }
    }

    /// 文件内容可带一个结尾换行。
    static func parseToken(_ data: Data) -> String? {
        guard data.count <= maxTokenBytes, var text = String(data: data, encoding: .utf8) else { return nil }
        if text.hasSuffix("\n") { text.removeLast() }
        return isValidToken(text) ? text : nil
    }

    static func base64URL(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: 读取（扩展与宿主 App）

    static func load(bundle: Bundle = .main) -> Result<BridgeCredentials, NativeFailure> {
        guard let container = containerURL(bundle: bundle) else { return .failure(.notConfigured) }
        return load(from: container)
    }

    static func load(from container: URL) -> Result<BridgeCredentials, NativeFailure> {
        guard let configData = try? Data(contentsOf: container.appendingPathComponent(configFileName)),
              let endpoint = parseConfig(configData),
              let tokenData = try? Data(contentsOf: container.appendingPathComponent(tokenFileName)),
              let token = parseToken(tokenData)
        else {
            return .failure(.notConfigured)
        }
        return .success(BridgeCredentials(endpoint: endpoint, token: token))
    }
}
