import Foundation
import os
import SafariServices

/// Safari Web Extension 的原生桥：从系统取得可信场景 ID，与本机服务完成双向 HMAC 握手后转发
/// （传输令牌从不上线路；服务不能证明持有令牌时不发送场景 ID 或消息）。
/// 扩展自报的任何身份字段都不被信任。服务的应答原样交给扩展（登录填充的应答含账号密码，不在这里读取或改写）。
/// 日志只记消息类型与结果码，从不记录消息、应答、令牌或密码（Xcode 模板中打印消息的 os_log 已去掉）。
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let logger = Logger(subsystem: "com.sfe.SafariProfileSurge.Extension", category: "bridge")

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let userInfo = item?.userInfo
        let message = userInfo?[SFExtensionMessageKey]
        // macOS 14 / Safari 17 起提供；没有时 profileId 为 null，服务只允许 getCurrentState 与 reportProfileState（只用于旧窗口确认）
        let profileId = NativeBridge.profileIdentifier(from: userInfo?[SFExtensionProfileKey])

        let forwarder = BridgeForwarder(
            loadCredentials: { BridgeFiles.load() },
            transport: { endpoint, handshake, completion in
                BridgeClient(endpoint: endpoint).send(handshake, completion: completion)
            },
            // 与宿主 App 的 BridgeProbe 相同的格式（"0.1.0+1"，不含空格）
            bridgeVersion: NativeBridge.bridgeVersion(bundle: .main)
        )
        forwarder.handle(message: message, profileId: profileId) { outcome in
            Self.logger.info("native \(outcome.logType, privacy: .public) -> \(outcome.logCode, privacy: .public)")
            let reply = NSExtensionItem()
            reply.userInfo = [SFExtensionMessageKey: outcome.response]
            context.completeRequest(returningItems: [reply], completionHandler: nil)
        }
    }
}
