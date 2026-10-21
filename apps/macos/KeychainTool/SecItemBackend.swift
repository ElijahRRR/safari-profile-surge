import Foundation
import Security

/// 登录钥匙串（文件型）上的 SecItem 实现。所有查询显式设置 kSecUseDataProtectionKeychain = false。
struct SecItemBackend: KeychainBackend {
    func add(service: String, account: String, value: Data, kind: KeychainItemKind) -> OSStatus {
        var attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: kind.label,
            kSecValueData as String: value,
            kSecUseDataProtectionKeychain as String: false,
        ]
        if kind == .account {
            // 账号密码：条目访问控制只信任 sfe-keychain 自己与签名的扩展；做不到就不写入
            let access = AccountItemAccess.make(label: kind.label)
            guard let secAccess = access.access else { return access.status }
            attributes[kSecAttrAccess as String] = secAccess
        }
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    func copy(service: String, account: String) -> (status: OSStatus, data: Data?) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseDataProtectionKeychain as String: false,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return (status, item as? Data)
    }

    func delete(service: String, account: String) -> OSStatus {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: false,
        ]
        return SecItemDelete(query as CFDictionary)
    }
}

/// 账号密码条目的访问控制（SecAccess 受信任应用列表）：sfe-keychain 自己 + 同一 App 包内的扩展。
///
/// SecAccess / SecTrustedApplication 自 macOS 10.10 标为过时，但对文件型钥匙串在 macOS 14 上仍然有效，
/// 编译时会有过时警告。签名身份相同（同一 Team）时，系统的分区列表（teamid:<Team ID>）也允许扩展读取。
///
/// 备选方案（不在本工具中实现）：数据保护钥匙串 + 共享访问组 $(AppIdentifierPrefix)com.sfe.shared。
/// 它要求写入方带 keychain-access-groups 权限与描述文件，裸命令行工具无法内嵌描述文件，
/// 因此写入方必须改为宿主 App；扩展侧读取已在 KeychainAccess（SFE_DATA_PROTECTION_KEYCHAIN）中准备好。
// P0: bridge_keychain_access —— 确认：受信任应用列表按代码签名匹配 .appex；扩展读取不出现提示；
// App 重新构建或重签（免费描述文件约 7 天）后是否需要重新授权、提示次数。
enum AccountItemAccess {
    static func make(label: String) -> (access: SecAccess?, status: OSStatus) {
        guard let executable = BundleLayout.currentExecutable(),
              let extensionURL = BundleLayout.extensionBundle(forHelperExecutable: executable),
              FileManager.default.fileExists(atPath: extensionURL.path)
        else {
            // 不在 App 包内运行（找不到扩展）：拒绝写入，避免产生扩展读不到的“可用”引用
            return (nil, errSecMissingEntitlement)
        }

        var selfApp: SecTrustedApplication?
        var status = SecTrustedApplicationCreateFromPath(nil, &selfApp)
        guard status == errSecSuccess, let selfApp else { return (nil, status == errSecSuccess ? errSecInvalidOwnerEdit : status) }

        var extensionApp: SecTrustedApplication?
        status = SecTrustedApplicationCreateFromPath(extensionURL.path, &extensionApp)
        guard status == errSecSuccess, let extensionApp else { return (nil, status == errSecSuccess ? errSecInvalidOwnerEdit : status) }

        var access: SecAccess?
        status = SecAccessCreate(label as CFString, [selfApp, extensionApp] as CFArray, &access)
        guard status == errSecSuccess, let access else { return (nil, status == errSecSuccess ? errSecInvalidOwnerEdit : status) }
        return (access, errSecSuccess)
    }
}
