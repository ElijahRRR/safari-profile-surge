import AppKit
import Foundation

/// 菜单栏 App 的弹窗。LSUIElement 应用先激活自己，弹窗才会出现在最前面。
@MainActor
enum Alerts {
    static func showError(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        run(alert)
    }

    static func showInfo(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        run(alert)
    }

    static func confirm(title: String, message: String, confirmTitle: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        // 确认按钮不响应回车，避免误触；取消对应 Esc
        alert.addButton(withTitle: confirmTitle).keyEquivalent = ""
        let cancel = alert.addButton(withTitle: "取消")
        cancel.keyEquivalent = "\u{1b}"
        return run(alert) == .alertFirstButtonReturn
    }

    /// 受理后的引导：不称一键完成。
    static func showGuidance(environment: AdminProtocol.EnvironmentItem) {
        var message = AdminProtocol.activationGuidance(environmentName: environment.displayName)
        if let short = environment.profileIdShort {
            message += "\n绑定场景 ID 前 8 位：\(short)"
        }
        showInfo(title: "已开始切换到环境 \(environment.displayName)", message: message)
    }

    /// 旧窗口确认：两个选项都没有默认按钮（回车不会选中任何一项），必须显式点击；取消对应 Esc。
    /// 返回所选的 old_session_policy；取消返回 nil。
    static func askOldSessionPolicy(_ confirmation: AdminProtocol.Confirmation, environmentName: String) -> String? {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "确定要切换到环境 \(environmentName) 吗？"
        alert.informativeText = AdminProtocol.confirmationText(confirmation)
        for policy in confirmation.options {
            let button = alert.addButton(withTitle: AdminProtocol.policyButtonTitle(policy))
            button.keyEquivalent = ""
        }
        let cancel = alert.addButton(withTitle: "取消")
        cancel.keyEquivalent = "\u{1b}"
        let index = run(alert).rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        guard index >= 0, index < confirmation.options.count else { return nil }
        return confirmation.options[index]
    }

    @discardableResult
    private static func run(_ alert: NSAlert) -> NSApplication.ModalResponse {
        NSApp.activate()
        return alert.runModal()
    }
}
