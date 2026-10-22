import Foundation
import Security

/// 钥匙串失败原因。与服务端 service/src/secrets/keychain-helper-store.ts 的 reason 取值一致
/// （timeout 只由服务端产生）。
enum KeychainFailureReason: String, Error, Equatable, CaseIterable {
    case denied
    /// errSecInteractionNotAllowed。Apple 只定义为 “Interaction with the Security Server is not allowed.”
    /// （https://developer.apple.com/documentation/security/errsecinteractionnotallowed）；需要用户认证而又不允许显示界面时
    /// 也返回它（kSecUseAuthenticationUIFail：“if user authentication is needed, the function returns the
    /// errSecInteractionNotAllowed error.”，https://developer.apple.com/documentation/security/ksecuseauthenticationuifail）。
    /// 所以它表示「需要交互但当前不允许」，不一定是钥匙串已锁定。线路值沿用 "locked"（与服务端的 reason 取值一致）。
    // P0: bridge_keychain_access —— 记录钥匙串锁定、用户拒绝时扩展（登录填充）与 sfe-keychain（LaunchAgent 启动的服务调用）
    // 分别得到哪个 reason，再决定是否拆分。
    case locked
    case acl
    case notFound = "not_found"
    case other

    static func from(status: OSStatus) -> KeychainFailureReason {
        switch status {
        case errSecAuthFailed, errSecUserCanceled:
            return .denied
        case errSecInteractionNotAllowed:
            return .locked
        case errSecMissingEntitlement, errSecInvalidOwnerEdit:
            return .acl
        case errSecItemNotFound:
            return .notFound
        default:
            return .other
        }
    }

    /// 面向用户的原因（不含任何钥匙串内容）。
    var displayText: String {
        switch self {
        case .denied: return "用户拒绝了访问"
        case .locked: return "钥匙串需要用户交互但当前不允许（可能已锁定，或无法显示授权提示）"
        case .acl: return "访问控制不匹配"
        case .notFound: return "找不到该项"
        case .other: return "钥匙串返回错误"
        }
    }
}

/// 钥匙串引用（kSecAttrAccount）。格式与服务端 REF_RE 一致：只含字母、数字与 . _ : -。
enum KeychainRef {
    static let maxLength = 256

    static func isValid(_ ref: String) -> Bool {
        guard !ref.isEmpty, ref.utf8.count <= maxLength else { return false }
        return ref.utf8.allSatisfy { byte in
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"),
                 UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: ":"), UInt8(ascii: "-"):
                return true
            default:
                return false
            }
        }
    }
}
