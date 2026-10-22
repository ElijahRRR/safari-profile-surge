import Security
import XCTest

final class KeychainStatusTests: XCTestCase {
    func testDeniedStatuses() {
        XCTAssertEqual(KeychainFailureReason.from(status: errSecAuthFailed), .denied)
        XCTAssertEqual(KeychainFailureReason.from(status: errSecUserCanceled), .denied)
    }

    func testInteractionNotAllowedStatus() {
        // 线路值沿用 "locked"，但 Apple 只定义为「不允许交互」（不一定是钥匙串已锁定）
        XCTAssertEqual(KeychainFailureReason.from(status: errSecInteractionNotAllowed), .locked)
        XCTAssertEqual(KeychainFailureReason.locked.rawValue, "locked")
    }

    func testInteractionNotAllowedTextDoesNotClaimTheKeychainIsLocked() {
        let text = KeychainFailureReason.locked.displayText
        XCTAssertEqual(text, "钥匙串需要用户交互但当前不允许（可能已锁定，或无法显示授权提示）")
        XCTAssertFalse(text.hasPrefix("钥匙串已锁定"))
    }

    func testDisplayTextsAreChineseAndDistinct() {
        let texts = KeychainFailureReason.allCases.map(\.displayText)
        XCTAssertEqual(Set(texts).count, texts.count)
        for text in texts {
            XCTAssertFalse(text.isEmpty)
            XCTAssertTrue(text.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) }, text)
        }
    }

    func testAccessControlStatuses() {
        XCTAssertEqual(KeychainFailureReason.from(status: errSecMissingEntitlement), .acl)
        XCTAssertEqual(KeychainFailureReason.from(status: errSecInvalidOwnerEdit), .acl)
    }

    func testNotFoundStatus() {
        XCTAssertEqual(KeychainFailureReason.from(status: errSecItemNotFound), .notFound)
    }

    func testEverythingElseIsOther() {
        XCTAssertEqual(KeychainFailureReason.from(status: errSecParam), .other)
        XCTAssertEqual(KeychainFailureReason.from(status: errSecDuplicateItem), .other)
        XCTAssertEqual(KeychainFailureReason.from(status: errSecNotAvailable), .other)
        XCTAssertEqual(KeychainFailureReason.from(status: -1), .other)
    }

    func testReasonWireValuesMatchTheService() {
        XCTAssertEqual(KeychainFailureReason.allCases.map(\.rawValue), ["denied", "locked", "acl", "not_found", "other"])
    }

    func testRefValidation() {
        XCTAssertTrue(KeychainRef.isValid("acct:env-0001:r1"))
        XCTAssertTrue(KeychainRef.isValid("sfe.pepper"))
        XCTAssertTrue(KeychainRef.isValid(String(repeating: "a", count: 256)))
        XCTAssertFalse(KeychainRef.isValid(""))
        XCTAssertFalse(KeychainRef.isValid(String(repeating: "a", count: 257)))
        XCTAssertFalse(KeychainRef.isValid("a b"))
        XCTAssertFalse(KeychainRef.isValid("a/b"))
        XCTAssertFalse(KeychainRef.isValid("场景"))
        XCTAssertFalse(KeychainRef.isValid("a\nb"))
    }
}

/// 内存中的钥匙串：只用于测试 sfe-keychain 的策略。
private final class MemoryBackend: KeychainBackend {
    var items: [String: Data] = [:]
    var addedKinds: [KeychainItemKind] = []
    var calls: [String] = []
    var forcedStatus: OSStatus?

    private func key(_ service: String, _ account: String) -> String { "\(service)|\(account)" }

    func add(service: String, account: String, value: Data, kind: KeychainItemKind) -> OSStatus {
        calls.append("add \(service)")
        if let forcedStatus { return forcedStatus }
        if items[key(service, account)] != nil { return errSecDuplicateItem }
        items[key(service, account)] = value
        addedKinds.append(kind)
        return errSecSuccess
    }

    func copy(service: String, account: String) -> (status: OSStatus, data: Data?) {
        calls.append("copy \(service)")
        if let forcedStatus { return (forcedStatus, nil) }
        guard let data = items[key(service, account)] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, data)
    }

    func delete(service: String, account: String) -> OSStatus {
        calls.append("delete \(service)")
        if let forcedStatus { return forcedStatus }
        return items.removeValue(forKey: key(service, account)) == nil ? errSecItemNotFound : errSecSuccess
    }
}

final class KeychainToolTests: XCTestCase {
    private func request(_ json: String) -> KeychainToolRequest? {
        KeychainTool.parse(Data(json.utf8))
    }

    private func run(_ json: String, backend: MemoryBackend, arguments: [String] = ["--stdin-json"]) -> KeychainToolResponse {
        KeychainTool.run(arguments: arguments, readInput: { Data(json.utf8) }, backend: backend)
    }

    // MARK: 解析

    func testParsesSetGetDelete() {
        XCTAssertEqual(
            request(#"{"op":"set","ref":"proxy:r1","kind":"proxy","value":"synthetic-secret-1"}"#),
            KeychainToolRequest(op: .set, ref: "proxy:r1", kind: .proxy, value: Fixtures.syntheticSecret)
        )
        XCTAssertEqual(request(#"{"op":"get","ref":"sfe.pepper","kind":"system"}"#), KeychainToolRequest(op: .get, ref: "sfe.pepper", kind: .system, value: nil))
        XCTAssertEqual(request(#"{"op":"delete","ref":"acct:1","kind":"account"}"#), KeychainToolRequest(op: .delete, ref: "acct:1", kind: .account, value: nil))
    }

    func testRejectsUnknownOpKindOrKeys() {
        XCTAssertNil(request(#"{"op":"update","ref":"r","kind":"proxy","value":"v"}"#))
        XCTAssertNil(request(#"{"op":"get","ref":"r","kind":"login"}"#))
        XCTAssertNil(request(#"{"op":"get","ref":"r","kind":"proxy","extra":1}"#))
        XCTAssertNil(request(#"{"op":"get","kind":"proxy"}"#))
        XCTAssertNil(request("not json"))
        XCTAssertNil(request("[]"))
    }

    func testRejectsInvalidRefs() {
        XCTAssertNil(request(#"{"op":"get","ref":"","kind":"proxy"}"#))
        XCTAssertNil(request(#"{"op":"get","ref":"../x","kind":"proxy"}"#))
        XCTAssertNil(request(#"{"op":"get","ref":"a b","kind":"proxy"}"#))
    }

    func testSetRequiresStringValueWithinLimit() {
        XCTAssertNil(request(#"{"op":"set","ref":"r","kind":"proxy"}"#))
        XCTAssertNil(request(#"{"op":"set","ref":"r","kind":"proxy","value":42}"#))
        XCTAssertNil(request(#"{"op":"set","ref":"r","kind":"proxy","value":null}"#))
        let big = String(repeating: "x", count: KeychainTool.maxValueBytes + 1)
        XCTAssertNil(request(#"{"op":"set","ref":"r","kind":"proxy","value":"\#(big)"}"#))
        XCTAssertNotNil(request(#"{"op":"set","ref":"r","kind":"proxy","value":""}"#))
    }

    func testGetAndDeleteRefuseAValue() {
        XCTAssertNil(request(#"{"op":"get","ref":"r","kind":"proxy","value":"x"}"#))
        XCTAssertNil(request(#"{"op":"delete","ref":"r","kind":"proxy","value":"x"}"#))
    }

    // MARK: 参数

    func testArgvMustBeExactlyStdinJSON() {
        let backend = MemoryBackend()
        let json = #"{"op":"get","ref":"sfe.pepper","kind":"system"}"#
        XCTAssertEqual(run(json, backend: backend, arguments: []), .failure(.other))
        XCTAssertEqual(run(json, backend: backend, arguments: ["--stdin-json", "extra"]), .failure(.other))
        XCTAssertEqual(run(json, backend: backend, arguments: ["--value=synthetic-secret-1"]), .failure(.other))
        XCTAssertTrue(backend.calls.isEmpty)
    }

    func testMissingInputIsOther() {
        let response = KeychainTool.run(arguments: ["--stdin-json"], readInput: { nil }, backend: MemoryBackend())
        XCTAssertEqual(response, .failure(.other))
    }

    // MARK: 执行

    func testSetThenGetProxySecret() {
        let backend = MemoryBackend()
        XCTAssertEqual(run(#"{"op":"set","ref":"proxy:r1","kind":"proxy","value":"synthetic-secret-1"}"#, backend: backend), .ok(value: nil))
        XCTAssertEqual(run(#"{"op":"get","ref":"proxy:r1","kind":"proxy"}"#, backend: backend), .ok(value: Fixtures.syntheticSecret))
        XCTAssertEqual(backend.calls, ["add com.sfe.proxy", "copy com.sfe.proxy"])
    }

    func testKindsUseSeparateServices() {
        XCTAssertEqual(KeychainItemKind.proxy.service, "com.sfe.proxy")
        XCTAssertEqual(KeychainItemKind.account.service, "com.sfe.account")
        XCTAssertEqual(KeychainItemKind.system.service, "com.sfe.system")
        let backend = MemoryBackend()
        _ = run(#"{"op":"set","ref":"same","kind":"proxy","value":"a"}"#, backend: backend)
        XCTAssertEqual(run(#"{"op":"get","ref":"same","kind":"system"}"#, backend: backend), .failure(.notFound))
    }

    func testAccountSecretCanBeWrittenAndDeletedButNeverRead() {
        let backend = MemoryBackend()
        XCTAssertEqual(run(#"{"op":"set","ref":"acct:1","kind":"account","value":"synthetic-secret-1"}"#, backend: backend), .ok(value: nil))
        XCTAssertEqual(backend.addedKinds, [.account])
        let read = run(#"{"op":"get","ref":"acct:1","kind":"account"}"#, backend: backend)
        XCTAssertEqual(read, .failure(.acl))
        XCTAssertFalse(String(decoding: read.line, as: UTF8.self).contains(Fixtures.syntheticSecret))
        XCTAssertFalse(backend.calls.contains("copy com.sfe.account"), "account secrets must not even be looked up")
        XCTAssertEqual(run(#"{"op":"delete","ref":"acct:1","kind":"account"}"#, backend: backend), .ok(value: nil))
    }

    func testSetNeverOverwritesAnExistingRef() {
        let backend = MemoryBackend()
        _ = run(#"{"op":"set","ref":"proxy:r1","kind":"proxy","value":"first"}"#, backend: backend)
        XCTAssertEqual(run(#"{"op":"set","ref":"proxy:r1","kind":"proxy","value":"second"}"#, backend: backend), .failure(.other))
        XCTAssertEqual(backend.items["com.sfe.proxy|proxy:r1"], Data("first".utf8))
    }

    func testDeleteMissingIsNotFound() {
        XCTAssertEqual(run(#"{"op":"delete","ref":"nope","kind":"proxy"}"#, backend: MemoryBackend()), .failure(.notFound))
    }

    func testBackendStatusesAreMapped() {
        let cases: [(OSStatus, KeychainFailureReason)] = [
            (errSecUserCanceled, .denied),
            (errSecAuthFailed, .denied),
            (errSecInteractionNotAllowed, .locked),
            (errSecInvalidOwnerEdit, .acl),
            (errSecMissingEntitlement, .acl),
            (errSecItemNotFound, .notFound),
            (errSecParam, .other),
        ]
        for (status, reason) in cases {
            let backend = MemoryBackend()
            backend.forcedStatus = status
            XCTAssertEqual(run(#"{"op":"set","ref":"r","kind":"account","value":"v"}"#, backend: backend), .failure(reason))
            XCTAssertEqual(run(#"{"op":"get","ref":"r","kind":"proxy"}"#, backend: backend), .failure(reason))
            XCTAssertEqual(run(#"{"op":"delete","ref":"r","kind":"system"}"#, backend: backend), .failure(reason))
        }
    }

    func testNonUTF8StoredValueIsOther() {
        let backend = MemoryBackend()
        backend.items["com.sfe.proxy|r"] = Data([0xFF, 0xFE])
        XCTAssertEqual(run(#"{"op":"get","ref":"r","kind":"proxy"}"#, backend: backend), .failure(.other))
    }

    // MARK: 输出

    func testResponseLinesMatchTheServiceContract() {
        XCTAssertEqual(String(decoding: KeychainToolResponse.ok(value: nil).line, as: UTF8.self), "{\"ok\":true}\n")
        XCTAssertEqual(String(decoding: KeychainToolResponse.ok(value: "v").line, as: UTF8.self), "{\"ok\":true,\"value\":\"v\"}\n")
        for reason in KeychainFailureReason.allCases {
            let object = decodeLine(KeychainToolResponse.failure(reason).line)
            XCTAssertEqual(JSONLine.bool(object["ok"]), false)
            XCTAssertEqual(object["reason"] as? String, reason.rawValue)
            XCTAssertEqual(object.count, 2)
        }
    }

    func testWriteAndDeleteResponsesNeverEchoTheValue() {
        let backend = MemoryBackend()
        let set = run(#"{"op":"set","ref":"proxy:r1","kind":"proxy","value":"synthetic-secret-1"}"#, backend: backend)
        XCTAssertFalse(String(decoding: set.line, as: UTF8.self).contains(Fixtures.syntheticSecret))
        let delete = run(#"{"op":"delete","ref":"proxy:r1","kind":"proxy"}"#, backend: backend)
        XCTAssertFalse(String(decoding: delete.line, as: UTF8.self).contains(Fixtures.syntheticSecret))
    }
}

final class BundleLayoutTests: XCTestCase {
    private let helper = URL(fileURLWithPath: "/Applications/SafariProfileSurge.app/Contents/Helpers/sfe-keychain")

    func testExtensionBundleIsResolvedRelativeToTheHelper() {
        XCTAssertEqual(
            BundleLayout.extensionBundle(forHelperExecutable: helper)?.path,
            "/Applications/SafariProfileSurge.app/Contents/PlugIns/SafariProfileSurgeExtension.appex"
        )
    }

    func testServiceCommandUsesAbsolutePaths() {
        let command = BundleLayout.serviceCommand(forHelperExecutable: helper.deletingLastPathComponent().appendingPathComponent("sfe-service-launcher"))
        XCTAssertEqual(command?.node.path, "/Applications/SafariProfileSurge.app/Contents/Helpers/node")
        XCTAssertEqual(command?.script.path, "/Applications/SafariProfileSurge.app/Contents/Resources/service/service.mjs")
    }

    func testBundledNodeIsCodeInHelpersNotAResource() throws {
        // Apple「Placing content in a bundle」：辅助工具放在 Contents/MacOS 或 Contents/Helpers，Resources 只放非代码
        let command = try XCTUnwrap(BundleLayout.serviceCommand(forHelperExecutable: helper.deletingLastPathComponent().appendingPathComponent("sfe-service-launcher")))
        XCTAssertEqual(command.node.deletingLastPathComponent().path, helper.deletingLastPathComponent().path)
        XCTAssertFalse(command.node.pathComponents.contains("Resources"))
    }

    func testHelperOutsideTheAppBundleIsRejected() {
        XCTAssertNil(BundleLayout.contentsDirectory(forHelperExecutable: URL(fileURLWithPath: "/usr/local/bin/sfe-keychain")))
        XCTAssertNil(BundleLayout.extensionBundle(forHelperExecutable: URL(fileURLWithPath: "/tmp/Helpers/sfe-keychain")))
        XCTAssertNil(BundleLayout.serviceCommand(forHelperExecutable: URL(fileURLWithPath: "/tmp/Contents/MacOS/sfe-service-launcher")))
    }
}
