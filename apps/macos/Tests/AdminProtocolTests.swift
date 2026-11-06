import XCTest

final class AdminProtocolTests: XCTestCase {
    func testRequestLineShape() throws {
        let line = try XCTUnwrap(AdminProtocol.requestLine(op: "issueLoginCode"))
        let object = decodeLine(line)
        XCTAssertEqual(JSONLine.integer(object["v"]), 1)
        XCTAssertEqual(object["op"] as? String, "issueLoginCode")
        XCTAssertEqual((object["args"] as? [String: Any])?.count, 0)
    }

    func testParsesSuccessData() {
        guard case .success(let payload)? = AdminProtocol.parseReply(Data(#"{"ok":true,"data":{"url":"http://127.0.0.1:61847/auth/exchange?code=abc"}}"#.utf8)) else {
            return XCTFail("expected success")
        }
        XCTAssertNotNil((payload as? [String: Any])?["url"])
    }

    func testAcceptsResultAsSuccessPayload() {
        guard case .success(let payload)? = AdminProtocol.parseReply(Data(#"{"ok":true,"result":[]}"#.utf8)) else {
            return XCTFail("expected success")
        }
        XCTAssertEqual((payload as? [Any])?.count, 0)
    }

    func testParsesErrorWithDetails() {
        let line = Data(#"{"ok":false,"error":{"code":"NEEDS_CONFIRMATION","message":"切换失败：需要确认旧窗口","details":{"reason":"other_environment_active"}}}"#.utf8)
        guard case .failure(let error)? = AdminProtocol.parseReply(line) else { return XCTFail("expected failure") }
        XCTAssertEqual(error.code, "NEEDS_CONFIRMATION")
        XCTAssertEqual(error.message, "切换失败：需要确认旧窗口")
        XCTAssertEqual(error.details?["reason"] as? String, "other_environment_active")
    }

    func testRejectsMalformedReplies() {
        XCTAssertNil(AdminProtocol.parseReply(Data("nope".utf8)))
        XCTAssertNil(AdminProtocol.parseReply(Data(#"{"ok":true}"#.utf8)))
        XCTAssertNil(AdminProtocol.parseReply(Data(#"{"ok":false,"error":{"code":"X y","message":"m"}}"#.utf8)))
        XCTAssertNil(AdminProtocol.parseReply(Data(#"{"ok":"true","data":1}"#.utf8)))
    }

    // MARK: 环境

    func testParsesEnvironmentList() {
        let payload = jsonObject(#"""
        [
          {"id":"env-1","displayName":"美国 01","binding":{"state":"bound","profileIdShort":"0f1e2d3c"}},
          {"id":"env-2","displayName":"美国 02","binding":{"state":"bound_unverified_id","profileIdShort":"11223344"}},
          {"id":"env-3","displayName":"美国 03","binding":{"state":"unbound","profileIdShort":null}},
          {"displayName":"缺少 id"},
          "garbage"
        ]
        """#)
        let items = AdminProtocol.parseEnvironments(payload)
        XCTAssertEqual(items, [
            .init(id: "env-1", displayName: "美国 01", isBound: true, profileIdShort: "0f1e2d3c"),
            .init(id: "env-2", displayName: "美国 02", isBound: true, profileIdShort: "11223344"),
            .init(id: "env-3", displayName: "美国 03", isBound: false, profileIdShort: nil),
        ])
        XCTAssertEqual(items?[2].menuTitle, "美国 03（未关联场景）")
        XCTAssertEqual(items?[0].menuTitle, "美国 01")
    }

    func testEnvironmentListMustBeAnArray() {
        XCTAssertNil(AdminProtocol.parseEnvironments(["id": "env-1"]))
    }

    // MARK: 激活与确认

    func testFirstActivationHasNoPolicy() {
        let args = AdminProtocol.activateArgs(environmentId: "env-1", requestId: "req-1", choice: nil)
        XCTAssertEqual(args["id"] as? String, "env-1")
        XCTAssertEqual(args["request_id"] as? String, "req-1")
        XCTAssertNil(args["old_session_policy"])
        XCTAssertNil(args["confirmed_environment_id"])
    }

    func testConfirmedActivationKeepsRequestIdAndSendsChoice() {
        let args = AdminProtocol.activateArgs(environmentId: "env-1", requestId: "req-1", choice: (policy: "closed_confirmed", confirmedEnvironmentId: "env-9"))
        XCTAssertEqual(args["request_id"] as? String, "req-1")
        XCTAssertEqual(args["old_session_policy"] as? String, "closed_confirmed")
        XCTAssertEqual(args["confirmed_environment_id"] as? String, "env-9")
        XCTAssertNotNil(AdminProtocol.requestLine(op: "activate", args: args))
    }

    func testConfirmedActivationWithoutCurrentEnvironmentSendsExplicitNull() {
        let args = AdminProtocol.activateArgs(environmentId: "env-1", requestId: "req-1", choice: (policy: "keep_open_acknowledged", confirmedEnvironmentId: nil))
        XCTAssertTrue(args["confirmed_environment_id"] is NSNull)
    }

    func testParsesNeedsConfirmationDetails() {
        let details = jsonDictionary(#"""
        {"reason":"other_environment_active","currentEnvironmentId":"env-9","currentEnvironmentLabel":"美国 09",
         "otherProfilesOpen":[{"profileIdShort":"aabbccdd","environmentLabel":null},{"profileIdShort":"11223344","environmentLabel":"美国 02"}],
         "options":["keep_open_acknowledged","closed_confirmed","unknown_option"],
         "limitation":"首请求与旧连接能力未通过：建议保存工作后退出并重开 Safari。"}
        """#)
        let confirmation = AdminProtocol.parseConfirmation(details)
        XCTAssertEqual(confirmation?.currentEnvironmentId, "env-9")
        XCTAssertEqual(confirmation?.options, ["closed_confirmed", "keep_open_acknowledged"], "known options only, fixed order")
        XCTAssertEqual(confirmation?.otherProfiles, [
            .init(profileIdShort: "aabbccdd", environmentLabel: nil),
            .init(profileIdShort: "11223344", environmentLabel: "美国 02"),
        ])
    }

    func testConfirmationRequiresReasonAndOptions() {
        XCTAssertNil(AdminProtocol.parseConfirmation(nil))
        XCTAssertNil(AdminProtocol.parseConfirmation(["reason": "other_environment_active"]))
        XCTAssertNil(AdminProtocol.parseConfirmation(["options": ["closed_confirmed"]]))
    }

    func testConfirmationTextExplainsBothConsequences() throws {
        let confirmation = try XCTUnwrap(AdminProtocol.parseConfirmation(jsonDictionary(#"""
        {"reason":"other_environment_active","currentEnvironmentId":"env-9","currentEnvironmentLabel":"美国 09",
         "otherProfilesOpen":[],"options":["closed_confirmed","keep_open_acknowledged"],"limitation":null}
        """#)))
        let text = AdminProtocol.confirmationText(confirmation)
        XCTAssertTrue(text.contains("当前使用环境：美国 09"))
        XCTAssertTrue(text.contains("已关闭，继续："))
        XCTAssertTrue(text.contains("不关闭，继续："))
        XCTAssertTrue(text.contains("新环境的出口"))
        XCTAssertFalse(text.contains("!"))
        XCTAssertFalse(text.contains("！"))
    }

    func testConfirmationTextListsOtherProfilesAndLimitation() throws {
        let confirmation = try XCTUnwrap(AdminProtocol.parseConfirmation(jsonDictionary(#"""
        {"reason":"other_profiles_open","currentEnvironmentId":null,"currentEnvironmentLabel":null,
         "otherProfilesOpen":[{"profileIdShort":"aabbccdd","environmentLabel":null}],"options":["closed_confirmed"],
         "limitation":"建议保存工作后退出并重开 Safari。"}
        """#)))
        let text = AdminProtocol.confirmationText(confirmation)
        XCTAssertTrue(text.contains("当前使用环境：无"))
        XCTAssertTrue(text.contains("aabbccdd 未绑定场景"))
        XCTAssertTrue(text.contains("建议保存工作后退出并重开 Safari。"))
        XCTAssertFalse(text.contains("不关闭，继续"), "only offered options are explained")
    }

    func testGuidanceDoesNotClaimOneClick() {
        let text = AdminProtocol.activationGuidance(environmentName: "美国 01")
        XCTAssertEqual(text, "在 Safari 切换到场景 美国 01，点击扩展图标完成验证")
        XCTAssertFalse(text.contains("一键"))
    }

    // MARK: 登录地址

    func testAcceptsLoopbackLoginURL() {
        XCTAssertNotNil(AdminProtocol.validatedLoginURL("http://127.0.0.1:61847/auth/exchange?code=abc"))
        XCTAssertNotNil(AdminProtocol.validatedLoginURL("http://localhost:61847/auth/exchange?code=abc"))
    }

    func testRejectsAnythingElse() {
        XCTAssertNil(AdminProtocol.validatedLoginURL("https://127.0.0.1:61847/auth/exchange?code=abc"))
        XCTAssertNil(AdminProtocol.validatedLoginURL("http://203.0.113.5:61847/auth/exchange?code=abc"))
        XCTAssertNil(AdminProtocol.validatedLoginURL("http://evil.example.test:61847/auth/exchange?code=abc"))
        XCTAssertNil(AdminProtocol.validatedLoginURL("http://127.0.0.1/auth/exchange?code=abc"))
        XCTAssertNil(AdminProtocol.validatedLoginURL("http://127.0.0.1:61847/other"))
        XCTAssertNil(AdminProtocol.validatedLoginURL("http://user@127.0.0.1:61847/auth/exchange?code=abc"))
        XCTAssertNil(AdminProtocol.validatedLoginURL("file:///etc/hosts"))
        XCTAssertNil(AdminProtocol.validatedLoginURL("javascript:alert(1)"))
    }

    // MARK: 状态

    func testStatusLinesSummarizeSnapshot() {
        let snapshot = jsonObject(#"""
        {"serviceVersion":"0.1.0","demoMode":false,
         "surge":{"reachable":true,"version":"6.5.0","onWorkingProfile":true},
         "route":{"activeEnvironmentId":"env-1","entryMode":"ACTIVE","warnings":[{"code":"probe_expired"}]},
         "environments":[{"id":"env-1","displayName":"美国 01"}]}
        """#)
        let lines = AdminProtocol.statusLines(snapshot: snapshot)
        XCTAssertEqual(lines, [
            "本机服务：已连接（版本 0.1.0）",
            "Surge：可连接（6.5.0）",
            "工作配置：正在使用",
            "当前环境：美国 01",
            "路由警告：1 项，请在管理后台查看",
        ])
    }

    func testStatusLinesShowNormalModeAndDemo() {
        let snapshot = jsonObject(#"""
        {"serviceVersion":"0.1.0","demoMode":true,"surge":{"reachable":false},
         "route":{"activeEnvironmentId":null,"entryMode":"NORMAL","warnings":[]},"environments":[]}
        """#)
        let lines = AdminProtocol.statusLines(snapshot: snapshot)
        XCTAssertTrue(lines.contains("演示模式：数据为合成数据，不代表任何网络事实"))
        XCTAssertTrue(lines.contains("Surge：无法连接"))
        XCTAssertTrue(lines.contains("当前环境：无（普通模式）"))
    }
}
