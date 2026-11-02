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
    var onResponse: (() -> Void)?
    var calls = 0
    init(_ url: String, method: String = "GET", body: Data? = nil) {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = method
        r.httpBody = body
        request = r
    }
    func didReceive(_ response: URLResponse) { calls += 1; self.response = response; onResponse?() }
    func didReceive(_ data: Data) { calls += 1; chunks.append(data) }
    func didFinish() { calls += 1; finished = true; onFinish?() }
    func didFailWithError(_ error: Error) { calls += 1; self.error = error; onFinish?() }
}

/// /hang answers headers and never finishes; /out redirects to another origin; /same redirects to /target
/// on the same origin; anything else answers its path.
final class StubProtocol: URLProtocol {
    static var stopped: ((String) -> Void)?   // called with the path; also when a load ends normally
    static var lastRequest: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubProtocol.lastRequest = request
        let url = request.url!
        func redirect(_ to: String) {
            let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": to])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: to)!), redirectResponse: response)
        }
        switch url.path {
        case "/out": redirect("https://other.example.com/target")
        case "/same": redirect("https://rc.example.com/target")
        default:
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "text/event-stream"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if url.path == "/hang" { return }
            client?.urlProtocol(self, didLoad: Data(url.path.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { StubProtocol.stopped?(request.url!.path) }
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
        XCTAssertTrue(task.chunks.isEmpty)
    }

    func testDropsResponseHeadersURLSessionHasHandled() {
        let out = ServerProxy.responseHeaders(["content-encoding": "gzip", "Content-Length": "10", "Transfer-Encoding": "chunked",
                                               "Content-Type": "text/event-stream", "Cache-Control": "no-cache"])
        XCTAssertEqual(out, ["Content-Type": "text/event-stream", "Cache-Control": "no-cache"])
    }

    private func stubbedProxy(timeout: TimeInterval = 60) -> ServerProxy {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        config.timeoutIntervalForRequest = timeout
        let proxy = ServerProxy(configuration: config)
        try? proxy.setServer("https://rc.example.com")
        return proxy
    }

    private func run(_ proxy: ServerProxy, _ path: String) -> FakeSchemeTask {
        let task = FakeSchemeTask("opencode-rc://localhost/__server" + path)
        let done = expectation(description: "finished \(path)")
        task.onFinish = { done.fulfill() }
        proxy.start(task)
        wait(for: [done], timeout: 5)
        return task
    }

    func testStopCancelsTheRequestAndLaterTasksStillFinish() {
        let proxy = stubbedProxy()
        let task = FakeSchemeTask("opencode-rc://localhost/__server/hang")
        let responded = expectation(description: "response")
        task.onResponse = { responded.fulfill() }
        proxy.start(task)
        wait(for: [responded], timeout: 5)

        let cancelled = expectation(description: "stopLoading")
        cancelled.assertForOverFulfill = false
        StubProtocol.stopped = { if $0 == "/hang" { cancelled.fulfill() } }
        let calls = task.calls
        proxy.stop(task)
        wait(for: [cancelled], timeout: 5)
        StubProtocol.stopped = nil
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))   // let the cancel's completion arrive
        XCTAssertEqual(task.calls, calls)
        XCTAssertFalse(task.finished)
        XCTAssertNil(task.error)

        let next = run(proxy, "/next")
        XCTAssertTrue(next.finished)
        XCTAssertEqual(next.chunks.reduce(Data(), +), Data("/next".utf8))
    }

    func testRefusesACrossOriginRedirect() {
        let task = run(stubbedProxy(), "/out")
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 502)
        XCTAssertTrue(task.finished)
        XCTAssertTrue(task.chunks.isEmpty)
    }

    func testFollowsASameOriginRedirect() {
        let task = run(stubbedProxy(), "/same")
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(task.response?.url?.absoluteString, "opencode-rc://localhost/__server/same")
        XCTAssertEqual(task.chunks.reduce(Data(), +), Data("/target".utf8))
        XCTAssertTrue(task.finished)
    }

    func testUsesTheSessionsRequestTimeout() {
        _ = run(stubbedProxy(timeout: 1234), "/t")
        XCTAssertEqual(StubProtocol.lastRequest?.timeoutInterval, 1234)
    }
}
