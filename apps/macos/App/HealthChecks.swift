import Foundation
import SafariServices

/// Safari 扩展是否启用。读不到时为 nil（显示为“无法读取”，不当作已启用）。
// P0: extension_install_persistence —— 不开启「允许未签名扩展」时，Safari 退出重开、重启、8 天以上与重新构建后
// 扩展仍保持启用；本检查只反映 Safari 报告的状态。
enum ExtensionStatus {
    static let identifier = "com.sfe.SafariProfileSurge.Extension"

    static func isEnabled() async -> Bool? {
        await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: identifier) { state, error in
                continuation.resume(returning: error == nil ? state?.isEnabled : nil)
            }
        }
    }

    static func openSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: identifier) { _ in }
    }
}

/// 原生桥是否可达：用 App Group 中的令牌与扩展完全相同的握手（BridgeConversation）与原生桥版本格式，
/// 发一次未识别场景的 getCurrentState（只读）。服务不能证明持有令牌时视为不可达。
/// 读取 App Group 容器失败时单独报告原因（系统拒绝访问与找不到配置分开），不当作服务不可达。
/// 这是宿主 App 自己读取的结果：扩展被拒绝访问容器时系统不提示，只有扩展弹窗会显示（NativeFailure.containerDenied）。
enum BridgeProbe {
    enum Outcome: Equatable {
        case reachable
        /// 宿主 App 读取 App Group 容器中的原生桥配置失败。
        case configProblem(BridgeFileProblem)
        /// 配置可读，但握手或往返失败。
        case unreachable

        var statusLine: String {
            switch self {
            case .reachable: return "原生桥：可连接"
            case .configProblem(let problem): return problem.hostStatusLine
            case .unreachable: return "原生桥：无法连接"
            }
        }

        /// 菜单顶部的问题提示；可连接时为 nil。
        var problemText: String? {
            switch self {
            case .reachable: return nil
            case .configProblem(let problem): return problem.hostProblemText
            case .unreachable: return "原生桥无法连接：扩展暂时不能与本机服务通信"
            }
        }
    }

    static func probe(bundle: Bundle = .main) async -> Outcome {
        let credentials: BridgeCredentials
        switch BridgeFiles.loadCredentials(bundle: bundle) {
        case .failure(let problem):
            return .configProblem(problem)
        case .success(let value):
            credentials = value
        }
        guard case .success(let payload) = NativeBridge.bridgePayload(
                  message: ["type": "getCurrentState"],
                  profileId: nil,
                  bridgeVersion: NativeBridge.bridgeVersion(bundle: bundle)
              ),
              let nonce = BridgeHandshake.randomNonce()
        else { return .unreachable }
        let handshake = BridgeHandshake(token: credentials.token, payload: payload, clientNonce: nonce)
        return await withCheckedContinuation { continuation in
            BridgeClient(endpoint: credentials.endpoint).send(handshake) { result in
                guard case .success(let data) = result, case .success(let response) = NativeBridge.parseResponse(data) else {
                    continuation.resume(returning: .unreachable)
                    return
                }
                continuation.resume(returning: JSONLine.bool(response["ok"]) == true ? .reachable : .unreachable)
            }
        }
    }
}
