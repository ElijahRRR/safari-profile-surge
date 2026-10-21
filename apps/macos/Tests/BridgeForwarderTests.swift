import XCTest

/// 用假的传输与钥匙串驱动完整的转发流程（不连网络、不读真实钥匙串）。
final class BridgeForwarderTests: XCTestCase {
    private final class FakeTransport {
        var sentLines: [Data] = []
        var endpoints: [BridgeEndpoint] = []
        var reply: Result<Data, BridgeTransportError> = .failure(.connectFailed)

        func send(_ endpoint: BridgeEndpoint, _ line: Data, _ completion: @escaping (Result<Data, BridgeTransportError>) -> Void) {
            endpoints.append(endpoint)
            sentLines.append(line)
            completion(reply)
        }
    }

    private let credentials = BridgeCredentials(endpoint: BridgeEndpoint(port: 61848), token: Fixtures.token)
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeForwarder(
        transport: FakeTransport,
        credentials: Result<BridgeCredentials, NativeFailure>? = nil,
        readPassword: @escaping (String) -> Result<String, KeychainFailureReason> = { _ in .success(Fixtures.syntheticSecret) }
    ) -> BridgeForwarder {
        let loaded = credentials ?? .success(self.credentials)
        let fixedNow = now
        return BridgeForwarder(
            loadCredentials: { loaded },
            transport: { endpoint, line, completion in transport.send(endpoint, line, completion) },
            readPassword: readPassword,
            bridgeVersion: "test",
            now: { fixedNow }
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

        let sent = decodeLine(try XCTUnwrap(transport.sentLines.first))
        XCTAssertEqual(sent["auth"] as? String, Fixtures.token)
        XCTAssertEqual((sent["bridge"] as? [String: Any])?["profileId"] as? String, Fixtures.profileId)
        XCTAssertEqual((sent["message"] as? [String: Any])?["type"] as? String, "reportProfileState")
        XCTAssertEqual(JSONLine.integer((sent["message"] as? [String: Any])?["windows_open"]), 1)
    }

    func testIdentityFieldsInsideTheMessageAreNotTrusted() throws {
        // 扩展自报的 profileId 只留在 message 中原样转发；bridge.profileId 只来自系统
        let transport = FakeTransport()
        transport.reply = .success(Data(#"{"ok":true,"data":{}}"#.utf8))
        let message = jsonObject(#"{"v":1,"profileId":"forged","message":{"type":"getCurrentState"}}"#)
        _ = run(makeForwarder(transport: transport), message: message, profileId: nil)
        let sent = decodeLine(try XCTUnwrap(transport.sentLines.first))
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

    func testLoginFillResolvesPasswordRefs() throws {
        let transport = FakeTransport()
        let expires = ISO8601DateFormatter().string(from: now.addingTimeInterval(30))
        transport.reply = .success(Data(#"{"ok":true,"data":{"fills":[{"field":"identifier","value":"buyer@example.test"},{"field":"password","keychainRef":"\#(Fixtures.accountRef)","expiresAt":"\#(expires)"}]}}"#.utf8))
        var refs: [String] = []
        let forwarder = makeForwarder(transport: transport, readPassword: { ref in
            refs.append(ref)
            return .success(Fixtures.syntheticSecret)
        })
        let message = jsonObject(#"{"v":1,"message":{"type":"requestLoginFill","top_url":"https://www.amazon.com/ap/signin","frame_is_top":true,"form_action":"https://www.amazon.com/ap/signin","fields":["identifier","password"],"route_epoch":3}}"#)
        let outcome = try XCTUnwrap(run(forwarder, message: message))

        XCTAssertEqual(refs, [Fixtures.accountRef])
        XCTAssertEqual(outcome.logCode, "ok")
        let fills = (outcome.response["data"] as? [String: Any])?["fills"] as? [[String: Any]]
        XCTAssertEqual(fills?.count, 2)
        XCTAssertEqual(fills?.last?["value"] as? String, Fixtures.syntheticSecret)
        XCTAssertNil(fills?.last?["keychainRef"])
        // 发给服务的请求里没有任何秘密
        XCTAssertFalse(String(decoding: try XCTUnwrap(transport.sentLines.first), as: UTF8.self).contains(Fixtures.syntheticSecret))
    }

    func testLoginFillKeychainFailureReturnsFillNotAllowed() throws {
        let transport = FakeTransport()
        let expires = ISO8601DateFormatter().string(from: now.addingTimeInterval(30))
        transport.reply = .success(Data(#"{"ok":true,"data":{"fills":[{"field":"password","keychainRef":"\#(Fixtures.accountRef)","expiresAt":"\#(expires)"}]}}"#.utf8))
        let forwarder = makeForwarder(transport: transport, readPassword: { _ in .failure(.locked) })
        let message = jsonObject(#"{"v":1,"message":{"type":"requestLoginFill","top_url":"https://www.amazon.com/ap/signin","frame_is_top":true,"form_action":null,"fields":["password"],"route_epoch":3}}"#)
        let outcome = try XCTUnwrap(run(forwarder, message: message))
        XCTAssertEqual(errorCode(outcome.response), "FILL_NOT_ALLOWED")
        XCTAssertEqual(errorMessage(outcome.response), "无法读取钥匙串中的登录密码：钥匙串已锁定")
        XCTAssertEqual(outcome.logCode, "FILL_NOT_ALLOWED")
    }

    func testKeychainRefsInOtherResponsesAreNotResolved() throws {
        // 只有 requestLoginFill 的应答会被改写；其他类型不读钥匙串
        let transport = FakeTransport()
        transport.reply = .success(Data(#"{"ok":true,"data":{"fills":[{"field":"password","keychainRef":"acct:x","expiresAt":"2030-01-01T00:00:00Z"}]}}"#.utf8))
        let forwarder = makeForwarder(transport: transport, readPassword: { _ in
            XCTFail("keychain must not be read")
            return .failure(.other)
        })
        let outcome = try XCTUnwrap(run(forwarder, message: jsonObject(#"{"v":1,"message":{"type":"getCurrentState"}}"#)))
        XCTAssertEqual(outcome.logCode, "ok")
    }

    func testOutcomeLogFieldsNeverContainValues() throws {
        let transport = FakeTransport()
        let expires = ISO8601DateFormatter().string(from: now.addingTimeInterval(30))
        transport.reply = .success(Data(#"{"ok":true,"data":{"fills":[{"field":"password","keychainRef":"\#(Fixtures.accountRef)","expiresAt":"\#(expires)"}]}}"#.utf8))
        let message = jsonObject(#"{"v":1,"message":{"type":"requestLoginFill","top_url":"https://www.amazon.com/ap/signin","frame_is_top":true,"form_action":null,"fields":["password"],"route_epoch":1}}"#)
        let outcome = try XCTUnwrap(run(makeForwarder(transport: transport), message: message))
        for text in [outcome.logType, outcome.logCode] {
            XCTAssertFalse(text.contains(Fixtures.syntheticSecret))
            XCTAssertFalse(text.contains(Fixtures.accountRef))
            XCTAssertFalse(text.contains(Fixtures.token))
        }
    }
}
