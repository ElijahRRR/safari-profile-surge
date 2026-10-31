import AppKit
import Foundation
import ServiceManagement

/// 菜单栏状态与动作。所有对本机服务的调用经 maintenance.sock；从不记录请求、应答、登录地址或令牌。
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var environments: [AdminProtocol.EnvironmentItem] = []
    @Published private(set) var environmentsPlaceholder = "正在读取环境…"
    @Published private(set) var statusLines: [String] = ["正在读取服务状态…"]
    /// 菜单顶部的问题提示（扩展未启用、原生桥不可达、安装准备失败）。
    @Published private(set) var problems: [String] = []
    @Published private(set) var agentStatus: SMAppService.Status = .notRegistered
    @Published private(set) var activationInFlight = false

    private let maintenance = MaintenanceClient(socketPath: InstallPaths.maintenanceSocket)
    private var setupProblem: String?
    private var refreshTimer: Timer?
    private var refreshing = false

    static let refreshIntervalSeconds: TimeInterval = 30

    init() {
        runInstallSetup()
        refresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: Self.refreshIntervalSeconds, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.refresh() }
        }
    }

    var agentRegistered: Bool { agentStatus == .enabled || agentStatus == .requiresApproval }
    var agentNeedsApproval: Bool { agentStatus == .requiresApproval }
    var agentStatusText: String { ServiceAgent.statusText(agentStatus) }

    // MARK: 刷新

    private func runInstallSetup() {
        do {
            try InstallSetup.run()
            setupProblem = nil
        } catch let failure as InstallSetup.Failure {
            setupProblem = failure.message
        } catch {
            setupProblem = "准备原生桥失败：未知错误"
        }
    }

    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        Task {
            await refreshNow()
            refreshing = false
        }
    }

    private func refreshNow() async {
        // 首次准备失败（例如签名设置刚修正）时每次刷新重试；准备本身是幂等的
        if setupProblem != nil { runInstallSetup() }
        agentStatus = ServiceAgent.service.status

        switch await call("status") {
        case .success(let snapshot):
            statusLines = AdminProtocol.statusLines(snapshot: snapshot)
        case .failure(let message, _, _):
            statusLines = [message]
        }

        switch await call("listEnvironments") {
        case .success(let payload):
            if let items = AdminProtocol.parseEnvironments(payload) {
                environments = items
                environmentsPlaceholder = items.isEmpty ? "还没有环境，请在管理后台新建" : ""
            } else {
                environments = []
                environmentsPlaceholder = "读取环境失败：应答格式不正确"
            }
        case .failure(let message, _, _):
            environments = []
            environmentsPlaceholder = message
        }

        let bridge = await BridgeProbe.probe()
        let extensionEnabled = await ExtensionStatus.isEnabled()

        var lines = statusLines
        lines.append(bridge.statusLine)
        switch extensionEnabled {
        case true?: lines.append("Safari 扩展：已启用")
        case false?: lines.append("Safari 扩展：未启用")
        case nil: lines.append("Safari 扩展：无法读取状态")
        }
        lines.append(ServiceAgent.statusText(agentStatus))
        statusLines = lines

        var found: [String] = []
        if let setupProblem { found.append(setupProblem) }
        if extensionEnabled == false { found.append("Safari 扩展未启用：请在 Safari 设置的扩展中启用") }
        if let bridgeProblem = bridge.problemText { found.append(bridgeProblem) }
        problems = found
    }

    /// 一次维护命令的结果。失败的 message 面向用户（服务给出的 message 已是「动作 + 失败：原因」）。
    enum CallOutcome {
        case success(Any)
        case failure(message: String, code: String?, details: [String: Any]?)
    }

    private func call(_ op: String, args: [String: Any] = [:]) async -> CallOutcome {
        guard let line = AdminProtocol.requestLine(op: op, args: args) else {
            return .failure(message: "发送请求失败：参数格式不正确", code: nil, details: nil)
        }
        switch await maintenance.send(line) {
        case .failure(let transport):
            return .failure(message: transport.message, code: nil, details: nil)
        case .success(let responseLine):
            switch AdminProtocol.parseReply(responseLine) {
            case .success(let value)?:
                return .success(value)
            case .failure(let adminError)?:
                return .failure(message: adminError.message, code: adminError.code, details: adminError.details)
            case nil:
                return .failure(message: "无法连接本机服务：应答格式不正确", code: nil, details: nil)
            }
        }
    }

    // MARK: 动作

    func openConsole() {
        Task {
            switch await call("issueLoginCode") {
            case .success(let payload):
                guard let text = (payload as? [String: Any])?["url"] as? String, let url = AdminProtocol.validatedLoginURL(text) else {
                    Alerts.showError(title: "打开管理后台失败", message: "服务返回的登录地址不正确")
                    return
                }
                // 只交给 NSWorkspace 打开，从不传给子进程或写入日志
                NSWorkspace.shared.open(url)
            case .failure(let message, _, _):
                Alerts.showError(title: "打开管理后台失败", message: message)
            }
        }
    }

    /// 受控入口：激活（新的 request_id）；NEEDS_CONFIRMATION 时由用户在两个选项中显式选择，再用同一 request_id 重发。
    func openEnvironment(_ environment: AdminProtocol.EnvironmentItem) {
        guard !activationInFlight else { return }
        activationInFlight = true
        Task {
            await runActivation(environment)
            activationInFlight = false
            refresh()
        }
    }

    private func runActivation(_ environment: AdminProtocol.EnvironmentItem) async {
        let requestId = UUID().uuidString.lowercased()
        var choice: (policy: String, confirmedEnvironmentId: String?)?
        // 每次确认后重发；状态在确认期间变化时服务会再次要求确认
        for _ in 0..<3 {
            let args = AdminProtocol.activateArgs(environmentId: environment.id, requestId: requestId, choice: choice)
            switch await call("activate", args: args) {
            case .success:
                Alerts.showGuidance(environment: environment)
                return
            case .failure(let message, "NEEDS_CONFIRMATION"?, let details):
                guard let confirmation = AdminProtocol.parseConfirmation(details) else {
                    Alerts.showError(title: "打开环境失败", message: message)
                    return
                }
                guard let policy = Alerts.askOldSessionPolicy(confirmation, environmentName: environment.displayName) else {
                    return
                }
                choice = (policy, confirmation.currentEnvironmentId)
            case .failure(let message, _, _):
                Alerts.showError(title: "打开环境失败", message: message)
                return
            }
        }
        Alerts.showError(title: "打开环境失败", message: "当前状态多次变化，请稍后重试")
    }

    func registerAgent() {
        do {
            try ServiceAgent.register()
        } catch {
            Alerts.showError(title: "注册后台服务失败", message: error.localizedDescription)
        }
        agentStatus = ServiceAgent.service.status
        if agentStatus == .requiresApproval {
            Alerts.showInfo(title: "后台服务等待允许", message: ServiceAgent.approvalGuidance)
        }
        refresh()
    }

    func unregisterAgent() {
        guard Alerts.confirm(
            title: "确定要停止后台服务吗？",
            message: "停止后插件与网页后台都无法使用。停止服务不会改变 Surge 中的入口规则或 SFE-ROUTE 选择；要撤销本应用的规则，请先进入普通模式。",
            confirmTitle: "停止"
        ) else { return }
        Task {
            do {
                try await ServiceAgent.unregister()
            } catch {
                Alerts.showError(title: "停止后台服务失败", message: error.localizedDescription)
            }
            agentStatus = ServiceAgent.service.status
            refresh()
        }
    }

    func openLoginItemsSettings() {
        ServiceAgent.openLoginItemsSettings()
    }

    func openExtensionSettings() {
        ExtensionStatus.openSettings()
    }

    func showAbout() {
        NSApp.activate()
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: NSAttributedString(string: "Safari 场景驱动的 Surge 出口控制。离线测试通过不代表网络验收通过。"),
        ])
    }
}
