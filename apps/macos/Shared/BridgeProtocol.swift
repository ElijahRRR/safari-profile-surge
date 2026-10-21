import Foundation

/// 扩展 ↔ 原生桥 ↔ 本机服务的消息约定，对应 packages/contract/src/native.ts。
/// 这里只做形状校验与包装；权限、绑定与版本检查全部由服务端执行。
enum NativeBridge {
    static let protocolVersion = 1
    /// 单条 NDJSON 消息上限（NATIVE_MAX_MESSAGE_BYTES）。
    static let maxMessageBytes = 256 * 1024
    static let timeoutSeconds: TimeInterval = 10
    static let loopbackHost = "127.0.0.1"
    /// 与 service/src/config.ts 的 DEFAULT_BRIDGE_PORT 一致。
    static let defaultPort: UInt16 = 61848
    static let loginFillType = "requestLoginFill"

    /// 只用于日志：与 NativeRequestType 一致的已知类型。未知类型在日志中记为 unknown，不记录原文。
    static let knownMessageTypes: Set<String> = [
        "getCurrentState",
        "reportProfileState",
        "bindCurrentProfile",
        "createAndBindEnvironment",
        "updateCurrentEnvironment",
        "activateCurrentEnvironment",
        "enterNormalMode",
        "probeCurrentEnvironment",
        "acknowledgeAccountChange",
        "getOperation",
        "cancelOperation",
        "acknowledgeWindowsClosed",
        "beginSafariVerification",
        "submitSafariVerification",
        "requestLoginFill",
    ]

    struct ValidatedEnvelope {
        let message: [String: Any]
        let type: String
    }

    // MARK: 校验与包装

    /// 校验扩展发来的 NativeEnvelope：`{ v: 1, message: { type, ... } }`。
    static func validateEnvelope(_ raw: Any?) -> Result<ValidatedEnvelope, NativeFailure> {
        guard let envelope = raw as? [String: Any],
              JSONLine.integer(envelope["v"]) == protocolVersion,
              let message = envelope["message"] as? [String: Any],
              let type = message["type"] as? String,
              isWellFormedType(type)
        else {
            return .failure(.badEnvelope)
        }
        return .success(ValidatedEnvelope(message: message, type: type))
    }

    /// 类型名只允许 ASCII 字母与数字（以字母开头，≤ 64）。具体类型是否允许由服务端按权限矩阵判断。
    static func isWellFormedType(_ type: String) -> Bool {
        let bytes = Array(type.utf8)
        guard let first = bytes.first, bytes.count <= 64, isASCIILetter(first) else { return false }
        return bytes.allSatisfy { isASCIILetter($0) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }
    }

    private static func isASCIILetter(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte) || (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
    }

    static func logName(forType type: String) -> String {
        knownMessageTypes.contains(type) ? type : "unknown"
    }

    /// SFExtensionProfileKey 的值：文档写明是 NSUUID。统一输出小写 UUID 字符串，保证同一场景每次相同。
    // P0: native_profile_id —— 确认值的类型（UUID / 字符串）、默认场景是否也有值、重启与重装后是否不变。
    static func profileIdentifier(from value: Any?) -> String? {
        if let uuid = value as? UUID { return uuid.uuidString.lowercased() }
        if let text = value as? String, let uuid = UUID(uuidString: text) { return uuid.uuidString.lowercased() }
        return nil
    }

    /// 包装为 BridgeEnvelope 的一行 NDJSON（含结尾换行）。
    static func bridgeLine(message: [String: Any], token: String, profileId: String?, bridgeVersion: String) -> Result<Data, NativeFailure> {
        let profileValue: Any
        if let profileId { profileValue = profileId } else { profileValue = NSNull() }
        let envelope: [String: Any] = [
            "v": protocolVersion,
            "auth": token,
            "bridge": ["profileId": profileValue, "bridgeVersion": bridgeVersion] as [String: Any],
            "message": message,
        ]
        guard let line = JSONLine.encode(envelope) else { return .failure(.badEnvelope) }
        guard line.count - 1 <= maxMessageBytes else { return .failure(.messageTooLarge) }
        return .success(line)
    }

    // MARK: 应答

    /// 解析服务应答（NativeResponse）：`{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`。
    static func parseResponse(_ line: Data) -> Result<[String: Any], NativeFailure> {
        guard let response = JSONLine.decodeObject(line), let ok = JSONLine.bool(response["ok"]) else {
            return .failure(.malformedResponse)
        }
        if ok {
            guard response.keys.contains("data") else { return .failure(.malformedResponse) }
            return .success(response)
        }
        guard let error = response["error"] as? [String: Any],
              let code = error["code"] as? String, isWellFormedErrorCode(code),
              error["message"] is String
        else {
            return .failure(.malformedResponse)
        }
        return .success(response)
    }

    static func isWellFormedErrorCode(_ code: String) -> Bool {
        let bytes = Array(code.utf8)
        guard !bytes.isEmpty, bytes.count <= 64 else { return false }
        return bytes.allSatisfy { (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains($0) || $0 == UInt8(ascii: "_") }
    }

    /// 只用于日志的结果码："ok" 或错误码。
    static func outcomeCode(of response: [String: Any]) -> String {
        if JSONLine.bool(response["ok"]) == true { return "ok" }
        if let error = response["error"] as? [String: Any], let code = error["code"] as? String, isWellFormedErrorCode(code) {
            return code
        }
        return "unknown"
    }

    // MARK: 登录填充

    /// 把服务的 LoginFillServiceResponse（密码只给钥匙串引用）改写为交给扩展的 LoginFillResponse
    /// （`{ field, value }`）。服务的失败应答原样透传。任一密码读取失败则整体失败，不返回部分结果。
    static func rewriteLoginFill(
        _ response: [String: Any],
        now: Date,
        readPassword: (String) -> Result<String, KeychainFailureReason>
    ) -> Result<[String: Any], NativeFailure> {
        guard JSONLine.bool(response["ok"]) == true else { return .success(response) }
        guard let data = response["data"] as? [String: Any],
              let entries = data["fills"] as? [Any],
              entries.count <= 4
        else {
            return .failure(.malformedFill)
        }
        var seen = Set<String>()
        var fills: [[String: Any]] = []
        for raw in entries {
            guard let entry = raw as? [String: Any], let field = entry["field"] as? String, !seen.contains(field) else {
                return .failure(.malformedFill)
            }
            seen.insert(field)
            switch field {
            case "identifier":
                guard let value = entry["value"] as? String, entry["keychainRef"] == nil else { return .failure(.malformedFill) }
                fills.append(["field": field, "value": value])
            case "password":
                // 密码从不由服务直接给值：出现 value 即视为格式错误
                guard entry["value"] == nil,
                      let ref = entry["keychainRef"] as? String, KeychainRef.isValid(ref),
                      let expiresText = entry["expiresAt"] as? String, let expiresAt = parseISODate(expiresText)
                else {
                    return .failure(.malformedFill)
                }
                guard expiresAt > now else { return .failure(.fillRefExpired) }
                switch readPassword(ref) {
                case .success(let value):
                    fills.append(["field": field, "value": value])
                case .failure(let reason):
                    return .failure(.keychainRead(reason))
                }
            default:
                return .failure(.malformedFill)
            }
        }
        return .success(["ok": true, "data": ["fills": fills] as [String: Any]])
    }

    static func parseISODate(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }
}

/// 传输层失败（不含任何消息内容）。
enum BridgeTransportError: Error, Equatable {
    case connectFailed
    case sendFailed
    case timeout
    case closedWithoutResponse
    case responseTooLarge
}

/// 原生桥自己产生的错误应答。消息为简体中文，从不包含令牌、消息内容或钥匙串值。
struct NativeFailure: Error, Equatable {
    let code: String
    let message: String
    /// details.reason（只取枚举值）。
    let reason: String?

    init(code: String, message: String, reason: String? = nil) {
        self.code = code
        self.message = message
        self.reason = reason
    }

    var responseObject: [String: Any] {
        var error: [String: Any] = ["code": code, "message": message]
        if let reason { error["details"] = ["reason": reason] }
        return ["ok": false, "error": error]
    }

    static let badEnvelope = NativeFailure(code: "BAD_REQUEST", message: "处理请求失败：消息格式不正确")
    static let messageTooLarge = NativeFailure(code: "BAD_REQUEST", message: "处理请求失败：消息超过 256 KiB")
    static let notConfigured = NativeFailure(
        code: "SURGE_UNREACHABLE",
        message: "无法连接本机服务：找不到原生桥配置，请先打开 SafariProfileSurge",
        reason: "not_configured"
    )
    static let malformedResponse = NativeFailure(code: "SURGE_UNREACHABLE", message: "无法连接本机服务：应答格式不正确", reason: "malformed")
    static let malformedFill = NativeFailure(code: "FILL_NOT_ALLOWED", message: "登录填充失败：本机服务应答格式不正确", reason: "malformed")
    static let fillRefExpired = NativeFailure(code: "FILL_NOT_ALLOWED", message: "登录填充失败：钥匙串引用已过期，请重新填充", reason: "expired")

    static func keychainRead(_ reason: KeychainFailureReason) -> NativeFailure {
        NativeFailure(code: "FILL_NOT_ALLOWED", message: "无法读取钥匙串中的登录密码：\(reason.displayText)", reason: reason.rawValue)
    }

    static func unreachable(_ error: BridgeTransportError) -> NativeFailure {
        switch error {
        case .connectFailed:
            return NativeFailure(code: "SURGE_UNREACHABLE", message: "无法连接本机服务：后台服务未运行或未注册", reason: "connect_failed")
        case .sendFailed:
            return NativeFailure(code: "SURGE_UNREACHABLE", message: "无法连接本机服务：发送请求失败", reason: "send_failed")
        case .timeout:
            return NativeFailure(code: "SURGE_UNREACHABLE", message: "无法连接本机服务：等待应答超过 10 秒", reason: "timeout")
        case .closedWithoutResponse:
            return NativeFailure(code: "SURGE_UNREACHABLE", message: "无法连接本机服务：服务没有返回结果", reason: "no_response")
        case .responseTooLarge:
            return NativeFailure(code: "SURGE_UNREACHABLE", message: "无法连接本机服务：应答超过 256 KiB", reason: "too_large")
        }
    }
}
