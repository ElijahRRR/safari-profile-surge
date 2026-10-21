import AppKit
import SwiftUI

/// 宿主 App：只有菜单栏图标（Info.plist 中 LSUIElement = YES，没有 Dock 图标与主窗口）。
@main
struct SafariProfileSurgeApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra("SafariProfileSurge", systemImage: "network") {
            MenuContent(model: model)
        }
        .menuBarExtraStyle(.menu)
    }
}

struct MenuContent: View {
    @ObservedObject var model: AppModel

    var body: some View {
        if !model.problems.isEmpty {
            ForEach(model.problems, id: \.self) { problem in
                Text(problem)
            }
            Divider()
        }

        Button("打开管理后台") { model.openConsole() }

        Menu("打开环境") {
            if model.environments.isEmpty {
                Text(model.environmentsPlaceholder)
            }
            ForEach(model.environments) { environment in
                Button(environment.menuTitle) { model.openEnvironment(environment) }
                    .disabled(!environment.isBound || model.activationInFlight)
            }
        }

        Menu("服务状态") {
            ForEach(Array(model.statusLines.enumerated()), id: \.offset) { item in
                Text(item.element)
            }
            Divider()
            Button("刷新") { model.refresh() }
        }

        Divider()

        Text(model.agentStatusText)
        if model.agentRegistered {
            Button("停止后台服务") { model.unregisterAgent() }
        } else {
            Button("注册后台服务") { model.registerAgent() }
        }
        if model.agentNeedsApproval {
            Button("打开登录项设置") { model.openLoginItemsSettings() }
        }
        Button("Safari 扩展设置") { model.openExtensionSettings() }

        Divider()

        Button("关于 SafariProfileSurge") { model.showAbout() }
        Button("退出") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
