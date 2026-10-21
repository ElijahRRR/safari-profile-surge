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

    static func statusText(_ status: SMAppService.Status) -> String {
        switch status {
        case .enabled: return "后台服务：已注册"
        case .notRegistered: return "后台服务：未注册"
        case .requiresApproval: return "后台服务：等待在系统设置的登录项中允许"
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
