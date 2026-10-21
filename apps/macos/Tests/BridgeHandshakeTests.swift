import XCTest

/// 原生桥握手（BridgeHandshake / BridgeConversation）：令牌从不上线路；服务不能证明持有令牌时，
/// 原生桥不发送场景 ID 或消息。假服务见 TestSupport.swift 的 FakeBridgeServer。
final class BridgeHandshakeTests: XCTestCase {
    private let otherToken = String(repeating: "B", count: 42) + "Q"

    private func handshake(token: String = Fixtures.token, payload: String = HandshakeVector.payload) -> BridgeHandshake {
        BridgeHandshake(token: token, payload: payload, clientNonce: HandshakeVector.clientNonceBytes)
    }

    private func run(_ handshake: BridgeHandshake, against server: FakeBridgeServer) -> Result<Data, BridgeTransportError>? {
        var results: [Result<Data, BridgeTransportError>] = []
        BridgeConversation.run(handshake, over: server) { results.append($0) }
        XCTAssertEqual(results.count, 1, "completion must be called exactly once")
        return results.first
    }

    // MARK: 与 Node 服务共用的已知答案

    func testProofsMatchTheVectorSharedWithTheService() {
        XCTAssertEqual(BridgeHandshake.sha256Hex(HandshakeVector.payload), HandshakeVector.payloadSHA256)
        XCTAssertEqual(
            BridgeHandshake.serverProof(token: HandshakeVector.token, clientNonce: HandshakeVector.clientNonce, serverNonce: HandshakeVector.serverNonce),
            HandshakeVector.serverProof
        )
        XCTAssertEqual(
            BridgeHandshake.clientProof(token: HandshakeVector.token, serverNonce: HandshakeVector.serverNonce, clientNonce: HandshakeVector.clientNonce, payload: HandshakeVector.payload),
            HandshakeVector.clientProof
        )
    }

    func testRequestLineForTheVectorChallengeCarriesTheVectorClientProof() throws {
        let challenge = #"{"serverNonce":"\#(HandshakeVector.serverNonce)","serverProof":"\#(HandshakeVector.serverProof)","type":"challenge","v":1}"#
        let line = try handshake().requestLine(answering: Data(challenge.utf8)).get()
        let request = decodeLine(line)
        XCTAssertEqual(request["type"] as? String, "request")
        XCTAssertEqual(JSONLine.integer(request["v"]), 1)
        XCTAssertEqual(request["clientProof"] as? String, HandshakeVector.clientProof)
        XCTAssertEqual(request["payload"] as? String, HandshakeVector.payload)
        XCTAssertEqual(Set(request.keys), ["v", "type", "clientProof", "payload"])
    }

    // MARK: 线路内容

    func testHelloCarriesOnlyVersionTypeAndNonce() {
        let hello = decodeLine(handshake().helloLine)
        XCTAssertEqual(Set(hello.keys), ["v", "type", "clientNonce"])
        XCTAssertEqual(hello["type"] as? String, "hello")
        XCTAssertEqual(hello["clientNonce"] as? String, HandshakeVector.clientNonce)
    }

    func testTheTokenNeverAppearsInAnyLineSent() throws {
        let server = FakeBridgeServer(token: Fixtures.token)
        let response = try XCTUnwrap(run(handshake(), against: server)).get()
        XCTAssertEqual(JSONLine.bool(JSONLine.decodeObject(response)?["ok"]), true)
        XCTAssertEqual(server.received.count, 2)
        for line in server.received {
            XCTAssertFalse(String(decoding: line, as: UTF8.self).contains(Fixtures.token))
        }
        XCTAssertEqual(server.verifiedPayloads, [HandshakeVector.payload])
    }

    func testRandomNoncesAre32BytesAndDiffer() throws {
        let first = try XCTUnwrap(BridgeHandshake.randomNonce())
        let second = try XCTUnwrap(BridgeHandshake.randomNonce())
        XCTAssertEqual(first.count, 32)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(BridgeHandshake(token: Fixtures.token, payload: "{}", clientNonce: first).clientNonce.count, 64)
    }

    // MARK: 服务不能证明持有令牌时，原生桥拒绝发送请求

    func testRefusesToSendTheRequestToAServerThatCannotProveTheToken() throws {
        // 例如其他系统用户抢先监听了 127.0.0.1:61848：它没有令牌，算不出正确的 serverProof
        let squatter = FakeBridgeServer(token: otherToken)
        let result = try XCTUnwrap(run(handshake(), against: squatter))
        XCTAssertEqual(result.failureValue, .handshakeFailed)
        XCTAssertEqual(squatter.received.count, 1, "only the hello may be sent")
        let hello = String(decoding: try XCTUnwrap(squatter.received.first), as: UTF8.self)
        XCTAssertFalse(hello.contains(Fixtures.token))
        XCTAssertFalse(hello.contains(Fixtures.profileId))
        XCTAssertFalse(hello.contains("getCurrentState"))
        XCTAssertNil(squatter.sentPayload)
        XCTAssertTrue(squatter.verifiedPayloads.isEmpty)
    }

    func testRefusesAServerThatClosesAfterHello() throws {
        let server = FakeBridgeServer(token: Fixtures.token)
        server.onHello = .close
        XCTAssertEqual(try XCTUnwrap(run(handshake(), against: server)).failureValue, .handshakeFailed)
        XCTAssertEqual(server.received.count, 1)
    }

    func testRefusesAProofReplayedFromAnotherConnection() throws {
        // 监听者手里有服务为另一个客户端随机数算出的证明（例如录下的旧连接）：对本连接无效
        let server = FakeBridgeServer(token: Fixtures.token)
        let replayed = server.challengeLine(for: String(repeating: "0", count: 64))
        server.onHello = .custom({ _ in replayed })
        XCTAssertEqual(try XCTUnwrap(run(handshake(), against: server)).failureValue, .handshakeFailed)
        XCTAssertEqual(server.received.count, 1)
    }

    func testRefusesMalformedChallenges() throws {
        let nonce = HandshakeVector.serverNonce
        let proof = HandshakeVector.serverProof
        let cases = [
            "not json",
            "[]",
            #"{"v":1,"type":"challenge","serverNonce":"\#(nonce)"}"#,
            #"{"v":1,"type":"challenge","serverProof":"\#(proof)"}"#,
            #"{"v":2,"type":"challenge","serverNonce":"\#(nonce)","serverProof":"\#(proof)"}"#,
            #"{"v":1,"type":"response","serverNonce":"\#(nonce)","serverProof":"\#(proof)"}"#,
            #"{"v":1,"type":"challenge","serverNonce":"\#(nonce.uppercased())","serverProof":"\#(proof)"}"#,
            #"{"v":1,"type":"challenge","serverNonce":"\#(nonce)","serverProof":"\#(proof.uppercased())"}"#,
            #"{"v":1,"type":"challenge","serverNonce":"\#(nonce)","serverProof":"\#(proof.dropLast())"}"#,
            #"{"v":1,"type":"challenge","serverNonce":"\#(nonce)","serverProof":"\#(Fixtures.token)"}"#,
        ]
        for text in cases {
            XCTAssertEqual(handshake().requestLine(answering: Data(text.utf8)).failureValue, .handshakeFailed, text)
        }
    }

    func testRefusesAServerNonceEqualToTheClientNonce() {
        // 反射：服务随机数与本端相同，即使证明按该值算对了也拒绝
        let nonce = HandshakeVector.clientNonce
        let proof = BridgeHandshake.serverProof(token: Fixtures.token, clientNonce: nonce, serverNonce: nonce)
        let text = #"{"v":1,"type":"challenge","serverNonce":"\#(nonce)","serverProof":"\#(proof)"}"#
        XCTAssertEqual(handshake().requestLine(answering: Data(text.utf8)).failureValue, .handshakeFailed)
    }

    func testAClientWithTheWrongTokenIsRejectedByTheServer() throws {
        // 双向：服务证明对本端无效，本端也就不会发出请求；服务从未处理任何 payload
        let server = FakeBridgeServer(token: Fixtures.token)
        XCTAssertEqual(try XCTUnwrap(run(handshake(token: otherToken), against: server)).failureValue, .handshakeFailed)
        XCTAssertTrue(server.verifiedPayloads.isEmpty)
    }

    func testServerProofsAndClientProofsAreDomainSeparated() {
        let a = BridgeHandshake.serverProof(token: Fixtures.token, clientNonce: HandshakeVector.serverNonce, serverNonce: HandshakeVector.clientNonce)
        let b = BridgeHandshake.clientProof(token: Fixtures.token, serverNonce: HandshakeVector.clientNonce, clientNonce: HandshakeVector.serverNonce, payload: "")
        XCTAssertNotEqual(a, b)
    }

    // MARK: 工具

    func testHexRoundTripAndStrictness() {
        let bytes: [UInt8] = [0x00, 0x0F, 0xA5, 0xFF]
        XCTAssertEqual(Hex.encode(bytes), "000fa5ff")
        XCTAssertEqual(Hex.decode("000fa5ff", byteCount: 4), bytes)
        XCTAssertNil(Hex.decode("000FA5FF", byteCount: 4))
        XCTAssertNil(Hex.decode("000fa5f", byteCount: 4))
        XCTAssertNil(Hex.decode("000fa5fg", byteCount: 4))
    }

    func testConstantTimeEqual() {
        XCTAssertTrue(BridgeHandshake.constantTimeEqual([1, 2, 3], [1, 2, 3]))
        XCTAssertFalse(BridgeHandshake.constantTimeEqual([1, 2, 3], [1, 2, 4]))
        XCTAssertFalse(BridgeHandshake.constantTimeEqual([1, 2, 3], [1, 2]))
    }
}
