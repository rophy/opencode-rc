import WebKit

/// Serves opencode-rc://localhost: the bundled web UI from App/public, and /__server/... through ServerProxy.
/// The WebView itself makes no network requests.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "opencode-rc"
    static let origin = "opencode-rc://localhost"
    let root: URL
    let proxy: ServerProxy

    init(root: URL, proxy: ServerProxy) {
        self.root = root
        self.proxy = proxy
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        if url.path == ServerProxy.prefix || url.path.hasPrefix(ServerProxy.prefix + "/") {
            proxy.start(task)
            return
        }
        guard let file = BundleFiles.resolve(path: url.path.isEmpty ? "/" : url.path, root: root),
              let data = try? Data(contentsOf: file) else {
            respond(task, url: url, status: 404, type: "text/plain", body: Data())
            return
        }
        respond(task, url: url, status: 200, type: BundleFiles.mimeType(for: file), body: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        proxy.stop(task)
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, body: Data) {
        let headers = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }
}
