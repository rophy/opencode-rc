import WebKit

/// Forwards opencode-rc://localhost/__server/<path> to the configured server with URLSession and
/// streams the response back chunk by chunk, so SSE works. URLSession traffic is the app's own, so
/// a per-app VPN carries it. Only the one server origin is reachable; no cookies (bearer tokens).
/// A request the proxy cannot carry gets a 502 with `errorHeader`, and the reason as the body
/// (ui/src/auth.ts shows it at sign-in); WebKit would give JS only "Load failed".
final class ServerProxy: NSObject, URLSessionDataDelegate {
    static let prefix = "/__server"
    static let errorHeader = "X-OpenCode-RC-Proxy-Error"
    static var defaultConfiguration: URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        // SSE streams stay open: a request fails after 24 h with no data, and any request after 7 days.
        c.timeoutIntervalForRequest = 24 * 3600
        c.timeoutIntervalForResource = 7 * 24 * 3600
        return c
    }
    private static let dropped: Set<String> = ["origin", "host", "cookie", "content-length"]
    // URLSession has already decoded the body and read its framing.
    private static let droppedResponse: Set<String> = ["content-encoding", "content-length", "transfer-encoding"]

    private(set) var server: URL?
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    private let configuration: URLSessionConfiguration
    // URLSessionTask id → scheme task and its URLSession task; removed on stop, so later callbacks are ignored.
    private var tasks: [Int: (scheme: WKURLSchemeTask, data: URLSessionDataTask)] = [:]
    // URLSessionTask ids whose response went to WebKit: a later error can only end the load.
    private var responded: Set<Int> = []

    init(configuration: URLSessionConfiguration = ServerProxy.defaultConfiguration) {
        self.configuration = configuration
    }

    func setServer(_ origin: String) throws {
        guard let url = URL(string: origin), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host, url.path.isEmpty || url.path == "/", url.query == nil else {
            throw BridgeError.failed("bad server origin")
        }
        server = URL(string: "\(scheme)://\(host)\(url.port.map { ":\($0)" } ?? "")")
    }

    static func target(for url: URL, server: URL) -> URL? {
        guard url.path == prefix || url.path.hasPrefix(prefix + "/") else { return nil }
        var parts = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        let rest = String(url.path.dropFirst(prefix.count))
        parts.percentEncodedPath = rest.isEmpty ? "/" : (URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .percentEncodedPath.dropFirst(prefix.count)).map(String.init) ?? rest
        parts.percentEncodedQuery = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
        return parts.url
    }

    static func forwardedHeaders(_ headers: [String: String]) -> [String: String] {
        headers.filter { !dropped.contains($0.key.lowercased()) }
    }

    static func responseHeaders(_ headers: [AnyHashable: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in headers {
            if let k = k as? String, let v = v as? String, !droppedResponse.contains(k.lowercased()) { out[k] = v }
        }
        return out
    }

    func start(_ task: WKURLSchemeTask) {
        guard let url = task.request.url, let server, let target = ServerProxy.target(for: url, server: server) else {
            fail(task, reason: "no server set")
            return
        }
        var request = URLRequest(url: target, timeoutInterval: configuration.timeoutIntervalForRequest)
        request.httpMethod = task.request.httpMethod ?? "GET"
        for (k, v) in ServerProxy.forwardedHeaders(task.request.allHTTPHeaderFields ?? [:]) {
            request.setValue(v, forHTTPHeaderField: k)
        }
        request.httpBody = ServerProxy.body(of: task.request)
        let dataTask = session.dataTask(with: request)
        tasks[dataTask.taskIdentifier] = (task, dataTask)
        dataTask.resume()
    }

    func stop(_ task: WKURLSchemeTask) {
        for (id, t) in tasks where t.scheme === task {
            tasks[id] = nil
            t.data.cancel()
        }
    }

    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        var data = Data()
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }

    private func live(_ id: Int) -> WKURLSchemeTask? {
        tasks[id]?.scheme
    }

    private func fail(_ task: WKURLSchemeTask, reason: String) {
        guard let url = task.request.url else { return }
        let body = Data(reason.utf8)
        task.didReceive(HTTPURLResponse(url: url, statusCode: 502, httpVersion: "HTTP/1.1", headerFields: [
            ServerProxy.errorHeader: "1", "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.count),
        ])!)
        task.didReceive(body)
        task.didFinish()
    }

    // A redirect to another origin is refused (502); same-origin redirects are followed.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let same = request.url?.scheme == server?.scheme && request.url?.host == server?.host && request.url?.port == server?.port
        if same { completionHandler(request); return }
        completionHandler(nil)
        task.cancel()
        if let schemeTask = live(task.taskIdentifier) {
            tasks[task.taskIdentifier] = nil
            fail(schemeTask, reason: "the server redirected to another origin")
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let schemeTask = live(dataTask.taskIdentifier), let url = schemeTask.request.url,
              let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        let headers = ServerProxy.responseHeaders(http.allHeaderFields)
        schemeTask.didReceive(HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!)
        responded.insert(dataTask.taskIdentifier)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        live(dataTask.taskIdentifier)?.didReceive(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let started = responded.remove(task.taskIdentifier) != nil
        guard let schemeTask = live(task.taskIdentifier) else { return }
        tasks[task.taskIdentifier] = nil
        if let error {
            if started { schemeTask.didFailWithError(error) } else { fail(schemeTask, reason: error.localizedDescription) }
        } else {
            schemeTask.didFinish()
        }
    }
}
