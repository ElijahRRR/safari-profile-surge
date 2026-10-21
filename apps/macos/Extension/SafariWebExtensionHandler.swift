import Foundation
import os
import SafariServices

/// Safari Web Extension 的原生桥：从系统取得可信场景 ID，加传输令牌转发给本机服务。
/// 扩展自报的任何身份字段都不被信任。日志只记消息类型与结果码，从不记录消息、应答、令牌或密码
/// （Xcode 模板中打印消息的 os_log 已去掉）。
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let logger = Logger(subsystem: "com.sfe.SafariProfileSurge.Extension", category: "bridge")

    private static var bridgeVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let userInfo = item?.userInfo
        let message = userInfo?[SFExtensionMessageKey]
        // macOS 14 / Safari 17 起提供；没有时 profileId 为 null，服务只允许 getCurrentState
        let profileId = NativeBridge.profileIdentifier(from: userInfo?[SFExtensionProfileKey])

        let forwarder = BridgeForwarder(
            loadCredentials: { BridgeFiles.load() },
            transport: { endpoint, line, completion in
                BridgeClient(endpoint: endpoint).roundTrip(line, completion: completion)
            },
            readPassword: { ref in KeychainAccess.readAccountPassword(ref: ref) },
            bridgeVersion: Self.bridgeVersion
        )
        forwarder.handle(message: message, profileId: profileId) { outcome in
            Self.logger.info("native \(outcome.logType, privacy: .public) -> \(outcome.logCode, privacy: .public)")
            let reply = NSExtensionItem()
            reply.userInfo = [SFExtensionMessageKey: outcome.response]
            context.completeRequest(returningItems: [reply], completionHandler: nil)
        }
    }
}
