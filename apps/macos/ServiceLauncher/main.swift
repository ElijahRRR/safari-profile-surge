import Foundation

// sfe-service-launcher：LaunchAgent（com.sfe.service.plist）的 BundleProgram。
// launchd 只把 BundleProgram 按 App 包解析，ProgramArguments 中的相对路径会按当前目录（/）解析，
// 所以由这个小程序按自身位置算出打包的 node（Contents/Helpers/node）与 service.mjs（Contents/Resources/service/）的
// 绝对路径，再 execv（保持同一进程，launchd 的 KeepAlive 仍跟踪它）。不接受参数、从不加 --demo、不设置任何环境变量。
// P0: native_bridge_ipc —— 确认 SMAppService 注册后服务能启动、无 TCC 提示，服务重启/升级后仍可达。

enum LauncherExit {
    /// sysexits.h EX_CONFIG：App 包内缺少 node 或 service.mjs。
    static let config: Int32 = 78
    /// sysexits.h EX_OSERR：execv 失败。
    static let osError: Int32 = 71
}

guard let executable = BundleLayout.currentExecutable(),
      let command = BundleLayout.serviceCommand(forHelperExecutable: executable),
      FileManager.default.isExecutableFile(atPath: command.node.path),
      FileManager.default.isReadableFile(atPath: command.script.path)
else {
    exit(LauncherExit.config)
}

let nodePath = command.node.path
let arguments: [UnsafeMutablePointer<CChar>?] = [strdup(nodePath), strdup(command.script.path), nil]
execv(nodePath, arguments)
exit(LauncherExit.osError)
