import XCTest
@testable import App

final class BridgeTests: XCTestCase {
    func testAcceptsOnlyTheAppsMainFrame() {
        XCTAssertTrue(Bridge.accepts(isMainFrame: true, scheme: "opencode-rc", host: "localhost"))
        XCTAssertFalse(Bridge.accepts(isMainFrame: false, scheme: "opencode-rc", host: "localhost"))
        XCTAssertFalse(Bridge.accepts(isMainFrame: true, scheme: "https", host: "localhost"))
        XCTAssertFalse(Bridge.accepts(isMainFrame: true, scheme: "opencode-rc", host: "evil"))
    }

    func testDispatchesToTheRegisteredMethod() {
        let bridge = Bridge()
        bridge.register("echo") { args, reply in reply(.success(args["v"])) }
        let done = expectation(description: "reply")
        bridge.dispatch(body: ["method": "echo", "args": ["v": 7]]) { result, error in
            XCTAssertEqual(result as? Int, 7)
            XCTAssertNil(error)
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
    }

    func testUnknownMethodsFail() {
        let bridge = Bridge()
        let done = expectation(description: "reply")
        bridge.dispatch(body: ["method": "nope"]) { _, error in
            XCTAssertEqual(error, "failed: unknown method nope")
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
    }
}
