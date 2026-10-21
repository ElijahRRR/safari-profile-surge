import XCTest

final class BridgeConfigTests: XCTestCase {
    func testParsesTCPConfig() {
        XCTAssertEqual(BridgeFiles.parseConfig(Data(#"{"transport":"tcp","port":61848}"#.utf8)), BridgeEndpoint(port: 61848))
    }

    func testRejectsOtherTransportsAndBadPorts() {
        XCTAssertNil(BridgeFiles.parseConfig(Data(#"{"transport":"unix","path":"/tmp/x.sock"}"#.utf8)))
        XCTAssertNil(BridgeFiles.parseConfig(Data(#"{"transport":"tcp","port":0}"#.utf8)))
        XCTAssertNil(BridgeFiles.parseConfig(Data(#"{"transport":"tcp","port":65536}"#.utf8)))
        XCTAssertNil(BridgeFiles.parseConfig(Data(#"{"transport":"tcp","port":"61848"}"#.utf8)))
        XCTAssertNil(BridgeFiles.parseConfig(Data(#"{"transport":"tcp","port":true}"#.utf8)))
        XCTAssertNil(BridgeFiles.parseConfig(Data(#"{"transport":"tcp"}"#.utf8)))
        XCTAssertNil(BridgeFiles.parseConfig(Data("garbage".utf8)))
    }

    func testRejectsOversizedConfig() {
        let padding = String(repeating: " ", count: BridgeFiles.maxConfigBytes)
        XCTAssertNil(BridgeFiles.parseConfig(Data(#"{"transport":"tcp","port":61848}\#(padding)"#.utf8)))
    }

    func testConfigRoundTrip() {
        let data = BridgeFiles.encodeConfig(BridgeEndpoint(port: 61900))
        XCTAssertEqual(BridgeFiles.parseConfig(data), BridgeEndpoint(port: 61900))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "{\"port\":61900,\"transport\":\"tcp\"}\n")
    }

    func testTokenValidation() {
        XCTAssertTrue(BridgeFiles.isValidToken(Fixtures.token))
        XCTAssertTrue(BridgeFiles.isValidToken(String(repeating: "-", count: 21) + String(repeating: "_", count: 22)))
        XCTAssertFalse(BridgeFiles.isValidToken(String(Fixtures.token.dropLast())))
        XCTAssertFalse(BridgeFiles.isValidToken(Fixtures.token + "A"))
        XCTAssertFalse(BridgeFiles.isValidToken(String(repeating: "A", count: 42) + "=")) // 标准 base64 填充
        XCTAssertFalse(BridgeFiles.isValidToken(String(repeating: "A", count: 42) + "+"))
    }

    func testTokenFileMayEndWithOneNewline() {
        XCTAssertEqual(BridgeFiles.parseToken(Data((Fixtures.token + "\n").utf8)), Fixtures.token)
        XCTAssertEqual(BridgeFiles.parseToken(Data(Fixtures.token.utf8)), Fixtures.token)
        XCTAssertNil(BridgeFiles.parseToken(Data((Fixtures.token + "\n\n").utf8)))
        XCTAssertNil(BridgeFiles.parseToken(Data((" " + Fixtures.token).utf8)))
    }

    func testBase64URLOf32BytesIsAValidToken() {
        let bytes = (0..<32).map { UInt8(truncatingIfNeeded: $0 &* 37 &+ 250) }
        let token = BridgeFiles.base64URL(bytes)
        XCTAssertEqual(token.count, 43)
        XCTAssertTrue(BridgeFiles.isValidToken(token))
        XCTAssertFalse(token.contains("+") || token.contains("/") || token.contains("="))
    }

    func testLoadFromContainer() throws {
        let container = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: container) }
        XCTAssertEqual(BridgeFiles.load(from: container).failureValue, .notConfigured)

        try BridgeFiles.encodeConfig(BridgeEndpoint(port: 61849)).write(to: container.appendingPathComponent("bridge.json"))
        XCTAssertEqual(BridgeFiles.load(from: container).failureValue, .notConfigured, "token still missing")

        try Data(Fixtures.token.utf8).write(to: container.appendingPathComponent("bridge.token"))
        let credentials = try BridgeFiles.load(from: container).get()
        XCTAssertEqual(credentials.endpoint, BridgeEndpoint(port: 61849))
        XCTAssertEqual(credentials.token, Fixtures.token)
    }

    func testAppGroupIdentifierRejectsUnexpandedValues() {
        // 测试包的 Info.plist 没有这个键
        XCTAssertNil(BridgeFiles.appGroupIdentifier(bundle: Bundle(for: BridgeConfigTests.self)))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sfe-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        return url
    }
}
