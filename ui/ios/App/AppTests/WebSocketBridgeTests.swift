import XCTest
@testable import App

final class WebSocketBridgeTests: XCTestCase {
    let server = URL(string: "https://rc.example.com:8443")!

    func testAllowsOnlyTheServersSocketOrigin() {
        XCTAssertTrue(WebSocketBridge.allowed(URL(string: "wss://rc.example.com:8443/proxy/s/pty?access_token=t")!, server: server))
        XCTAssertFalse(WebSocketBridge.allowed(URL(string: "ws://rc.example.com:8443/x")!, server: server))
        XCTAssertFalse(WebSocketBridge.allowed(URL(string: "wss://rc.example.com/x")!, server: server))
        XCTAssertFalse(WebSocketBridge.allowed(URL(string: "wss://evil.example.com:8443/x")!, server: server))
        XCTAssertTrue(WebSocketBridge.allowed(URL(string: "ws://10.0.0.5:12029/x")!, server: URL(string: "http://10.0.0.5:12029")!))
    }

    func testRefusesToOpenWithoutAServer() {
        let bridge = WebSocketBridge(proxy: ServerProxy(), emit: { _, _ in })
        XCTAssertThrowsError(try bridge.open(id: "1", url: "wss://rc.example.com/x", protocols: []))
    }

    // Port 1 on loopback refuses the connection; no server is needed.
    private func refusedBridge(_ events: @escaping (String, [String: Any]) -> Void) throws -> WebSocketBridge {
        let proxy = ServerProxy()
        try proxy.setServer("http://127.0.0.1:1")
        return WebSocketBridge(proxy: proxy, emit: events)
    }

    private func settle(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func testAFailedConnectionEndsWithOneClose() throws {
        var events: [(String, [String: Any])] = []
        let closed = expectation(description: "ws.close")
        let bridge = try refusedBridge { e, d in
            events.append((e, d))
            if e == "ws.close" { closed.fulfill() }
        }
        try bridge.open(id: "a", url: "ws://127.0.0.1:1/x", protocols: [])
        wait(for: [closed], timeout: 10)
        settle(0.5)
        XCTAssertEqual(events.map(\.0), ["ws.error", "ws.close"])
        XCTAssertEqual(events.last?.1["id"] as? String, "a")
        XCTAssertEqual(events.last?.1["code"] as? Int, 1006)
        XCTAssertEqual(events.last?.1["wasClean"] as? Bool, false)
    }

    func testCloseFromJSEndsWithOneCloseWithItsCode() throws {
        var events: [(String, [String: Any])] = []
        let bridge = try refusedBridge { e, d in events.append((e, d)) }
        try bridge.open(id: "b", url: "ws://127.0.0.1:1/x", protocols: [])
        bridge.close(id: "b", code: 1000, reason: "bye")
        settle(1)
        XCTAssertEqual(events.filter { $0.0 == "ws.close" }.count, 1)
        let close = events.first { $0.0 == "ws.close" }?.1
        XCTAssertEqual(close?["id"] as? String, "b")
        XCTAssertEqual(close?["code"] as? Int, 1000)
        XCTAssertEqual(close?["reason"] as? String, "bye")
        XCTAssertFalse(events.map(\.0).contains("ws.error"))
    }

    func testCloseAndSendForAnUnknownIdDoNothing() throws {
        var events: [String] = []
        let bridge = try refusedBridge { e, _ in events.append(e) }
        bridge.close(id: "nope", code: 1000, reason: "")
        bridge.send(id: "nope", text: "x", base64: Optional<String>.none)
        settle(0.2)
        XCTAssertEqual(events, [])
    }
}
