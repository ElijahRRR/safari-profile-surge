import Foundation
import Security

/// sfe-keychain 的协议与策略（不含系统调用，便于测试）。
/// 请求：stdin 一行 `{ op, ref, kind, value? }`；应答：stdout 一行 `{ ok: true, value? }` 或 `{ ok: false, reason }`。
/// 与 service/src/secrets/keychain-helper-store.ts 对应。秘密值只出现在 stdin 与 get 的 stdout 中。
enum KeychainItemKind: String, CaseIterable {
    case proxy
    case account
    case system

    /// kSecAttrService：com.sfe.proxy / com.sfe.account / com.sfe.system。
    var service: String { "com.sfe.\(rawValue)" }

    /// 钥匙串访问中显示的名称（不含秘密）。
    var label: String {
        switch self {
        case .proxy: return "SafariProfileSurge 代理凭据"
        case .account: return "SafariProfileSurge 登录密码"
        case .system: return "SafariProfileSurge 系统密钥"
        }
    }
}

enum KeychainToolOp: String, CaseIterable {
    case set
    case get
    case delete
}

struct KeychainToolRequest: Equatable {
    let op: KeychainToolOp
    let ref: String
    let kind: KeychainItemKind
    let value: String?
}

enum KeychainToolResponse: Equatable {
    case ok(value: String?)
    case failure(KeychainFailureReason)

    var isOK: Bool {
        if case .ok = self { return true }
        return false
    }

    /// 一行 JSON（含结尾换行）。
    var line: Data {
        let object: [String: Any]
        switch self {
        case .ok(let value):
            if let value { object = ["ok": true, "value": value] } else { object = ["ok": true] }
        case .failure(let reason):
            object = ["ok": false, "reason": reason.rawValue]
        }
        return JSONLine.encode(object) ?? Data("{\"ok\":false,\"reason\":\"other\"}\n".utf8)
    }
}

/// 钥匙串系统调用的抽象。实现见 SecItemBackend.swift；测试用内存实现。
protocol KeychainBackend {
    func add(service: String, account: String, value: Data, kind: KeychainItemKind) -> OSStatus
    func copy(service: String, account: String) -> (status: OSStatus, data: Data?)
    func delete(service: String, account: String) -> OSStatus
}

enum KeychainTool {
    static let expectedArguments = ["--stdin-json"]
    static let maxInputBytes = 256 * 1024
    static let maxValueBytes = 64 * 1024
    private static let allowedKeys: Set<String> = ["op", "ref", "kind", "value"]

    /// 整个调用：先检查 argv（必须恰好是 ["--stdin-json"]），再读 stdin 的一行并执行。
    static func run(arguments: [String], readInput: () -> Data?, backend: KeychainBackend) -> KeychainToolResponse {
        guard arguments == expectedArguments else { return .failure(.other) }
        guard let line = readInput(), let request = parse(line) else { return .failure(.other) }
        return execute(request, backend: backend)
    }

    static func parse(_ line: Data) -> KeychainToolRequest? {
        guard let object = JSONLine.decodeObject(line),
              Set(object.keys).isSubset(of: allowedKeys),
              let opText = object["op"] as? String, let op = KeychainToolOp(rawValue: opText),
              let kindText = object["kind"] as? String, let kind = KeychainItemKind(rawValue: kindText),
              let ref = object["ref"] as? String, KeychainRef.isValid(ref)
        else { return nil }
        let rawValue = object["value"]
        switch op {
        case .set:
            guard let value = rawValue as? String, value.utf8.count <= maxValueBytes else { return nil }
            return KeychainToolRequest(op: op, ref: ref, kind: kind, value: value)
        case .get, .delete:
            // 读取与删除不接受秘密值，避免调用方误把值放进不需要它的请求
            guard rawValue == nil else { return nil }
            return KeychainToolRequest(op: op, ref: ref, kind: kind, value: nil)
        }
    }

    static func execute(_ request: KeychainToolRequest, backend: KeychainBackend) -> KeychainToolResponse {
        let service = request.kind.service
        switch request.op {
        case .set:
            guard let value = request.value else { return .failure(.other) }
            let status = backend.add(service: service, account: request.ref, value: Data(value.utf8), kind: request.kind)
            if status == errSecSuccess { return .ok(value: nil) }
            // 引用每次新建、从不覆盖：同名项已存在按失败处理，不更新旧值
            if status == errSecDuplicateItem { return .failure(.other) }
            return .failure(.from(status: status))
        case .get:
            // 账号密码只由签名的原生桥自己读取；本工具拒绝读出
            guard request.kind != .account else { return .failure(.acl) }
            let result = backend.copy(service: service, account: request.ref)
            guard result.status == errSecSuccess else { return .failure(.from(status: result.status)) }
            guard let data = result.data, let value = String(data: data, encoding: .utf8) else { return .failure(.other) }
            return .ok(value: value)
        case .delete:
            let status = backend.delete(service: service, account: request.ref)
            return status == errSecSuccess ? .ok(value: nil) : .failure(.from(status: status))
        }
    }
}
