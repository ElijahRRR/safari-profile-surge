import Foundation

/// 原生桥的转发流程，与系统接口解耦以便测试：
/// 校验信封 → 读取传输配置 → 生成 BridgePayload 与握手（令牌不上线路）→ 回环握手与往返 → 解析应答。
/// 每次调用恰好回调一次；失败一律转换为 NativeResponse 错误应答。
/// 所有类型的应答都原样交给扩展，不改写：requestLoginFill 的应答含服务从本机后台资料读出的账号密码
/// （`{ field, value }`），只经过这里交给扩展，从不记录、缓存或写入日志。
struct BridgeForwarder {
    /// 连接 endpoint 并完成 BridgeConversation（BridgeClient.send）；回调服务的应答行。
    typealias Transport = (_ endpoint: BridgeEndpoint, _ handshake: BridgeHandshake, _ completion: @escaping (Result<Data, BridgeTransportError>) -> Void) -> Void

    struct Outcome {
        /// 交给扩展的 NativeResponse。
        let response: [String: Any]
        /// 只用于日志：已知消息类型或 "unknown"。
        let logType: String
        /// 只用于日志："ok" 或错误码。
        let logCode: String
    }

    let loadCredentials: () -> Result<BridgeCredentials, NativeFailure>
    let transport: Transport
    let bridgeVersion: String
    var makeNonce: () -> [UInt8]? = { BridgeHandshake.randomNonce() }

    func handle(message raw: Any?, profileId: String?, completion: @escaping (Outcome) -> Void) {
        let envelope: NativeBridge.ValidatedEnvelope
        switch NativeBridge.validateEnvelope(raw) {
        case .failure(let failure):
            completion(Self.outcome(failure, logType: "unknown"))
            return
        case .success(let value):
            envelope = value
        }
        let logType = NativeBridge.logName(forType: envelope.type)

        let credentials: BridgeCredentials
        switch loadCredentials() {
        case .failure(let failure):
            completion(Self.outcome(failure, logType: logType))
            return
        case .success(let value):
            credentials = value
        }

        let payload: String
        switch NativeBridge.bridgePayload(message: envelope.message, profileId: profileId, bridgeVersion: bridgeVersion) {
        case .failure(let failure):
            completion(Self.outcome(failure, logType: logType))
            return
        case .success(let value):
            payload = value
        }
        guard let nonce = makeNonce() else {
            completion(Self.outcome(.nonceUnavailable, logType: logType))
            return
        }
        let handshake = BridgeHandshake(token: credentials.token, payload: payload, clientNonce: nonce)

        transport(credentials.endpoint, handshake) { result in
            switch result.mapError(NativeFailure.unreachable).flatMap(NativeBridge.parseResponse) {
            case .failure(let failure):
                completion(Self.outcome(failure, logType: logType))
            case .success(let response):
                completion(Outcome(response: response, logType: logType, logCode: NativeBridge.outcomeCode(of: response)))
            }
        }
    }

    private static func outcome(_ failure: NativeFailure, logType: String) -> Outcome {
        Outcome(response: failure.responseObject, logType: logType, logCode: failure.code)
    }
}
