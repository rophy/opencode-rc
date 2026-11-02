import WebKit

/// Forwards opencode-rc://localhost/__server/<path> to the configured server with URLSession and
/// streams the response back chunk by chunk, so SSE works. URLSession traffic is the app's own, so
/// a per-app VPN carries it. Only the one server origin is reachable; no cookies (bearer tokens).
final class ServerProxy: NSObject, URLSessionDataDelegate {
    static let prefix = "/__server"
    static var defaultConfiguration: URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        // SSE streams stay open; these are idle limits, as long as a WebView's.
        c.timeoutIntervalForRequest = 24 * 3600
        c.timeoutIntervalForResource = 7 * 24 * 3600
        return c
    }
    private static let dropped: Set<String> = ["origin", "host", "cookie", "content-length"]

    private(set) var server: URL?
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    private let configuration: URLSessionConfiguration
    private var schemeTasks: [Int: WKURLSchemeTask] = [:]   // URLSessionTask id → scheme task
    private var stopped = Set<ObjectIdentifier>()

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

    func start(_ task: WKURLSchemeTask) {
        guard let url = task.request.url, let server, let target = ServerProxy.target(for: url, server: server) else {
            fail(task, status: 502)
            return
        }
        var request = URLRequest(url: target)
        request.httpMethod = task.request.httpMethod ?? "GET"
        for (k, v) in ServerProxy.forwardedHeaders(task.request.allHTTPHeaderFields ?? [:]) {
            request.setValue(v, forHTTPHeaderField: k)
        }
        request.httpBody = ServerProxy.body(of: task.request)
        let dataTask = session.dataTask(with: request)
        schemeTasks[dataTask.taskIdentifier] = task
        dataTask.resume()
    }

    func stop(_ task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
        for (id, t) in schemeTasks where t === task {
            schemeTasks[id] = nil
            session.getAllTasks { $0.first { $0.taskIdentifier == id }?.cancel() }
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
        guard let task = schemeTasks[id], !stopped.contains(ObjectIdentifier(task)) else { return nil }
        return task
    }

    private func fail(_ task: WKURLSchemeTask, status: Int) {
        guard let url = task.request.url else { return }
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!)
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
            schemeTasks[task.taskIdentifier] = nil
            fail(schemeTask, status: 502)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let schemeTask = live(dataTask.taskIdentifier), let url = schemeTask.request.url,
              let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields { if let k = k as? String, let v = v as? String { headers[k] = v } }
        schemeTask.didReceive(HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        live(dataTask.taskIdentifier)?.didReceive(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let schemeTask = live(task.taskIdentifier) else { return }
        schemeTasks[task.taskIdentifier] = nil
        if let error { schemeTask.didFailWithError(error) } else { schemeTask.didFinish() }
    }
}
