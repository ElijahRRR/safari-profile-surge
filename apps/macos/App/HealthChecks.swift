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
enum BridgeProbe {
    static func isReachable(bundle: Bundle = .main) async -> Bool {
        guard case .success(let credentials) = BridgeFiles.load(bundle: bundle),
              case .success(let payload) = NativeBridge.bridgePayload(
                  message: ["type": "getCurrentState"],
                  profileId: nil,
                  bridgeVersion: NativeBridge.bridgeVersion(bundle: bundle)
              ),
              let nonce = BridgeHandshake.randomNonce()
        else { return false }
        let handshake = BridgeHandshake(token: credentials.token, payload: payload, clientNonce: nonce)
        return await withCheckedContinuation { continuation in
            BridgeClient(endpoint: credentials.endpoint).send(handshake) { result in
                guard case .success(let data) = result, case .success(let response) = NativeBridge.parseResponse(data) else {
                    continuation.resume(returning: false)
                    return
                }
                continuation.resume(returning: JSONLine.bool(response["ok"]) == true)
            }
        }
    }
}
