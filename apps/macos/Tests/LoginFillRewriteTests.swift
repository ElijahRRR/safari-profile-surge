import XCTest

final class LoginFillRewriteTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var future: String { ISO8601DateFormatter().string(from: now.addingTimeInterval(60)) }
    private var past: String { ISO8601DateFormatter().string(from: now.addingTimeInterval(-1)) }

    private func serviceResponse(_ fills: [[String: Any]]) -> [String: Any] {
        ["ok": true, "data": ["fills": fills] as [String: Any]]
    }

    private func rewrite(
        _ response: [String: Any],
        read: (String) -> Result<String, KeychainFailureReason> = { _ in .success(Fixtures.syntheticSecret) }
    ) -> Result<[String: Any], NativeFailure> {
        NativeBridge.rewriteLoginFill(response, now: now, readPassword: read)
    }

    private func fills(_ response: [String: Any]) -> [[String: String]] {
        let list = (response["data"] as? [String: Any])?["fills"] as? [[String: Any]] ?? []
        return list.map { entry in entry.compactMapValues { $0 as? String } }
    }

    func testIdentifierPassesThrough() throws {
        let result = try rewrite(serviceResponse([["field": "identifier", "value": "buyer@example.test"]])).get()
        XCTAssertEqual(fills(result), [["field": "identifier", "value": "buyer@example.test"]])
    }

    func testPasswordRefIsResolvedAndReplaced() throws {
        var requested: [String] = []
        let result = try rewrite(
            serviceResponse([
                ["field": "identifier", "value": "buyer@example.test"],
                ["field": "password", "keychainRef": Fixtures.accountRef, "expiresAt": future],
            ]),
            read: { ref in
                requested.append(ref)
                return .success(Fixtures.syntheticSecret)
            }
        ).get()
        XCTAssertEqual(requested, [Fixtures.accountRef])
        XCTAssertEqual(fills(result), [
            ["field": "identifier", "value": "buyer@example.test"],
            ["field": "password", "value": Fixtures.syntheticSecret],
        ])
        // 交给扩展的应答只含 { field, value }，不再带引用或过期时间
        XCTAssertFalse(serialized(result).contains(Fixtures.accountRef))
        XCTAssertFalse(serialized(result).contains("expiresAt"))
    }

    func testAcceptsFractionalSecondTimestamps() throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expires = formatter.string(from: now.addingTimeInterval(30))
        let result = try rewrite(serviceResponse([["field": "password", "keychainRef": Fixtures.accountRef, "expiresAt": expires]])).get()
        XCTAssertEqual(fills(result).first?["value"], Fixtures.syntheticSecret)
    }

    func testKeychainFailureBecomesFillNotAllowed() {
        for reason in KeychainFailureReason.allCases {
            let result = rewrite(
                serviceResponse([["field": "password", "keychainRef": Fixtures.accountRef, "expiresAt": future]]),
                read: { _ in .failure(reason) }
            )
            guard case .failure(let failure) = result else { return XCTFail("expected failure for \(reason)") }
            XCTAssertEqual(failure.code, "FILL_NOT_ALLOWED")
            XCTAssertTrue(failure.message.hasPrefix("无法读取钥匙串中的登录密码"), failure.message)
            XCTAssertEqual(failure.reason, reason.rawValue)
        }
    }

    func testFailureNeverReturnsPartialFills() {
        let result = rewrite(
            serviceResponse([
                ["field": "identifier", "value": "buyer@example.test"],
                ["field": "password", "keychainRef": Fixtures.accountRef, "expiresAt": future],
            ]),
            read: { _ in .failure(.denied) }
        )
        guard case .failure(let failure) = result else { return XCTFail("expected failure") }
        XCTAssertFalse(serialized(failure.responseObject).contains("buyer@example.test"))
    }

    func testExpiredRefIsRejectedWithoutReadingKeychain() {
        var called = false
        let result = rewrite(
            serviceResponse([["field": "password", "keychainRef": Fixtures.accountRef, "expiresAt": past]]),
            read: { _ in
                called = true
                return .success(Fixtures.syntheticSecret)
            }
        )
        XCTAssertEqual(result.failureValue, .fillRefExpired)
        XCTAssertFalse(called)
    }

    func testPlainPasswordFromServiceIsRejected() {
        let result = rewrite(serviceResponse([["field": "password", "value": Fixtures.syntheticSecret]]))
        XCTAssertEqual(result.failureValue, .malformedFill)
    }

    func testPasswordWithBothValueAndRefIsRejected() {
        let result = rewrite(serviceResponse([
            ["field": "password", "value": Fixtures.syntheticSecret, "keychainRef": Fixtures.accountRef, "expiresAt": future],
        ]))
        XCTAssertEqual(result.failureValue, .malformedFill)
    }

    func testInvalidRefIsRejectedWithoutReadingKeychain() {
        var called = false
        let result = rewrite(
            serviceResponse([["field": "password", "keychainRef": "bad ref/..", "expiresAt": future]]),
            read: { _ in
                called = true
                return .success(Fixtures.syntheticSecret)
            }
        )
        XCTAssertEqual(result.failureValue, .malformedFill)
        XCTAssertFalse(called)
    }

    func testMissingOrUnparseableExpiryIsRejected() {
        XCTAssertEqual(rewrite(serviceResponse([["field": "password", "keychainRef": Fixtures.accountRef]])).failureValue, .malformedFill)
        XCTAssertEqual(
            rewrite(serviceResponse([["field": "password", "keychainRef": Fixtures.accountRef, "expiresAt": "tomorrow"]])).failureValue,
            .malformedFill
        )
    }

    func testUnknownOrDuplicateFieldsAreRejected() {
        XCTAssertEqual(rewrite(serviceResponse([["field": "otp", "value": "000000"]])).failureValue, .malformedFill)
        XCTAssertEqual(
            rewrite(serviceResponse([
                ["field": "identifier", "value": "a@example.test"],
                ["field": "identifier", "value": "b@example.test"],
            ])).failureValue,
            .malformedFill
        )
    }

    func testMalformedDataIsRejected() {
        XCTAssertEqual(rewrite(["ok": true, "data": NSNull()]).failureValue, .malformedFill)
        XCTAssertEqual(rewrite(["ok": true, "data": ["fills": "x"] as [String: Any]]).failureValue, .malformedFill)
        XCTAssertEqual(rewrite(serviceResponse([["value": "x"]])).failureValue, .malformedFill)
    }

    func testServiceErrorPassesThroughUnchanged() throws {
        let response = jsonDictionary(#"{"ok":false,"error":{"code":"FILL_NOT_ALLOWED","message":"填充失败：路由未受控"}}"#)
        let result = try rewrite(response, read: { _ in
            XCTFail("keychain must not be read")
            return .failure(.other)
        }).get()
        XCTAssertEqual(errorMessage(result), "填充失败：路由未受控")
    }

    func testFailureMessagesNeverContainTheSecret() {
        let failures: [NativeFailure] = KeychainFailureReason.allCases.map(NativeFailure.keychainRead) + [.malformedFill, .fillRefExpired]
        for failure in failures {
            XCTAssertFalse(serialized(failure.responseObject).contains(Fixtures.syntheticSecret))
            XCTAssertFalse(serialized(failure.responseObject).contains(Fixtures.accountRef))
        }
    }
}
