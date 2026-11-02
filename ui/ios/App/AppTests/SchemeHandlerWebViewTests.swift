import XCTest
import WebKit
@testable import App

/// Answers every request with its own body, in two chunks.
final class EchoProtocol: URLProtocol {
    static var lastRequest: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        EchoProtocol.lastRequest = request
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("echo:".utf8))
        // Sent later: URLSession joins chunks that arrive together. (It also holds back small
        // text/plain and JSON bodies to sniff them; text/event-stream is passed on as it comes.)
        RunLoop.current.add(Timer(timeInterval: 0.1, repeats: false) { [self] _ in
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }, forMode: .common)
    }
    override func stopLoading() {}
}

final class SchemeHandlerWebViewTests: XCTestCase {
    func testFetchPostReachesTheServerWithItsBody() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("<html><body>t</body></html>".utf8).write(to: root.appendingPathComponent("index.html"))

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EchoProtocol.self]
        let proxy = ServerProxy(configuration: config)
        try proxy.setServer("https://rc.example.com")
        let handler = AppSchemeHandler(root: root, proxy: proxy)

        let webConfig = WKWebViewConfiguration()
        webConfig.setURLSchemeHandler(handler, forURLScheme: AppSchemeHandler.scheme)
        let webView = await WKWebView(frame: .zero, configuration: webConfig)
        let loaded = expectation(description: "loaded")
        let delegate = LoadDelegate { loaded.fulfill() }
        await MainActor.run { webView.navigationDelegate = delegate }
        _ = await webView.load(URLRequest(url: URL(string: "opencode-rc://localhost/")!))
        await fulfillment(of: [loaded], timeout: 10)

        let result = try await webView.callAsyncJavaScript(
            "const r = await fetch('/__server/api/x?y=1', {method: 'POST', headers: {authorization: 'Bearer t'}, body: 'hello'}); return await r.text()",
            contentWorld: .page)
        XCTAssertEqual(result as? String, "echo:hello")
        XCTAssertEqual(EchoProtocol.lastRequest?.url?.absoluteString, "https://rc.example.com/api/x?y=1")
        XCTAssertEqual(EchoProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(EchoProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer t")
    }
}

final class LoadDelegate: NSObject, WKNavigationDelegate {
    let done: () -> Void
    init(_ done: @escaping () -> Void) { self.done = done }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
}
