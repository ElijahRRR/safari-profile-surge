import XCTest

final class BundleLayoutTests: XCTestCase {
    private let launcher = URL(fileURLWithPath: "/Applications/SafariProfileSurge.app/Contents/Helpers/sfe-service-launcher")

    func testServiceCommandUsesAbsolutePaths() {
        let command = BundleLayout.serviceCommand(forHelperExecutable: launcher)
        XCTAssertEqual(command?.node.path, "/Applications/SafariProfileSurge.app/Contents/Helpers/node")
        XCTAssertEqual(command?.script.path, "/Applications/SafariProfileSurge.app/Contents/Resources/service/service.mjs")
    }

    func testBundledNodeIsCodeInHelpersNotAResource() throws {
        // Apple「Placing content in a bundle」：辅助工具放在 Contents/MacOS 或 Contents/Helpers，Resources 只放非代码
        let command = try XCTUnwrap(BundleLayout.serviceCommand(forHelperExecutable: launcher))
        XCTAssertEqual(command.node.deletingLastPathComponent().path, launcher.deletingLastPathComponent().path)
        XCTAssertFalse(command.node.pathComponents.contains("Resources"))
    }

    func testContentsDirectoryIsResolvedRelativeToTheHelper() {
        XCTAssertEqual(
            BundleLayout.contentsDirectory(forHelperExecutable: launcher)?.path,
            "/Applications/SafariProfileSurge.app/Contents"
        )
    }

    func testHelperOutsideTheAppBundleIsRejected() {
        XCTAssertNil(BundleLayout.contentsDirectory(forHelperExecutable: URL(fileURLWithPath: "/usr/local/bin/sfe-service-launcher")))
        XCTAssertNil(BundleLayout.contentsDirectory(forHelperExecutable: URL(fileURLWithPath: "/tmp/Helpers/sfe-service-launcher")))
        XCTAssertNil(BundleLayout.serviceCommand(forHelperExecutable: URL(fileURLWithPath: "/tmp/Contents/MacOS/sfe-service-launcher")))
    }
}
