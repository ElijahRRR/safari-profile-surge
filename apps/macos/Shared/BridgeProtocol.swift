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

    /// BridgePayload（`{ bridge: { profileId, bridgeVersion }, message }`）的 JSON 文本，原样放进握手的 request.payload，
    /// 客户端证明按它的 UTF-8 字节计算（BridgeHandshake）。不含令牌。按最终 request 行的大小检查 256 KiB 上限。
    static func bridgePayload(message: [String: Any], profileId: String?, bridgeVersion: String) -> Result<String, NativeFailure> {
        let profileValue: Any
        if let profileId { profileValue = profileId } else { profileValue = NSNull() }
        let payload: [String: Any] = [
            "bridge": ["profileId": profileValue, "bridgeVersion": bridgeVersion] as [String: Any],
            "message": message,
        ]
        guard var data = JSONLine.encode(payload) else { return .failure(.badEnvelope) }
        data.removeLast() // 去掉 JSONLine 加的换行
        let text = String(decoding: data, as: UTF8.self)
        // 证明是定长十六进制，用同样长度的占位符就能得到实际 request 行的长度
        guard let line = BridgeHandshake.encodeRequest(clientProof: String(repeating: "0", count: BridgeHandshake.proofHexLength), payload: text) else {
            return .failure(.badEnvelope)
        }
        guard line.count - 1 <= maxMessageBytes else { return .failure(.messageTooLarge) }
        return .success(text)
    }

    // MARK: 原生桥版本

    /// BridgeInfo.bridgeVersion：`<CFBundleShortVersionString>+<CFBundleVersion>`，例如 "0.1.0+1"。
    /// 服务只接受 0x21–0x7E 的可见 ASCII、≤ 64（service/src/ipc/bridge-server.ts 的 BRIDGE_VERSION_RE，不含空格），
    /// 因此两段都只保留可见 ASCII、各截到 31 个字符，缺失时为 "0"。扩展与宿主 App 的探测共用这一格式。
    static func bridgeVersion(infoDictionary info: [String: Any]?) -> String {
        "\(versionComponent(info?["CFBundleShortVersionString"]))+\(versionComponent(info?["CFBundleVersion"]))"
    }

    static func bridgeVersion(bundle: Bundle) -> String {
        bridgeVersion(infoDictionary: bundle.infoDictionary)
    }

    private static func versionComponent(_ value: Any?) -> String {
        guard let text = value as? String else { return "0" }
        let visible = text.utf8.filter { (UInt8(0x21)...UInt8(0x7E)).contains($0) }.prefix(31)
        return visible.isEmpty ? "0" : String(decoding: visible, as: UTF8.self)
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
}

/// 传输层失败（不含任何消息内容）。
enum BridgeTransportError: Error, Equatable {
    case connectFailed
    case sendFailed
    case timeout
    case closedWithoutResponse
    case responseTooLarge
    /// 对端没有证明持有同一令牌（或握手阶段就断开）：请求内容从未发出。
    case handshakeFailed
}

/// 原生桥自己产生的错误应答。消息为简体中文，从不包含令牌、消息内容、应答内容或密码。
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
    /// 系统拒绝扩展读取 App Group 容器（BridgeFileProblem.denied）。扩展被拒绝时系统不弹出提示，弹窗里只有这条说明。
    static let containerDenied = NativeFailure(
        code: "SURGE_UNREACHABLE",
        message: "无法连接本机服务：系统拒绝扩展访问 App Group 容器（不会弹出提示），请确认 App 与扩展使用同一 Team ID 签名后重新构建安装",
        reason: "container_denied"
    )
    /// 读取 App Group 容器中的原生桥配置时遇到其他错误（只给出 errno 值）。
    static func configUnreadable(errno code: Int32) -> NativeFailure {
        NativeFailure(
            code: "SURGE_UNREACHABLE",
            message: "无法连接本机服务：读取原生桥配置失败（errno \(code)），请打开 SafariProfileSurge 后重试",
            reason: "config_unreadable"
        )
    }
    static let malformedResponse = NativeFailure(code: "SURGE_UNREACHABLE", message: "无法连接本机服务：应答格式不正确", reason: "malformed")

    static let nonceUnavailable = NativeFailure(code: "INTERNAL", message: "处理请求失败：无法生成随机数")

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
        case .handshakeFailed:
            return NativeFailure(
                code: "SURGE_UNREACHABLE",
                message: "无法连接本机服务：原生桥认证失败，请打开 SafariProfileSurge 后重试",
                reason: "auth_failed"
            )
        }
    }
}
