import Foundation

// sfe-keychain：服务端调用的钥匙串小工具（打包在 App 的 Contents/Helpers）。
// argv 必须恰好是 ["--stdin-json"]；从 stdin 读一行 JSON 请求，向 stdout 写一行 JSON 应答。
// 从不写 stderr、从不记录日志；除 get（proxy/system）的应答外，任何输出都不含秘密值。

func readFirstStdinLine(maxBytes: Int) -> Data? {
    var buffer = LineBuffer(maxBytes: maxBytes)
    let input = FileHandle.standardInput
    while true {
        let chunk = input.availableData
        if chunk.isEmpty {
            if case .line(let line) = buffer.finish() { return line }
            return nil
        }
        switch buffer.append(chunk) {
        case .line(let line):
            return line
        case .tooLong:
            return nil
        case .needMore, .empty:
            continue
        }
    }
}

let response = KeychainTool.run(
    arguments: Array(CommandLine.arguments.dropFirst()),
    readInput: { readFirstStdinLine(maxBytes: KeychainTool.maxInputBytes) },
    backend: SecItemBackend()
)
try? FileHandle.standardOutput.write(contentsOf: response.line)
exit(response.isOK ? 0 : 1)
