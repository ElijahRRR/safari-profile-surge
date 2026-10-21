import XCTest

final class EnvelopeValidationTests: XCTestCase {
    private func validate(_ text: String) -> Result<NativeBridge.ValidatedEnvelope, NativeFailure> {
        NativeBridge.validateEnvelope(jsonObject(text))
    }

    func testAcceptsMinimalEnvelope() throws {
        let envelope = try validate(#"{"v":1,"message":{"type":"getCurrentState"}}"#).get()
        XCTAssertEqual(envelope.type, "getCurrentState")
        XCTAssertEqual(envelope.message.count, 1)
    }

    func testKeepsMessageFieldsUntouched() throws {
        let envelope = try validate(#"{"v":1,"message":{"type":"getOperation","operation_id":"op-1"}}"#).get()
        XCTAssertEqual(envelope.message["operation_id"] as? String, "op-1")
    }

    func testRejectsNonObjectRoot() {
        XCTAssertEqual(NativeBridge.validateEnvelope(jsonObject(#"["v",1]"#)).failureValue, .badEnvelope)
        XCTAssertEqual(NativeBridge.validateEnvelope(nil).failureValue, .badEnvelope)
        XCTAssertEqual(NativeBridge.validateEnvelope("text").failureValue, .badEnvelope)
    }

    func testRejectsMissingOrWrongVersion() {
        XCTAssertEqual(validate(#"{"message":{"type":"getCurrentState"}}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":2,"message":{"type":"getCurrentState"}}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":"1","message":{"type":"getCurrentState"}}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":1.5,"message":{"type":"getCurrentState"}}"#).failureValue, .badEnvelope)
    }

    func testRejectsBooleanTrueAsVersion() {
        // Foundation 中 true 也是 NSNumber(1)，必须按类型区分
        XCTAssertEqual(validate(#"{"v":true,"message":{"type":"getCurrentState"}}"#).failureValue, .badEnvelope)
    }

    func testRejectsMissingMessageOrType() {
        XCTAssertEqual(validate(#"{"v":1}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":1,"message":"getCurrentState"}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":1,"message":{}}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":1,"message":{"type":42}}"#).failureValue, .badEnvelope)
    }

    func testRejectsMalformedTypeNames() {
        XCTAssertEqual(validate(#"{"v":1,"message":{"type":""}}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":1,"message":{"type":"get current"}}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":1,"message":{"type":"1abc"}}"#).failureValue, .badEnvelope)
        XCTAssertEqual(validate(#"{"v":1,"message":{"type":"get\nState"}}"#).failureValue, .badEnvelope)
        let long = String(repeating: "a", count: 65)
        XCTAssertEqual(validate(#"{"v":1,"message":{"type":"\#(long)"}}"#).failureValue, .badEnvelope)
    }

    func testUnknownButWellFormedTypeIsForwardedButLoggedAsUnknown() throws {
        let envelope = try validate(#"{"v":1,"message":{"type":"somethingNew"}}"#).get()
        XCTAssertEqual(envelope.type, "somethingNew")
        XCTAssertEqual(NativeBridge.logName(forType: envelope.type), "unknown")
        XCTAssertEqual(NativeBridge.logName(forType: "requestLoginFill"), "requestLoginFill")
    }

    func testBadEnvelopeResponseShape() {
        let response = NativeFailure.badEnvelope.responseObject
        XCTAssertEqual(JSONLine.bool(response["ok"]), false)
        XCTAssertEqual(errorCode(response), "BAD_REQUEST")
        XCTAssertEqual(errorMessage(response), "处理请求失败：消息格式不正确")
    }
}

final class BridgePayloadTests: XCTestCase {
    private func decode(_ text: String) -> [String: Any] {
        JSONLine.decodeObject(Data(text.utf8)) ?? [:]
    }

    func testWrapsMessageWithProfileAndVersionButNoToken() throws {
        let text = try NativeBridge.bridgePayload(
            message: ["type": "getCurrentState"],
            profileId: Fixtures.profileId,
            bridgeVersion: "0.1.0+1"
        ).get()
        let payload = decode(text)
        XCTAssertEqual(Set(payload.keys), ["bridge", "message"])
        let bridge = payload["bridge"] as? [String: Any]
        XCTAssertEqual(bridge?["profileId"] as? String, Fixtures.profileId)
        XCTAssertEqual(bridge?["bridgeVersion"] as? String, "0.1.0+1")
        XCTAssertEqual((payload["message"] as? [String: Any])?["type"] as? String, "getCurrentState")
        // 令牌从不进入 payload（也不进入任何线路消息，见 BridgeHandshakeTests）
        XCTAssertNil(payload["auth"])
        XCTAssertFalse(text.contains(Fixtures.token))
    }

    func testMissingProfileIsExplicitNull() throws {
        let text = try NativeBridge.bridgePayload(message: ["type": "getCurrentState"], profileId: nil, bridgeVersion: "x").get()
        let bridge = decode(text)["bridge"] as? [String: Any]
        XCTAssertNotNil(bridge?["profileId"])
        XCTAssertTrue(bridge?["profileId"] is NSNull)
    }

    func testMessageStringsWithNewlinesStayOnOneLine() throws {
        let text = try NativeBridge.bridgePayload(message: ["type": "x", "note": "a\nb\r\nc"], profileId: nil, bridgeVersion: "x").get()
        XCTAssertFalse(text.contains("\n"))
        XCTAssertEqual((decode(text)["message"] as? [String: Any])?["note"] as? String, "a\nb\r\nc")
        let line = try XCTUnwrap(BridgeHandshake.encodeRequest(clientProof: HandshakeVector.clientProof, payload: text))
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
    }

    func testRejectsOversizedMessage() {
        let big = String(repeating: "x", count: NativeBridge.maxMessageBytes)
        let result = NativeBridge.bridgePayload(message: ["type": "reportProfileState", "pad": big], profileId: nil, bridgeVersion: "x")
        XCTAssertEqual(result.failureValue, .messageTooLarge)
    }

    func testSizeLimitAppliesToTheFinalRequestLine() throws {
        // 引号在 request 行中会被转义：payload 本身不到上限，但整行超过时也要拒绝
        let quotes = String(repeating: "\"", count: NativeBridge.maxMessageBytes / 3)
        let result = NativeBridge.bridgePayload(message: ["type": "reportProfileState", "pad": quotes], profileId: nil, bridgeVersion: "x")
        XCTAssertEqual(result.failureValue, .messageTooLarge)
    }

    func testRejectsNonJSONMessage() {
        let result = NativeBridge.bridgePayload(message: ["type": "x", "when": Date()], profileId: nil, bridgeVersion: "x")
        XCTAssertEqual(result.failureValue, .badEnvelope)
    }
}

/// bridgeVersion 必须能通过服务的 BRIDGE_VERSION_RE（/^[\x21-\x7e]{1,64}$/，不含空格）；
/// 旧格式 "0.1.0 (1)" 含空格，服务拒绝了扩展的每一个请求。
final class BridgeVersionTests: XCTestCase {
    /// 与 service/src/ipc/bridge-server.ts 的 BRIDGE_VERSION_RE 相同的判断。
    private func serviceAccepts(_ version: String) -> Bool {
        let bytes = Array(version.utf8)
        return (1...64).contains(bytes.count) && bytes.allSatisfy { (UInt8(0x21)...UInt8(0x7E)).contains($0) }
    }

    func testFormatIsShortVersionPlusBuild() {
        let version = NativeBridge.bridgeVersion(infoDictionary: ["CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1"])
        XCTAssertEqual(version, "0.1.0+1")
        XCTAssertTrue(serviceAccepts(version))
    }

    func testMissingValuesFallBackToZero() {
        XCTAssertEqual(NativeBridge.bridgeVersion(infoDictionary: nil), "0+0")
        XCTAssertEqual(NativeBridge.bridgeVersion(infoDictionary: ["CFBundleShortVersionString": 1]), "0+0")
        XCTAssertEqual(NativeBridge.bridgeVersion(infoDictionary: ["CFBundleShortVersionString": "", "CFBundleVersion": "  "]), "0+0")
    }

    func testNeverContainsSpacesOrNonASCIIAndStaysWithinTheLimit() {
        let cases: [[String: Any]] = [
            ["CFBundleShortVersionString": "0.1.0 beta", "CFBundleVersion": "1 (2)"],
            ["CFBundleShortVersionString": "1.0\t", "CFBundleVersion": "版本 3"],
            ["CFBundleShortVersionString": String(repeating: "9", count: 100), "CFBundleVersion": String(repeating: "8", count: 100)],
        ]
        for info in cases {
            let version = NativeBridge.bridgeVersion(infoDictionary: info)
            XCTAssertFalse(version.contains(" "), version)
            XCTAssertTrue(serviceAccepts(version), version)
        }
        XCTAssertEqual(NativeBridge.bridgeVersion(infoDictionary: cases[0]), "0.1.0beta+1(2)")
    }

    func testTheOldFormatWouldHaveBeenRejected() {
        XCTAssertFalse(serviceAccepts("0.1.0 (1)"))
    }
}

final class ProfileIdentifierTests: XCTestCase {
    func testUUIDIsLowercased() {
        XCTAssertEqual(NativeBridge.profileIdentifier(from: Fixtures.profileUUID), Fixtures.profileId)
    }

    func testNSUUIDBridges() {
        XCTAssertEqual(NativeBridge.profileIdentifier(from: Fixtures.profileUUID as NSUUID), Fixtures.profileId)
    }

    func testUUIDStringIsNormalized() {
        XCTAssertEqual(NativeBridge.profileIdentifier(from: Fixtures.profileUUID.uuidString), Fixtures.profileId)
    }

    func testMissingOrInvalidIsNil() {
        XCTAssertNil(NativeBridge.profileIdentifier(from: nil))
        XCTAssertNil(NativeBridge.profileIdentifier(from: "not-a-uuid"))
        XCTAssertNil(NativeBridge.profileIdentifier(from: 42))
    }
}

final class ResponseParsingTests: XCTestCase {
    private func parse(_ text: String) -> Result<[String: Any], NativeFailure> {
        NativeBridge.parseResponse(Data(text.utf8))
    }

    func testAcceptsSuccess() throws {
        let response = try parse(#"{"ok":true,"data":{"recorded":true}}"#).get()
        XCTAssertEqual(NativeBridge.outcomeCode(of: response), "ok")
    }

    func testAcceptsSuccessWithNullData() throws {
        _ = try parse(#"{"ok":true,"data":null}"#).get()
    }

    func testPassesServiceErrorsThrough() throws {
        let response = try parse(#"{"ok":false,"error":{"code":"BINDING_MISMATCH","message":"绑定检查失败：场景不匹配"}}"#).get()
        XCTAssertEqual(errorCode(response), "BINDING_MISMATCH")
        XCTAssertEqual(errorMessage(response), "绑定检查失败：场景不匹配")
        XCTAssertEqual(NativeBridge.outcomeCode(of: response), "BINDING_MISMATCH")
    }

    func testRejectsMalformedResponses() {
        XCTAssertEqual(parse("not json").failureValue, .malformedResponse)
        XCTAssertEqual(parse("[]").failureValue, .malformedResponse)
        XCTAssertEqual(parse(#"{"data":{}}"#).failureValue, .malformedResponse)
        XCTAssertEqual(parse(#"{"ok":1,"data":{}}"#).failureValue, .malformedResponse)
        XCTAssertEqual(parse(#"{"ok":true}"#).failureValue, .malformedResponse)
        XCTAssertEqual(parse(#"{"ok":false}"#).failureValue, .malformedResponse)
        XCTAssertEqual(parse(#"{"ok":false,"error":{"code":"bad code","message":"x"}}"#).failureValue, .malformedResponse)
        XCTAssertEqual(parse(#"{"ok":false,"error":{"code":"INTERNAL"}}"#).failureValue, .malformedResponse)
    }

    func testUnreachableMessagesAreChineseAndCoded() {
        let cases: [BridgeTransportError] = [.connectFailed, .sendFailed, .timeout, .closedWithoutResponse, .responseTooLarge, .handshakeFailed]
        for error in cases {
            let failure = NativeFailure.unreachable(error)
            XCTAssertEqual(failure.code, "SURGE_UNREACHABLE")
            XCTAssertTrue(failure.message.hasPrefix("无法连接本机服务："), failure.message)
            XCTAssertNotNil(failure.reason)
        }
    }

    func testHandshakeFailureSaysAuthenticationFailedWithoutDetails() {
        let failure = NativeFailure.unreachable(.handshakeFailed)
        XCTAssertEqual(failure.reason, "auth_failed")
        XCTAssertTrue(failure.message.contains("认证失败"))
        XCTAssertFalse(failure.message.contains(Fixtures.token))
    }

    func testNotConfiguredIsUnreachable() {
        XCTAssertEqual(NativeFailure.notConfigured.code, "SURGE_UNREACHABLE")
        XCTAssertTrue(NativeFailure.notConfigured.message.hasPrefix("无法连接本机服务"))
    }
}

extension Result {
    var failureValue: Failure? {
        if case .failure(let failure) = self { return failure }
        return nil
    }
}
