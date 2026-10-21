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

final class BridgeLineTests: XCTestCase {
    func testWrapsMessageWithAuthAndProfile() throws {
        let line = try NativeBridge.bridgeLine(
            message: ["type": "getCurrentState"],
            token: Fixtures.token,
            profileId: Fixtures.profileId,
            bridgeVersion: "0.1.0 (1)"
        ).get()
        let envelope = decodeLine(line)
        XCTAssertEqual(JSONLine.integer(envelope["v"]), 1)
        XCTAssertEqual(envelope["auth"] as? String, Fixtures.token)
        let bridge = envelope["bridge"] as? [String: Any]
        XCTAssertEqual(bridge?["profileId"] as? String, Fixtures.profileId)
        XCTAssertEqual(bridge?["bridgeVersion"] as? String, "0.1.0 (1)")
        XCTAssertEqual((envelope["message"] as? [String: Any])?["type"] as? String, "getCurrentState")
    }

    func testMissingProfileIsExplicitNull() throws {
        let line = try NativeBridge.bridgeLine(message: ["type": "getCurrentState"], token: Fixtures.token, profileId: nil, bridgeVersion: "x").get()
        let bridge = decodeLine(line)["bridge"] as? [String: Any]
        XCTAssertNotNil(bridge?["profileId"])
        XCTAssertTrue(bridge?["profileId"] is NSNull)
    }

    func testMessageStringsWithNewlinesStayOnOneLine() throws {
        let line = try NativeBridge.bridgeLine(message: ["type": "x", "note": "a\nb\r\nc"], token: Fixtures.token, profileId: nil, bridgeVersion: "x").get()
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
        XCTAssertEqual((decodeLine(line)["message"] as? [String: Any])?["note"] as? String, "a\nb\r\nc")
    }

    func testRejectsOversizedMessage() {
        let big = String(repeating: "x", count: NativeBridge.maxMessageBytes)
        let result = NativeBridge.bridgeLine(message: ["type": "reportProfileState", "pad": big], token: Fixtures.token, profileId: nil, bridgeVersion: "x")
        XCTAssertEqual(result.failureValue, .messageTooLarge)
    }

    func testRejectsNonJSONMessage() {
        let result = NativeBridge.bridgeLine(message: ["type": "x", "when": Date()], token: Fixtures.token, profileId: nil, bridgeVersion: "x")
        XCTAssertEqual(result.failureValue, .badEnvelope)
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
        let cases: [BridgeTransportError] = [.connectFailed, .sendFailed, .timeout, .closedWithoutResponse, .responseTooLarge]
        for error in cases {
            let failure = NativeFailure.unreachable(error)
            XCTAssertEqual(failure.code, "SURGE_UNREACHABLE")
            XCTAssertTrue(failure.message.hasPrefix("无法连接本机服务："), failure.message)
            XCTAssertNotNil(failure.reason)
        }
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
