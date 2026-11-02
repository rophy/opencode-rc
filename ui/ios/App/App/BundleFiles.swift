import Foundation

/// Maps request paths to files in the bundled web UI (App/public).
enum BundleFiles {
    /// The file for a request path, or nil (404). A path whose last component has no extension and
    /// that matches no file is a directory or an SPA route: its index.html if there is one, else
    /// the index.html of its build (/v2/... for opencode 2.x, else the root).
    static func resolve(path: String, root: URL, fileExists: (URL) -> Bool = isFile) -> URL? {
        let decoded = path.removingPercentEncoding ?? path
        let base = root.standardizedFileURL
        let file = base.appendingPathComponent(decoded).standardizedFileURL
        guard file.path == base.path || file.path.hasPrefix(base.path + "/") else { return nil }
        if fileExists(file) { return file }
        guard file.pathExtension.isEmpty else { return nil }
        let index = file.appendingPathComponent("index.html")
        if fileExists(index) { return index }
        let v2 = base.appendingPathComponent("v2/index.html")
        if decoded.hasPrefix("/v2/"), fileExists(v2) { return v2 }
        return base.appendingPathComponent("index.html")
    }

    /// True for a regular file only: a directory is not something to serve.
    static func isFile(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && !isDir.boolValue
    }

    private static let types: [String: String] = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
        "json": "application/json", "map": "application/json", "svg": "image/svg+xml",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "ico": "image/x-icon",
        "webp": "image/webp", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf",
        "wasm": "application/wasm", "txt": "text/plain",
    ]

    static func mimeType(for url: URL) -> String {
        types[url.pathExtension.lowercased()] ?? "application/octet-stream"
    }
}
