import XCTest

final class LineBufferTests: XCTestCase {
    func testReturnsFirstLineWhenNewlineArrives() {
        var buffer = LineBuffer(maxBytes: 64)
        XCTAssertEqual(buffer.append(Data("{\"ok\":".utf8)), .needMore)
        XCTAssertEqual(buffer.append(Data("true}\n".utf8)), .line(Data("{\"ok\":true}".utf8)))
    }

    func testIgnoresEverythingAfterTheFirstLine() {
        var buffer = LineBuffer(maxBytes: 64)
        XCTAssertEqual(buffer.append(Data("first\nsecond\n".utf8)), .line(Data("first".utf8)))
    }

    func testStripsTrailingCarriageReturn() {
        var buffer = LineBuffer(maxBytes: 64)
        XCTAssertEqual(buffer.append(Data("abc\r\n".utf8)), .line(Data("abc".utf8)))
    }

    func testLineExactlyAtLimitIsAccepted() {
        var buffer = LineBuffer(maxBytes: 4)
        XCTAssertEqual(buffer.append(Data("abcd\n".utf8)), .line(Data("abcd".utf8)))
    }

    func testLineOverLimitIsRejectedWhenNewlineArrives() {
        var buffer = LineBuffer(maxBytes: 4)
        XCTAssertEqual(buffer.append(Data("abcde\n".utf8)), .tooLong)
    }

    func testUnterminatedDataOverLimitIsRejectedEarly() {
        var buffer = LineBuffer(maxBytes: 4)
        XCTAssertEqual(buffer.append(Data("abcd".utf8)), .needMore)
        XCTAssertEqual(buffer.append(Data("ef".utf8)), .tooLong)
    }

    func testFinishTreatsUnterminatedRemainderAsLine() {
        var buffer = LineBuffer(maxBytes: 16)
        XCTAssertEqual(buffer.append(Data("{}".utf8)), .needMore)
        XCTAssertEqual(buffer.finish(), .line(Data("{}".utf8)))
    }

    func testFinishWithNothingIsEmpty() {
        let buffer = LineBuffer(maxBytes: 16)
        XCTAssertEqual(buffer.finish(), .empty)
    }

    func testEmptyFirstLineIsAnEmptyLine() {
        var buffer = LineBuffer(maxBytes: 16)
        XCTAssertEqual(buffer.append(Data("\n{}".utf8)), .line(Data()))
    }

    func testByteLimitCountsUTF8Bytes() {
        // 「场景」是 6 个 UTF-8 字节
        var buffer = LineBuffer(maxBytes: 5)
        XCTAssertEqual(buffer.append(Data("场景\n".utf8)), .tooLong)
    }

    func testJSONLineEncodeProducesSingleTerminatedLine() {
        let line = JSONLine.encode(["text": "a\nb"])
        XCTAssertNotNil(line)
        XCTAssertEqual(line?.last, 0x0A)
        XCTAssertEqual(line?.filter { $0 == 0x0A }.count, 1)
    }

    func testJSONLineRejectsNonSerializableObjects() {
        XCTAssertNil(JSONLine.encode(["date": Date()]))
    }

    func testStrictBoolDistinguishesNumbers() {
        let object = jsonDictionary(#"{"t":true,"one":1,"zero":0,"f":false}"#)
        XCTAssertEqual(JSONLine.bool(object["t"]), true)
        XCTAssertEqual(JSONLine.bool(object["f"]), false)
        XCTAssertNil(JSONLine.bool(object["one"]))
        XCTAssertNil(JSONLine.bool(object["zero"]))
    }

    func testStrictIntegerRejectsBoolsAndFractions() {
        let object = jsonDictionary(#"{"one":1,"t":true,"half":1.5,"s":"1"}"#)
        XCTAssertEqual(JSONLine.integer(object["one"]), 1)
        XCTAssertNil(JSONLine.integer(object["t"]))
        XCTAssertNil(JSONLine.integer(object["half"]))
        XCTAssertNil(JSONLine.integer(object["s"]))
    }
}
