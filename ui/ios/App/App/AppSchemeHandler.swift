import WebKit

/// Serves opencode-rc://localhost: the bundled web UI from App/public. (Task 8 adds /__server.)
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "opencode-rc"
    static let origin = "opencode-rc://localhost"
    let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        guard let file = BundleFiles.resolve(path: url.path.isEmpty ? "/" : url.path, root: root),
              let data = try? Data(contentsOf: file) else {
            respond(task, url: url, status: 404, type: "text/plain", body: Data())
            return
        }
        respond(task, url: url, status: 200, type: BundleFiles.mimeType(for: file), body: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, body: Data) {
        let headers = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }
}
