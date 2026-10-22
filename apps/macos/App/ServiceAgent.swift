import Foundation
import ServiceManagement

/// App 包内的 LaunchAgent（Contents/Library/LaunchAgents/com.sfe.service.plist），由 SMAppService 注册。
/// 注册与停止都不改变 Surge 中的入口规则或 SFE-ROUTE 选择（docs/ARCHITECTURE.md §6.11）。
// P0: native_bridge_ipc —— 确认 Personal Team 签名下注册不需要额外批准，或批准流程与提示文字。
enum ServiceAgent {
    static let plistName = "com.sfe.service.plist"

    static var service: SMAppService {
        SMAppService.agent(plistName: plistName)
    }

    /// 系统设置中允许后台运行的那一页的名称：macOS 15 起为「登录项与扩展」，macOS 14 为「登录项」。
    /// Apple 使用手册（15，26 相同）：「若要更改这些设置，请选取苹果菜单 >“系统设置”，点按边栏中的“通用”，然后点按“登录项与扩展”。」
    /// （https://support.apple.com/zh-cn/guide/mac-help/mtusr003/15.0/mac/15.0）；14：「……然后点按右侧的“登录项”。」
    /// （https://support.apple.com/zh-cn/guide/mac-help/mtusr003/14.0/mac/14.0）。
    /// openSystemSettingsLoginItems()（“Opens System Settings to the Login Items control panel.”）打开的是同一页，只是名称不同。
    static func paneName(forOSMajorVersion major: Int) -> String {
        major >= 15 ? "登录项与扩展" : "登录项"
    }

    static var loginItemsPaneName: String {
        paneName(forOSMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
    }

    /// 菜单中打开这一页的按钮。
    static var openLoginItemsButtonTitle: String {
        "打开\(loginItemsPaneName)设置"
    }

    /// 注册后需要用户允许时的说明。
    static var approvalGuidance: String {
        "请在「系统设置 → 通用 → \(loginItemsPaneName)」中允许 SafariProfileSurge 在后台运行，然后回到这里刷新状态。"
    }

    static func statusText(_ status: SMAppService.Status) -> String {
        switch status {
        case .enabled: return "后台服务：已注册"
        case .notRegistered: return "后台服务：未注册"
        case .requiresApproval: return "后台服务：等待在系统设置的「\(loginItemsPaneName)」中允许"
        case .notFound: return "后台服务：App 包内找不到服务配置"
        @unknown default: return "后台服务：状态未知"
        }
    }

    static func register() throws {
        try service.register()
    }

    static func unregister() async throws {
        try await service.unregister()
    }

    static func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
