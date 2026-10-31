import XCTest

/// 用假的传输（内存中的 FakeBridgeServer，走完整握手）驱动完整的转发流程（不连网络）。
final class BridgeForwarderTests: XCTestCase {
    private final class FakeTransport {
        let server: FakeBridgeServer
        var endpoints: [BridgeEndpoint] = []

        /// serverToken：假服务持有的令牌；与原生桥不同时模拟不持有令牌的监听者。
        init(serverToken: String = Fixtures.token) {
            server = FakeBridgeServer(token: serverToken, reply: .failure(.connectFailed))
        }

        /// 证明通过后服务的应答（或传输失败）。
        var reply: Result<Data, BridgeTransportError> {
            get { server.reply }
            set { server.reply = newValue }
        }

        /// 原生桥发出的每一行（hello、request）。
        var sentLines: [Data] { server.received }

        func send(_ endpoint: BridgeEndpoint, _ handshake: BridgeHandshake, _ completion: @escaping (Result<Data, BridgeTransportError>) -> Void) {
            endpoints.append(endpoint)
            BridgeConversation.run(handshake, over: server, completion: completion)
        }
    }

    private let credentials = BridgeCredentials(endpoint: BridgeEndpoint(port: 61848), token: Fixtures.token)

    private func makeForwarder(
        transport: FakeTransport,
        credentials: Result<BridgeCredentials, NativeFailure>? = nil
    ) -> BridgeForwarder {
        let loaded = credentials ?? .success(self.credentials)
        return BridgeForwarder(
            loadCredentials: { loaded },
            transport: { endpoint, handshake, completion in transport.send(endpoint, handshake, completion) },
            bridgeVersion: "test"
        )
    }

    private func run(_ forwarder: BridgeForwarder, message: Any?, profileId: String? = Fixtures.profileId) -> BridgeForwarder.Outcome? {
        var captured: [BridgeForwarder.Outcome] = []
        forwarder.handle(message: message, profileId: profileId) { captured.append($0) }
        XCTAssertEqual(captured.count, 1, "completion must be called exactly once")
        return captured.first
    }

    func testForwardsValidEnvelopeAndReturnsServiceResponse() throws {
        let transport = FakeTransport()
        transport.reply = .success(Data(#"{"ok":true,"data":{"recorded":true}}"#.utf8))
        let message = jsonObject(#"{"v":1,"message":{"type":"reportProfileState","windows_open":1,"amazon_tabs_open":false,"site_permission_granted":true}}"#)
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: message))

        XCTAssertEqual(outcome.logType, "reportProfileState")
        XCTAssertEqual(outcome.logCode, "ok")
        XCTAssertEqual(JSONLine.bool(outcome.response["ok"]), true)
        XCTAssertEqual(transport.endpoints, [BridgeEndpoint(port: 61848)])

        // hello → request：令牌不在任何一行中；场景 ID 与消息只在服务证明之后的 request.payload 中
        XCTAssertEqual(transport.sentLines.count, 2)
        for line in transport.sentLines {
            XCTAssertFalse(String(decoding: line, as: UTF8.self).contains(Fixtures.token))
        }
        XCTAssertEqual(transport.server.verifiedPayloads.count, 1)
        let sent = try XCTUnwrap(transport.server.sentPayload)
        XCTAssertNil(sent["auth"])
        XCTAssertEqual((sent["bridge"] as? [String: Any])?["profileId"] as? String, Fixtures.profileId)
        XCTAssertEqual((sent["bridge"] as? [String: Any])?["bridgeVersion"] as? String, "test")
        XCTAssertEqual((sent["message"] as? [String: Any])?["type"] as? String, "reportProfileState")
        XCTAssertEqual(JSONLine.integer((sent["message"] as? [String: Any])?["windows_open"]), 1)
    }

    func testNothingButTheHelloReachesAListenerThatCannotProveTheToken() throws {
        let transport = FakeTransport(serverToken: String(repeating: "B", count: 42) + "Q")
        transport.reply = .success(Data(#"{"ok":true,"data":{}}"#.utf8))
        let message = jsonObject(#"{"v":1,"message":{"type":"requestLoginFill","top_url":"https://www.amazon.com/ap/signin","frame_is_top":true,"form_action":"https://www.amazon.com/ap/signin","fields":["identifier"],"route_epoch":3}}"#)
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: message))

        XCTAssertEqual(errorCode(outcome.response), "SURGE_UNREACHABLE")
        XCTAssertEqual(errorReason(outcome.response), "auth_failed")
        XCTAssertEqual(outcome.logCode, "SURGE_UNREACHABLE")
        XCTAssertEqual(transport.sentLines.count, 1)
        let hello = String(decoding: try XCTUnwrap(transport.sentLines.first), as: UTF8.self)
        XCTAssertFalse(hello.contains(Fixtures.profileId))
        XCTAssertFalse(hello.contains("requestLoginFill"))
        XCTAssertFalse(hello.contains(Fixtures.token))
        XCTAssertNil(transport.server.sentPayload)
    }

    func testNonceFailureSendsNothing() throws {
        let transport = FakeTransport()
        var forwarder = makeForwarder(transport: transport)
        forwarder.makeNonce = { nil }
        let outcome = try XCTUnwrap(run(forwarder, message: jsonObject(#"{"v":1,"message":{"type":"getCurrentState"}}"#)))
        XCTAssertTrue(transport.sentLines.isEmpty)
        XCTAssertEqual(errorCode(outcome.response), "INTERNAL")
    }

    func testIdentityFieldsInsideTheMessageAreNotTrusted() throws {
        // 扩展自报的 profileId 只留在 message 中原样转发；bridge.profileId 只来自系统
        let transport = FakeTransport()
        transport.reply = .success(Data(#"{"ok":true,"data":{}}"#.utf8))
        let message = jsonObject(#"{"v":1,"profileId":"forged","message":{"type":"getCurrentState"}}"#)
        _ = run(makeForwarder(transport: transport), message: message, profileId: nil)
        let sent = try XCTUnwrap(transport.server.sentPayload)
        XCTAssertTrue((sent["bridge"] as? [String: Any])?["profileId"] is NSNull)
        XCTAssertFalse(serialized(sent["bridge"] ?? NSNull()).contains("forged"))
    }

    func testInvalidEnvelopeNeverReachesTheService() throws {
        let transport = FakeTransport()
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: jsonObject(#"{"v":3,"message":{"type":"getCurrentState"}}"#)))
        XCTAssertTrue(transport.sentLines.isEmpty)
        XCTAssertEqual(outcome.logCode, "BAD_REQUEST")
        XCTAssertEqual(outcome.logType, "unknown")
        XCTAssertEqual(errorCode(outcome.response), "BAD_REQUEST")
    }

    func testMissingBridgeConfigurationIsUnreachable() throws {
        let transport = FakeTransport()
        let forwarder = makeForwarder(transport: transport, credentials: .failure(.notConfigured))
        let outcome = try XCTUnwrap(run(forwarder, message: jsonObject(#"{"v":1,"message":{"type":"getCurrentState"}}"#)))
        XCTAssertTrue(transport.sentLines.isEmpty)
        XCTAssertEqual(errorCode(outcome.response), "SURGE_UNREACHABLE")
        XCTAssertEqual(errorReason(outcome.response), "not_configured")
    }

    func testDeniedContainerAccessIsReportedWithoutSendingAnything() throws {
        let transport = FakeTransport()
        let forwarder = makeForwarder(transport: transport, credentials: .failure(BridgeFileProblem.denied.nativeFailure))
        let outcome = try XCTUnwrap(run(forwarder, message: jsonObject(#"{"v":1,"message":{"type":"getCurrentState"}}"#)))
        XCTAssertTrue(transport.sentLines.isEmpty)
        XCTAssertEqual(errorCode(outcome.response), "SURGE_UNREACHABLE")
        XCTAssertEqual(errorReason(outcome.response), "container_denied")
        XCTAssertEqual(outcome.logCode, "SURGE_UNREACHABLE")
    }

    func testTransportFailuresMapToUnreachable() throws {
        for failure in [BridgeTransportError.connectFailed, .timeout, .closedWithoutResponse, .responseTooLarge, .sendFailed] {
            let transport = FakeTransport()
            transport.reply = .failure(failure)
            let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: jsonObject(#"{"v":1,"message":{"type":"getCurrentState"}}"#)))
            XCTAssertEqual(errorCode(outcome.response), "SURGE_UNREACHABLE")
            XCTAssertTrue(errorMessage(outcome.response)?.hasPrefix("无法连接本机服务") ?? false)
            XCTAssertEqual(outcome.logCode, "SURGE_UNREACHABLE")
        }
    }

    func testMalformedServiceResponseIsUnreachable() throws {
        let transport = FakeTransport()
        transport.reply = .success(Data("HTTP/1.1 400 Bad Request".utf8))
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: jsonObject(#"{"v":1,"message":{"type":"getCurrentState"}}"#)))
        XCTAssertEqual(errorCode(outcome.response), "SURGE_UNREACHABLE")
        XCTAssertEqual(errorReason(outcome.response), "malformed")
    }

    func testServiceErrorCodeIsUsedForLogging() throws {
        let transport = FakeTransport()
        transport.reply = .success(Data(#"{"ok":false,"error":{"code":"PROFILE_UNBOUND","message":"操作失败：场景未关联"}}"#.utf8))
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: jsonObject(#"{"v":1,"message":{"type":"getOperation","operation_id":"op-1"}}"#)))
        XCTAssertEqual(outcome.logCode, "PROFILE_UNBOUND")
        XCTAssertEqual(errorMessage(outcome.response), "操作失败：场景未关联")
    }

    /// 服务从本机后台资料读出账号密码后直接给值（LoginFillResponse，`{ field, value }`）；原生桥原样交给扩展，不读取、不改写。
    private static let loginFillReply = #"{"ok":true,"data":{"fills":[{"field":"identifier","value":"buyer@example.test"},{"field":"password","value":"\#(Fixtures.syntheticSecret)"}]}}"#
    private static let loginFillMessage = #"{"v":1,"message":{"type":"requestLoginFill","top_url":"https://www.amazon.com/ap/signin","frame_is_top":true,"form_action":"https://www.amazon.com/ap/signin","fields":["identifier","password"],"route_epoch":3}}"#

    func testLoginFillResponseIsForwardedUnchanged() throws {
        let transport = FakeTransport()
        transport.reply = .success(Data(Self.loginFillReply.utf8))
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: jsonObject(Self.loginFillMessage)))

        XCTAssertEqual(outcome.logType, "requestLoginFill")
        XCTAssertEqual(outcome.logCode, "ok")
        XCTAssertEqual(serialized(outcome.response), serialized(jsonObject(Self.loginFillReply)))
        let fills = (outcome.response["data"] as? [String: Any])?["fills"] as? [[String: Any]]
        XCTAssertEqual(fills?.count, 2)
        XCTAssertEqual(fills?.last?["field"] as? String, "password")
        XCTAssertEqual(fills?.last?["value"] as? String, Fixtures.syntheticSecret)
        // 发给服务的请求里没有任何秘密
        for line in transport.sentLines {
            XCTAssertFalse(String(decoding: line, as: UTF8.self).contains(Fixtures.syntheticSecret))
        }
    }

    func testLoginFillRefusalFromTheServicePassesThroughUnchanged() throws {
        // 何时允许填充全部由服务判断；拒绝应答（含中文原因）原样交给扩展
        let transport = FakeTransport()
        let refusal = #"{"ok":false,"error":{"code":"FILL_NOT_ALLOWED","message":"填充失败：该环境没有开启登录填充","details":{"reason":"disabled"}}}"#
        transport.reply = .success(Data(refusal.utf8))
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: jsonObject(Self.loginFillMessage)))

        XCTAssertEqual(outcome.logCode, "FILL_NOT_ALLOWED")
        XCTAssertEqual(serialized(outcome.response), serialized(jsonObject(refusal)))
    }

    func testOutcomeLogFieldsNeverContainValues() throws {
        let transport = FakeTransport()
        transport.reply = .success(Data(Self.loginFillReply.utf8))
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: jsonObject(Self.loginFillMessage)))
        for text in [outcome.logType, outcome.logCode] {
            XCTAssertFalse(text.contains(Fixtures.syntheticSecret))
            XCTAssertFalse(text.contains("buyer@example.test"))
            XCTAssertFalse(text.contains(Fixtures.token))
        }
    }
}
