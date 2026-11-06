import Foundation
import ServiceManagement
import XCTest

final class ServiceAgentTests: XCTestCase {
    func testPaneNameFollowsTheSystemSettingsNameForEachMacOSVersion() {
        // macOS 14：「登录项」；macOS 15 起（含 26）：「登录项与扩展」
        XCTAssertEqual(ServiceAgent.paneName(forOSMajorVersion: 14), "登录项")
        XCTAssertEqual(ServiceAgent.paneName(forOSMajorVersion: 15), "登录项与扩展")
        XCTAssertEqual(ServiceAgent.paneName(forOSMajorVersion: 16), "登录项与扩展")
        XCTAssertEqual(ServiceAgent.paneName(forOSMajorVersion: 26), "登录项与扩展")
    }

    func testApprovalTextsUseTheCurrentPaneName() {
        let pane = ServiceAgent.loginItemsPaneName
        XCTAssertEqual(pane, ServiceAgent.paneName(forOSMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion))
        XCTAssertTrue(ServiceAgent.statusText(.requiresApproval).contains("「\(pane)」"))
        XCTAssertTrue(ServiceAgent.approvalGuidance.contains("系统设置 → 通用 → \(pane)"))
        XCTAssertEqual(ServiceAgent.openLoginItemsButtonTitle, "打开\(pane)设置")
    }

    func testStatusTextsAreChinese() {
        for status in [SMAppService.Status.enabled, .notRegistered, .requiresApproval, .notFound] {
            XCTAssertTrue(ServiceAgent.statusText(status).hasPrefix("后台服务："))
        }
    }
}
