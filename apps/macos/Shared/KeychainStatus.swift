import Foundation
import Security

/// 钥匙串失败原因。与服务端 service/src/secrets/keychain-helper-store.ts 的 reason 取值一致
/// （timeout 只由服务端产生）。
enum KeychainFailureReason: String, Error, Equatable, CaseIterable {
    case denied
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
        case .locked: return "钥匙串已锁定"
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
