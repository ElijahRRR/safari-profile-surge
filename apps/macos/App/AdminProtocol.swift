import Foundation

/// maintenance.sock 的 NDJSON 约定（packages/contract/src/admin.ts）与宿主 App 用到的纯函数：
/// 请求 `{ v: 1, op, args }`；应答 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, details? } }`。
enum AdminProtocol {
    static let version = 1
    /// 环境列表与状态快照可能较大。
    static let maxResponseBytes = 8 * 1024 * 1024

    /// 服务返回的错误（不是 Swift Error：details 是任意 JSON）。
    struct AdminError {
        let code: String
        let message: String
        let details: [String: Any]?
    }

    enum Reply {
        case success(Any)
        case failure(AdminError)
    }

    static func requestLine(op: String, args: [String: Any] = [:]) -> Data? {
        JSONLine.encode(["v": version, "op": op, "args": args] as [String: Any])
    }

    /// 解析应答；格式不正确时返回 nil。成功应答的负载字段按 data（兼容 result）读取。
    static func parseReply(_ line: Data) -> Reply? {
        guard let object = JSONLine.decodeObject(line), let ok = JSONLine.bool(object["ok"]) else { return nil }
        if ok {
            if let data = object["data"] { return .success(data) }
            if let result = object["result"] { return .success(result) }
            return nil
        }
        guard let error = object["error"] as? [String: Any],
              let code = error["code"] as? String, NativeBridge.isWellFormedErrorCode(code),
              let message = error["message"] as? String
        else { return nil }
        return .failure(AdminError(code: code, message: message, details: error["details"] as? [String: Any]))
    }

    // MARK: 环境

    struct EnvironmentItem: Identifiable, Equatable {
        let id: String
        let displayName: String
        let isBound: Bool
        let profileIdShort: String?

        var menuTitle: String { isBound ? displayName : "\(displayName)（未关联场景）" }
    }

    /// listEnvironments 的结果（EnvironmentView[]）中宿主 App 用到的字段。
    static func parseEnvironments(_ payload: Any) -> [EnvironmentItem]? {
        guard let list = payload as? [Any] else { return nil }
        return list.compactMap { raw -> EnvironmentItem? in
            guard let env = raw as? [String: Any],
                  let id = env["id"] as? String, !id.isEmpty,
                  let name = env["displayName"] as? String
            else { return nil }
            let binding = env["binding"] as? [String: Any]
            let state = binding?["state"] as? String
            return EnvironmentItem(
                id: id,
                displayName: name,
                isBound: state == "bound" || state == "bound_unverified_id",
                profileIdShort: binding?["profileIdShort"] as? String
            )
        }
    }

    // MARK: 激活与旧窗口确认

    static let policies = ["closed_confirmed", "keep_open_acknowledged"]

    struct Confirmation: Equatable {
        let reason: String
        let currentEnvironmentId: String?
        let currentEnvironmentLabel: String?
        let otherProfiles: [OtherProfile]
        /// 只保留已知选项，顺序固定为 closed_confirmed、keep_open_acknowledged。
        let options: [String]
        let limitation: String?
    }

    struct OtherProfile: Equatable {
        let profileIdShort: String
        let environmentLabel: String?
    }

    /// NEEDS_CONFIRMATION 的 details（NeedsConfirmationDetails）。
    static func parseConfirmation(_ details: [String: Any]?) -> Confirmation? {
        guard let details, let reason = details["reason"] as? String, let rawOptions = details["options"] as? [Any] else { return nil }
        let offered = Set(rawOptions.compactMap { $0 as? String })
        let others = (details["otherProfilesOpen"] as? [Any] ?? []).compactMap { raw -> OtherProfile? in
            guard let item = raw as? [String: Any], let short = item["profileIdShort"] as? String else { return nil }
            return OtherProfile(profileIdShort: short, environmentLabel: item["environmentLabel"] as? String)
        }
        return Confirmation(
            reason: reason,
            currentEnvironmentId: details["currentEnvironmentId"] as? String,
            currentEnvironmentLabel: details["currentEnvironmentLabel"] as? String,
            otherProfiles: others,
            options: policies.filter { offered.contains($0) },
            limitation: details["limitation"] as? String
        )
    }

    /// activate 的参数（`{ id } & ActivateRequest`）。确认后重发时 request_id 不变。
    static func activateArgs(environmentId: String, requestId: String, choice: (policy: String, confirmedEnvironmentId: String?)?) -> [String: Any] {
        var args: [String: Any] = ["id": environmentId, "request_id": requestId]
        if let choice {
            args["old_session_policy"] = choice.policy
            if let confirmed = choice.confirmedEnvironmentId {
                args["confirmed_environment_id"] = confirmed
            } else {
                args["confirmed_environment_id"] = NSNull()
            }
        }
        return args
    }

    static func policyButtonTitle(_ policy: String) -> String {
        policy == "closed_confirmed" ? "已关闭，继续" : "不关闭，继续"
    }

    static func policyConsequence(_ policy: String) -> String {
        if policy == "closed_confirmed" {
            return "请先保存工作并关闭旧环境的 Safari 窗口再继续。切换时会结束属于 Safari 的旧连接。"
        }
        return "旧窗口之后的请求会经过新环境的出口（整个 Safari 同一时刻只用一个出口）。状态会持续显示警告，直到你确认已关闭。"
    }

    static func reasonText(_ reason: String) -> String {
        switch reason {
        case "other_environment_active": return "另一个环境正在使用 Safari 的出口。"
        case "managed_environment_active": return "有托管环境正在使用 Safari 的出口。"
        case "other_profiles_open": return "其他 Safari 场景有打开的窗口。整个 Safari 同一时刻只使用一个出口。"
        default: return "需要确认旧环境窗口如何处理。"
        }
    }

    /// 确认弹窗的说明文字：原因、当前环境、其他场景、限制说明与两个选项的后果。
    static func confirmationText(_ confirmation: Confirmation) -> String {
        var lines: [String] = [reasonText(confirmation.reason)]
        lines.append("当前使用环境：\(confirmation.currentEnvironmentLabel ?? "无")")
        if !confirmation.otherProfiles.isEmpty {
            let names = confirmation.otherProfiles.map { "\($0.profileIdShort) \($0.environmentLabel ?? "未绑定场景")" }
            lines.append("有打开窗口的其他场景：\(names.joined(separator: "、"))（只包含已启用扩展并上报过的场景）")
        }
        if let limitation = confirmation.limitation, !limitation.isEmpty {
            lines.append(limitation)
        }
        lines.append("")
        for policy in confirmation.options {
            lines.append("\(policyButtonTitle(policy))：\(policyConsequence(policy))")
        }
        return lines.joined(separator: "\n")
    }

    /// 受理后的引导：不称一键完成，由用户在 Safari 中切换场景并点击扩展图标。
    static func activationGuidance(environmentName: String) -> String {
        "在 Safari 切换到场景 \(environmentName)，点击扩展图标完成验证"
    }

    // MARK: 管理后台登录地址

    /// 只接受服务返回的回环登录地址 http://127.0.0.1:<port>/auth/exchange?code=…（或 localhost）。
    static func validatedLoginURL(_ text: String) -> URL? {
        guard text.utf8.count <= 2048,
              let components = URLComponents(string: text),
              components.scheme == "http",
              let host = components.host, host == "127.0.0.1" || host == "localhost",
              let port = components.port, (1...65535).contains(port),
              components.user == nil, components.password == nil,
              components.path == "/auth/exchange",
              let url = components.url
        else { return nil }
        return url
    }

    // MARK: 服务状态

    /// status（Snapshot）中宿主 App 显示的摘要。
    static func statusLines(snapshot: Any) -> [String] {
        guard let snapshot = snapshot as? [String: Any] else { return ["本机服务：应答格式不正确"] }
        var lines: [String] = []
        let version = snapshot["serviceVersion"] as? String
        lines.append(version.map { "本机服务：已连接（版本 \($0)）" } ?? "本机服务：已连接")
        if JSONLine.bool(snapshot["demoMode"]) == true {
            lines.append("演示模式：数据为合成数据，不代表任何网络事实")
        }
        if let surge = snapshot["surge"] as? [String: Any] {
            if JSONLine.bool(surge["reachable"]) == true {
                let surgeVersion = (surge["version"] as? String).map { "（\($0)）" } ?? ""
                lines.append("Surge：可连接\(surgeVersion)")
                switch JSONLine.bool(surge["onWorkingProfile"]) {
                case true?: lines.append("工作配置：正在使用")
                case false?: lines.append("工作配置：当前不是固定工作配置")
                case nil: break
                }
            } else {
                lines.append("Surge：无法连接")
            }
        }
        if let route = snapshot["route"] as? [String: Any] {
            let names = environmentNames(snapshot["environments"])
            if let activeId = route["activeEnvironmentId"] as? String {
                lines.append("当前环境：\(names[activeId] ?? activeId)")
            } else if route["entryMode"] as? String == "NORMAL" {
                lines.append("当前环境：无（普通模式）")
            } else {
                lines.append("当前环境：无")
            }
            if let warnings = route["warnings"] as? [Any], !warnings.isEmpty {
                lines.append("路由警告：\(warnings.count) 项，请在管理后台查看")
            }
        }
        return lines
    }

    private static func environmentNames(_ value: Any?) -> [String: String] {
        var names: [String: String] = [:]
        for raw in value as? [Any] ?? [] {
            if let env = raw as? [String: Any], let id = env["id"] as? String, let name = env["displayName"] as? String {
                names[id] = name
            }
        }
        return names
    }
}
