import Foundation

/// NDJSON 帧：一连接一请求、一行应答。只取第一行；上限按字节计，不含换行与行尾的 \r。
/// 原生桥（TCP）与维护套接字共用这一份切分逻辑。
struct LineBuffer {
    enum Outcome: Equatable {
        /// 还没有读到换行。
        case needMore
        /// 第一行（不含换行）。
        case line(Data)
        /// 超过上限：调用方应断开，不再继续读。
        case tooLong
        /// 连接结束时没有任何内容。
        case empty
    }

    let maxBytes: Int
    private(set) var buffer = Data()

    init(maxBytes: Int) {
        self.maxBytes = maxBytes
    }

    mutating func append(_ chunk: Data) -> Outcome {
        buffer.append(chunk)
        if let newline = buffer.firstIndex(of: 0x0A) {
            return Self.check(buffer[buffer.startIndex..<newline], maxBytes: maxBytes)
        }
        // 还没有换行：已经放不下（允许多一个 \r）就不必再等
        return buffer.count > maxBytes + 1 ? .tooLong : .needMore
    }

    /// 对端关闭写入时调用：没有换行结尾的剩余内容按一行处理。
    func finish() -> Outcome {
        if let newline = buffer.firstIndex(of: 0x0A) {
            return Self.check(buffer[buffer.startIndex..<newline], maxBytes: maxBytes)
        }
        if buffer.isEmpty { return .empty }
        return Self.check(buffer[...], maxBytes: maxBytes)
    }

    private static func check(_ slice: Data, maxBytes: Int) -> Outcome {
        var line = slice
        if line.last == 0x0D { line = line.dropLast() }
        guard line.count <= maxBytes else { return .tooLong }
        return .line(Data(line))
    }
}

enum JSONLine {
    /// 把 JSON 对象编码为一行（JSONSerialization 不输出原始换行；字符串中的换行会被转义）。
    static func encode(_ object: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        else { return nil }
        data.append(0x0A)
        return data
    }

    /// 只接受 JSON 对象。
    static func decodeObject(_ line: Data) -> [String: Any]? {
        guard let object = try? JSONSerialization.jsonObject(with: line, options: []) else { return nil }
        return object as? [String: Any]
    }

    /// JSON 布尔值。Foundation 把 true/false 与数字都表示为 NSNumber，`as? Bool` 会把 1 也当成 true，这里按类型严格区分。
    static func bool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// JSON 整数（排除布尔值与小数）。
    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double, abs(double) < 9_007_199_254_740_992 else { return nil }
        return number.intValue
    }
}
