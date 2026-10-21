import Foundation

/// App 包内的固定位置。命令行工具（sfe-keychain、sfe-service-launcher）位于 Contents/Helpers，
/// 按自身位置推算其他组件，从不依赖当前目录或环境变量。
enum BundleLayout {
    static let extensionBundleName = "SafariProfileSurgeExtension.appex"

    /// .../SafariProfileSurge.app/Contents/Helpers/<工具> → .../SafariProfileSurge.app/Contents
    static func contentsDirectory(forHelperExecutable executable: URL) -> URL? {
        let helpers = executable.deletingLastPathComponent()
        let contents = helpers.deletingLastPathComponent()
        guard helpers.lastPathComponent == "Helpers", contents.lastPathComponent == "Contents" else { return nil }
        return contents
    }

    static func extensionBundle(forHelperExecutable executable: URL) -> URL? {
        contentsDirectory(forHelperExecutable: executable)?
            .appendingPathComponent("PlugIns", isDirectory: true)
            .appendingPathComponent(extensionBundleName, isDirectory: true)
    }

    /// LaunchAgent 实际运行的命令：Contents/Resources/node Contents/Resources/service/service.mjs（绝对路径）。
    static func serviceCommand(forHelperExecutable executable: URL) -> (node: URL, script: URL)? {
        guard let contents = contentsDirectory(forHelperExecutable: executable) else { return nil }
        let resources = contents.appendingPathComponent("Resources", isDirectory: true)
        return (
            resources.appendingPathComponent("node", isDirectory: false),
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
