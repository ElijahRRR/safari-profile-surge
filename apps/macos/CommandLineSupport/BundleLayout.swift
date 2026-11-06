import Foundation

/// App 包内的固定位置。命令行工具 sfe-service-launcher 与打包的 node 位于 Contents/Helpers，
/// 按自身位置推算其他组件，从不依赖当前目录或环境变量。
enum BundleLayout {
    /// .../SafariProfileSurge.app/Contents/Helpers/<工具> → .../SafariProfileSurge.app/Contents
    static func contentsDirectory(forHelperExecutable executable: URL) -> URL? {
        let helpers = executable.deletingLastPathComponent()
        let contents = helpers.deletingLastPathComponent()
        guard helpers.lastPathComponent == "Helpers", contents.lastPathComponent == "Contents" else { return nil }
        return contents
    }

    /// LaunchAgent 实际运行的命令：Contents/Helpers/node Contents/Resources/service/service.mjs（绝对路径）。
    /// Node 是 Mach-O 可执行文件，按 Apple「Placing content in a bundle」与其他辅助工具一样放在 Contents/Helpers
    /// （“help app, helper tool | macOS | Contents/MacOS/, Contents/Helpers/”；“Resources are everything that’s not code.”，
    /// https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle）；service.mjs 是脚本，留在 Resources。
    /// 与 Scripts/embed-runtime.sh 的复制位置一致。
    static func serviceCommand(forHelperExecutable executable: URL) -> (node: URL, script: URL)? {
        guard let contents = contentsDirectory(forHelperExecutable: executable) else { return nil }
        let helpers = contents.appendingPathComponent("Helpers", isDirectory: true)
        let resources = contents.appendingPathComponent("Resources", isDirectory: true)
        return (
            helpers.appendingPathComponent("node", isDirectory: false),
            resources.appendingPathComponent("service", isDirectory: true).appendingPathComponent("service.mjs", isDirectory: false)
        )
    }

    /// 当前可执行文件的真实路径（解析符号链接）。
    static func currentExecutable() -> URL? {
        if let url = Bundle.main.executableURL { return url.resolvingSymlinksInPath() }
        guard let first = CommandLine.arguments.first, first.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: first).resolvingSymlinksInPath()
    }
}
