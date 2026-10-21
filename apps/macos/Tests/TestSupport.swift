import Foundation
import XCTest

/// 按 Safari / JSONSerialization 的方式得到 Foundation 对象（数字与布尔值都是 NSNumber）。
func jsonObject(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> Any {
    do {
        return try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    } catch {
        XCTFail("invalid test JSON: \(error)", file: file, line: line)
        return NSNull()
    }
}

func jsonDictionary(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
    guard let dict = jsonObject(text, file: file, line: line) as? [String: Any] else {
        XCTFail("test JSON is not an object", file: file, line: line)
        return [:]
    }
    return dict
}

/// 去掉结尾换行后解析一行 JSON。
func decodeLine(_ data: Data, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
    XCTAssertEqual(data.last, 0x0A, "line must end with a newline", file: file, line: line)
    XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1, "exactly one newline", file: file, line: line)
    guard let object = JSONLine.decodeObject(data.dropLast()) else {
        XCTFail("line is not a JSON object", file: file, line: line)
        return [:]
    }
    return object
}

func errorCode(_ response: [String: Any]) -> String? {
    (response["error"] as? [String: Any])?["code"] as? String
}

func errorMessage(_ response: [String: Any]) -> String? {
    (response["error"] as? [String: Any])?["message"] as? String
}

func errorReason(_ response: [String: Any]) -> String? {
    ((response["error"] as? [String: Any])?["details"] as? [String: Any])?["reason"] as? String
}

/// 序列化后的文本（用于“不含某个值”的断言）。
func serialized(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return "" }
    return String(decoding: data, as: UTF8.self)
}

enum Fixtures {
    /// 合成的 43 字符 base64url 令牌（不是真实令牌）。
    static let token = String(repeating: "A", count: 42) + "Q"
    static let profileUUID = UUID(uuidString: "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0")!
    static let profileId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
    static let syntheticSecret = "synthetic-secret-1"
    static let accountRef = "acct:env-0001:r1"
}
