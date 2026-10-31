import Foundation
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
        XCTAssertEqual(BridgeFiles.loadCredentials(bundle: Bundle(for: BridgeConfigTests.self)).failureValue, .noAppGroup)
        XCTAssertEqual(BridgeFiles.load(bundle: Bundle(for: BridgeConfigTests.self)).failureValue, .notConfigured)
    }

    // MARK: 没有权限与找不到配置分开报告（macOS 15 起扩展被拒绝时系统不提示）

    func testErrnoClassification() {
        XCTAssertEqual(BridgeFileProblem.from(errno: ENOENT), .missing)
        XCTAssertEqual(BridgeFileProblem.from(errno: EACCES), .denied)
        XCTAssertEqual(BridgeFileProblem.from(errno: EPERM), .denied)
        XCTAssertEqual(BridgeFileProblem.from(errno: ENOTDIR), .invalid)
        XCTAssertEqual(BridgeFileProblem.from(errno: ELOOP), .invalid)
        XCTAssertEqual(BridgeFileProblem.from(errno: EIO), .failed(errno: EIO))
    }

    func testMissingContainerIsNotConfiguredNotDenied() throws {
        let parent = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: parent) }
        let container = parent.appendingPathComponent("missing", isDirectory: true)
        XCTAssertEqual(BridgeFiles.loadCredentials(from: container).failureValue, .missing)
        XCTAssertEqual(BridgeFiles.load(from: container).failureValue, .notConfigured)
        XCTAssertEqual(BridgeFiles.checkDirectoryAccess(container), .missing)
    }

    func testUnreadableConfigIsReportedAsDenied() throws {
        try XCTSkipIf(geteuid() == 0, "root 不受文件权限限制")
        let container = try writtenContainer()
        let config = container.appendingPathComponent("bridge.json")
        XCTAssertEqual(chmod(config.path, 0), 0)
        defer {
            chmod(config.path, 0o600)
            try? FileManager.default.removeItem(at: container)
        }
        XCTAssertEqual(BridgeFiles.loadCredentials(from: container).failureValue, .denied)
        let failure = try XCTUnwrap(BridgeFiles.load(from: container).failureValue)
        XCTAssertEqual(failure, .containerDenied)
        XCTAssertEqual(failure.reason, "container_denied")
        XCTAssertNotEqual(failure, .notConfigured)
    }

    func testUnreadableTokenIsReportedAsDenied() throws {
        try XCTSkipIf(geteuid() == 0, "root 不受文件权限限制")
        let container = try writtenContainer()
        let token = container.appendingPathComponent("bridge.token")
        XCTAssertEqual(chmod(token.path, 0), 0)
        defer {
            chmod(token.path, 0o600)
            try? FileManager.default.removeItem(at: container)
        }
        XCTAssertEqual(BridgeFiles.loadCredentials(from: container).failureValue, .denied)
    }

    func testInaccessibleContainerDirectoryIsDenied() throws {
        try XCTSkipIf(geteuid() == 0, "root 不受文件权限限制")
        let container = try writtenContainer()
        XCTAssertEqual(chmod(container.path, 0), 0)
        defer {
            chmod(container.path, 0o700)
            try? FileManager.default.removeItem(at: container)
        }
        XCTAssertEqual(BridgeFiles.checkDirectoryAccess(container), .denied)
        XCTAssertEqual(BridgeFiles.loadCredentials(from: container).failureValue, .denied)
        XCTAssertEqual(BridgeFiles.load(from: container).failureValue, .containerDenied)
    }

    func testDirectoryAccessCheck() throws {
        let container = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: container) }
        XCTAssertNil(BridgeFiles.checkDirectoryAccess(container))
        let file = container.appendingPathComponent("plain")
        try Data("x".utf8).write(to: file)
        XCTAssertEqual(BridgeFiles.checkDirectoryAccess(file), .invalid)
    }

    func testSymlinkedOrOversizedFilesAreInvalid() throws {
        let container = try writtenContainer()
        defer { try? FileManager.default.removeItem(at: container) }
        XCTAssertNotNil(try? BridgeFiles.loadCredentials(from: container).get())

        let elsewhere = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: elsewhere) }
        let target = elsewhere.appendingPathComponent("bridge.json")
        try BridgeFiles.encodeConfig(BridgeEndpoint(port: 61849)).write(to: target)
        let config = container.appendingPathComponent("bridge.json")
        try FileManager.default.removeItem(at: config)
        try FileManager.default.createSymbolicLink(at: config, withDestinationURL: target)
        XCTAssertEqual(BridgeFiles.loadCredentials(from: container).failureValue, .invalid)
        XCTAssertEqual(BridgeFiles.load(from: container).failureValue, .notConfigured)

        try FileManager.default.removeItem(at: config)
        try Data(repeating: 0x20, count: BridgeFiles.maxConfigBytes + 1).write(to: config)
        XCTAssertEqual(BridgeFiles.readFile(config, maxBytes: BridgeFiles.maxConfigBytes).failureValue, .invalid)
        XCTAssertEqual(BridgeFiles.loadCredentials(from: container).failureValue, .invalid)
    }

    func testReadFileReturnsTheExactBytes() throws {
        let container = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: container) }
        let file = container.appendingPathComponent("empty")
        try Data().write(to: file)
        XCTAssertEqual(try BridgeFiles.readFile(file, maxBytes: 16).get(), Data())
        try Data("0123456789".utf8).write(to: file)
        XCTAssertEqual(try BridgeFiles.readFile(file, maxBytes: 10).get(), Data("0123456789".utf8))
        XCTAssertEqual(BridgeFiles.readFile(file, maxBytes: 9).failureValue, .invalid)
    }

    func testProblemsMapToDistinctNativeFailures() {
        XCTAssertEqual(BridgeFileProblem.noAppGroup.nativeFailure, .notConfigured)
        XCTAssertEqual(BridgeFileProblem.missing.nativeFailure, .notConfigured)
        XCTAssertEqual(BridgeFileProblem.invalid.nativeFailure, .notConfigured)
        XCTAssertEqual(BridgeFileProblem.denied.nativeFailure, .containerDenied)
        let other = BridgeFileProblem.failed(errno: EIO).nativeFailure
        XCTAssertEqual(other.code, "SURGE_UNREACHABLE")
        XCTAssertEqual(other.reason, "config_unreadable")
        XCTAssertTrue(other.message.hasPrefix("无法连接本机服务："), other.message)
        XCTAssertTrue(other.message.contains("errno \(EIO)"), other.message)
    }

    func testHostAndSetupTextsSeparateDeniedFromMissing() {
        let problems: [BridgeFileProblem] = [.noAppGroup, .missing, .denied, .invalid, .failed(errno: EIO)]
        for problem in problems {
            XCTAssertTrue(problem.hostProblemText.hasPrefix("原生桥无法连接："), problem.hostProblemText)
            XCTAssertTrue(problem.hostStatusLine.hasPrefix("原生桥："), problem.hostStatusLine)
            XCTAssertTrue(problem.setupText.hasPrefix("准备原生桥失败："), problem.setupText)
            let mentionsDenial = problem.hostProblemText.contains("拒绝") || problem.setupText.contains("拒绝")
                || problem.hostStatusLine.contains("拒绝")
            XCTAssertEqual(mentionsDenial, problem == .denied, "\(problem)")
        }
        XCTAssertEqual(Set(problems.map(\.hostProblemText)).count, problems.count)
        XCTAssertEqual(Set(problems.map(\.setupText)).count, problems.count)
        XCTAssertFalse(BridgeFileProblem.denied.hostProblemText.contains("找不到"))
        XCTAssertFalse(BridgeFileProblem.denied.setupText.contains("不存在"))
    }

    /// 写好 bridge.json 与 bridge.token 的临时容器。
    private func writtenContainer() throws -> URL {
        let container = try temporaryDirectory()
        try BridgeFiles.encodeConfig(BridgeEndpoint(port: 61849)).write(to: container.appendingPathComponent("bridge.json"))
        try Data(Fixtures.token.utf8).write(to: container.appendingPathComponent("bridge.token"))
        return container
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sfe-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        return url
    }
}
