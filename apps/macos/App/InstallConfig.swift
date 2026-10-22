import Foundation

/// <数据目录>/install.json（0600）：服务只从这里读取 Surge CLI 路径、钥匙串工具路径、Node 版本、原语实现与原生桥端口
/// （service/src/config.ts readInstallConfig）。宿主 App 每次启动合并写入自己负责的字段；
/// adapterMechanism 只在首次创建时写默认值（全部 unavailable），之后由 P0 填写，从不覆盖。
enum InstallConfig {
    static let fileName = "install.json"
    static let defaultSurgeCLIPath = "/Applications/Surge.app/Contents/Applications/surge-cli"

    /// 与 service/src/config.ts 的 ALL_SURGE_PRIMITIVES 一致。
    static let primitives = [
        "getVersion",
        "getRuntimeInfo",
        "getCurrentProfile",
        "getTakeoverState",
        "getAutoReloadSetting",
        "checkProfile",
        "listPolicies",
        "getPolicyDetail",
        "getGroupMembers",
        "getGroupSelection",
        "selectGroupPolicy",
        "testPolicy",
        "listRules",
        "matchRule",
        "listActiveRequests",
        "listRecentRequests",
        "killRequest",
        "listExternalResources",
        "updateExternalResource",
        "listTempRules",
        "addTempRule",
        "removeTempRule",
        "reloadProfile",
    ]

    struct Fields: Equatable {
        /// 只有默认位置的 surge-cli 存在时才给值；为 nil 时保留已有值。
        var surgeCliPath: String?
        var keychainHelperPath: String
        /// 不符合 x.y.z 时不写入。
        var nodeVersionPin: String?
        var bridgePort: UInt16
        /// App 包内 Contents/Resources/service/web（存在时）。
        var webRoot: String?
    }

    static func defaultMechanisms() -> [String: String] {
        Dictionary(uniqueKeysWithValues: primitives.map { ($0, "unavailable") })
    }

    static func isValidNodeVersion(_ text: String) -> Bool {
        var body = Substring(text)
        if body.hasPrefix("v") { body = body.dropFirst() }
        let parts = body.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy { !$0.isEmpty && $0.count <= 6 && $0.allSatisfy(\.isASCIIDigit) }
    }

    /// 合并：保留未知字段与已有的 adapterMechanism；更新宿主 App 负责的字段。
    static func merged(existing: [String: Any]?, fields: Fields) -> [String: Any] {
        var config = existing ?? [:]
        if let surge = fields.surgeCliPath { config["surgeCliPath"] = surge }
        config["keychainHelperPath"] = fields.keychainHelperPath
        if let pin = fields.nodeVersionPin, isValidNodeVersion(pin) { config["nodeVersionPin"] = pin }
        // 本构建的原生桥只支持回环 TCP；与 App Group 中的 bridge.json 保持一致
        config["bridge"] = ["transport": "tcp", "port": Int(fields.bridgePort)] as [String: Any]
        if let webRoot = fields.webRoot { config["webRoot"] = webRoot }
        if !(config["adapterMechanism"] is [String: Any]) {
            config["adapterMechanism"] = defaultMechanisms()
        }
        return config
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
