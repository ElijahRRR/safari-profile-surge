import Foundation
import Security

/// 原生桥读取账号密码。首选方案（docs/ARCHITECTURE.md §2）：登录钥匙串（文件型）中由 App 内 sfe-keychain
/// 写入的项，条目访问控制信任 sfe-keychain 与本扩展。编译标志 SFE_DATA_PROTECTION_KEYCHAIN 打开时改用
/// 备选方案：数据保护钥匙串 + 共享访问组 $(AppIdentifierPrefix)com.sfe.shared（需要带描述文件的签名组件写入，
/// 只在 extension_install_persistence 证明免费描述文件不会失效时采用）。
/// 从不记录、打印或缓存读到的值。
enum KeychainAccess {
    static let accountService = "com.sfe.account"
    static let accessGroupInfoKey = "SFEKeychainAccessGroup"

    // P0: bridge_keychain_access —— 签名扩展读取 sfe-keychain 写入的项不出现授权提示；App 重新构建/重签后的提示次数。
    static func readAccountPassword(ref: String, bundle: Bundle = .main) -> Result<String, KeychainFailureReason> {
        guard KeychainRef.isValid(ref) else { return .failure(.other) }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: accountService,
            kSecAttrAccount as String: ref,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        #if SFE_DATA_PROTECTION_KEYCHAIN
        guard let group = bundle.object(forInfoDictionaryKey: accessGroupInfoKey) as? String,
              !group.isEmpty, !group.hasPrefix("."), !group.contains("$(")
        else {
            return .failure(.acl)
        }
        query[kSecUseDataProtectionKeychain as String] = true
        query[kSecAttrAccessGroup as String] = group
        #else
        query[kSecUseDataProtectionKeychain as String] = false
        #endif

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return .failure(.from(status: status)) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else { return .failure(.other) }
        return .success(value)
    }
}
