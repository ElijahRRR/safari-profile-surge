import XCTest

final class InstallConfigTests: XCTestCase {
    private let fields = InstallConfig.Fields(
        surgeCliPath: "/Applications/Surge.app/Contents/Applications/surge-cli",
        keychainHelperPath: "/Applications/SafariProfileSurge.app/Contents/Helpers/sfe-keychain",
        nodeVersionPin: "22.13.1",
        bridgePort: 61848,
        webRoot: "/Applications/SafariProfileSurge.app/Contents/Resources/service/web"
    )

    func testFreshConfigHasAllPrimitivesUnavailable() {
        let config = InstallConfig.merged(existing: nil, fields: fields)
        let mechanisms = config["adapterMechanism"] as? [String: String]
        XCTAssertEqual(mechanisms?.count, 22)
        XCTAssertEqual(Set(mechanisms.map { Array($0.values) } ?? []), ["unavailable"])
        XCTAssertEqual(mechanisms?["reloadProfile"], "unavailable")
        XCTAssertEqual(mechanisms?["selectGroupPolicy"], "unavailable")
    }

    func testFreshConfigFields() {
        let config = InstallConfig.merged(existing: nil, fields: fields)
        XCTAssertEqual(config["surgeCliPath"] as? String, fields.surgeCliPath)
        XCTAssertEqual(config["keychainHelperPath"] as? String, fields.keychainHelperPath)
        XCTAssertEqual(config["nodeVersionPin"] as? String, "22.13.1")
        XCTAssertEqual(config["webRoot"] as? String, fields.webRoot)
        let bridge = config["bridge"] as? [String: Any]
        XCTAssertEqual(bridge?["transport"] as? String, "tcp")
        XCTAssertEqual(bridge?["port"] as? Int, 61848)
        XCTAssertNotNil(JSONLine.encode(config))
    }

    func testExistingAdapterMechanismIsNeverOverwritten() {
        let existing: [String: Any] = ["adapterMechanism": ["selectGroupPolicy": "cli", "getVersion": "http"]]
        let config = InstallConfig.merged(existing: existing, fields: fields)
        XCTAssertEqual(config["adapterMechanism"] as? [String: String], ["selectGroupPolicy": "cli", "getVersion": "http"])
    }

    func testSurgePathIsOmittedWhenNotInstalledAndKeptIfPresent() {
        var noSurge = fields
        noSurge.surgeCliPath = nil
        XCTAssertNil(InstallConfig.merged(existing: nil, fields: noSurge)["surgeCliPath"])
        let kept = InstallConfig.merged(existing: ["surgeCliPath": "/Applications/Surge.app/Contents/Applications/surge-cli"], fields: noSurge)
        XCTAssertEqual(kept["surgeCliPath"] as? String, "/Applications/Surge.app/Contents/Applications/surge-cli")
    }

    func testUnknownKeysArePreservedAndOwnedKeysUpdated() {
        let existing: [String: Any] = ["httpPort": 61900, "keychainHelperPath": "/old/path", "bridge": ["transport": "tcp", "port": 1] as [String: Any]]
        let config = InstallConfig.merged(existing: existing, fields: fields)
        XCTAssertEqual(config["httpPort"] as? Int, 61900)
        XCTAssertEqual(config["keychainHelperPath"] as? String, fields.keychainHelperPath)
        XCTAssertEqual((config["bridge"] as? [String: Any])?["port"] as? Int, 61848)
    }

    func testInvalidNodePinIsNotWritten() {
        var bad = fields
        bad.nodeVersionPin = "$(SFE_NODE_VERSION)"
        XCTAssertNil(InstallConfig.merged(existing: nil, fields: bad)["nodeVersionPin"])
        bad.nodeVersionPin = ""
        XCTAssertNil(InstallConfig.merged(existing: nil, fields: bad)["nodeVersionPin"])
    }

    func testNodeVersionFormat() {
        XCTAssertTrue(InstallConfig.isValidNodeVersion("22.13.1"))
        XCTAssertTrue(InstallConfig.isValidNodeVersion("v22.13.1"))
        XCTAssertFalse(InstallConfig.isValidNodeVersion("22.13"))
        XCTAssertFalse(InstallConfig.isValidNodeVersion("22.13.1-rc1"))
        XCTAssertFalse(InstallConfig.isValidNodeVersion("22..1"))
        XCTAssertFalse(InstallConfig.isValidNodeVersion("vv22.13.1"))
    }

    func testPrimitiveListHasNoDuplicates() {
        XCTAssertEqual(Set(InstallConfig.primitives).count, InstallConfig.primitives.count)
    }
}

final class SecureFileTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("sfe-secure-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testWritesFileWithMode0600() throws {
        let url = directory.appendingPathComponent("bridge.token")
        try SecureFile.writeAtomically(Data(Fixtures.token.utf8), to: url)
        XCTAssertEqual(SecureFile.permissions(of: url), 0o600)
        XCTAssertEqual(SecureFile.readRegularFile(url, maxBytes: 1024), Data(Fixtures.token.utf8))
    }

    func testOverwriteReplacesContentAndKeepsMode() throws {
        let url = directory.appendingPathComponent("install.json")
        try SecureFile.writeAtomically(Data("{}".utf8), to: url)
        try SecureFile.writeAtomically(Data("{\"a\":1}".utf8), to: url)
        XCTAssertEqual(SecureFile.readRegularFile(url, maxBytes: 1024), Data("{\"a\":1}".utf8))
        XCTAssertEqual(SecureFile.permissions(of: url), 0o600)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".tmp") }
        XCTAssertEqual(leftovers, [])
    }

    func testReadRefusesSymlinksAndOversizedFiles() throws {
        let real = directory.appendingPathComponent("real")
        try SecureFile.writeAtomically(Data("12345".utf8), to: real)
        let link = directory.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertNil(SecureFile.readRegularFile(link, maxBytes: 1024))
        XCTAssertNil(SecureFile.readRegularFile(real, maxBytes: 4))
        XCTAssertNil(SecureFile.readRegularFile(directory.appendingPathComponent("missing"), maxBytes: 1024))
    }

    func testPrivateDirectoryIsCreatedOrTightened() throws {
        let created = directory.appendingPathComponent("data")
        try SecureFile.ensurePrivateDirectory(created)
        XCTAssertEqual(SecureFile.permissions(of: created), 0o700)

        let loose = directory.appendingPathComponent("loose")
        try FileManager.default.createDirectory(at: loose, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        try SecureFile.ensurePrivateDirectory(loose)
        XCTAssertEqual(SecureFile.permissions(of: loose), 0o700)
    }

    func testPrivateDirectoryRefusesSymlinkAndFile() throws {
        let target = directory.appendingPathComponent("target")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        let link = directory.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try SecureFile.ensurePrivateDirectory(link))

        let file = directory.appendingPathComponent("file")
        try SecureFile.writeAtomically(Data(), to: file)
        XCTAssertThrowsError(try SecureFile.ensurePrivateDirectory(file))
    }

    func testWriteFailsWhenDirectoryIsMissing() {
        let url = directory.appendingPathComponent("missing/install.json")
        XCTAssertThrowsError(try SecureFile.writeAtomically(Data("{}".utf8), to: url)) { error in
            XCTAssertFalse(String(describing: error).contains("{}"))
        }
    }
}
