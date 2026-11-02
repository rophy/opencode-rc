import XCTest
import WebKit
@testable import App

final class FakeSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var response: URLResponse?
    var chunks: [Data] = []
    var finished = false
    var error: Error?
    var onFinish: (() -> Void)?
    init(_ url: String, method: String = "GET", body: Data? = nil) {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = method
        r.httpBody = body
        request = r
    }
    func didReceive(_ response: URLResponse) { self.response = response }
    func didReceive(_ data: Data) { chunks.append(data) }
    func didFinish() { finished = true; onFinish?() }
    func didFailWithError(_ error: Error) { self.error = error; onFinish?() }
}

final class ServerProxyTests: XCTestCase {
    let server = URL(string: "https://rc.example.com:8443")!

    func testMapsThePathAndQuery() {
        XCTAssertEqual(ServerProxy.target(for: URL(string: "opencode-rc://localhost/__server/api/me?a=1&b=2")!, server: server)?.absoluteString,
                       "https://rc.example.com:8443/api/me?a=1&b=2")
        XCTAssertEqual(ServerProxy.target(for: URL(string: "opencode-rc://localhost/__server")!, server: server)?.absoluteString,
                       "https://rc.example.com:8443/")
        XCTAssertNil(ServerProxy.target(for: URL(string: "opencode-rc://localhost/assets/a.js")!, server: server))
    }

    func testDropsHeadersThatBelongToTheWebView() {
        let out = ServerProxy.forwardedHeaders(["Origin": "opencode-rc://localhost", "Host": "localhost",
                                                "Cookie": "a=b", "Authorization": "Bearer t", "Accept": "text/event-stream"])
        XCTAssertEqual(out, ["Authorization": "Bearer t", "Accept": "text/event-stream"])
    }

    func testAcceptsOnlyAnHttpOrigin() throws {
        let proxy = ServerProxy()
        try proxy.setServer("https://rc.example.com:8443/")
        XCTAssertEqual(proxy.server?.absoluteString, "https://rc.example.com:8443")
        XCTAssertThrowsError(try proxy.setServer("ftp://rc.example.com"))
        XCTAssertThrowsError(try proxy.setServer("https://rc.example.com/path"))
        XCTAssertThrowsError(try proxy.setServer("not a url"))
    }

    func testStreamsChunksAsTheyArrive() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EchoProtocol.self]
        let proxy = ServerProxy(configuration: config)
        try? proxy.setServer("https://rc.example.com")
        let task = FakeSchemeTask("opencode-rc://localhost/__server/x", method: "POST", body: Data("abc".utf8))
        let done = expectation(description: "finished")
        task.onFinish = { done.fulfill() }
        proxy.start(task)
        wait(for: [done], timeout: 5)
        XCTAssertTrue(task.finished)
        XCTAssertEqual(task.chunks.count, 2)
        XCTAssertEqual(task.chunks.reduce(Data(), +), Data("echo:abc".utf8))
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(task.response?.url?.absoluteString, "opencode-rc://localhost/__server/x")
    }

    func testAnswers502WithoutAServer() {
        let proxy = ServerProxy()
        let task = FakeSchemeTask("opencode-rc://localhost/__server/x")
        proxy.start(task)
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 502)
        XCTAssertTrue(task.finished)
    }
}
