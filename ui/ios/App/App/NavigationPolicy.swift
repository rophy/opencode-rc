import Foundation

enum NavigationDecision: Equatable {
    case allow, openExternally, cancel
}

/// What the main WebView may load: only the app. Other top-level loads open in Safari or the app
/// that owns the scheme; subframes may hold only the app or empty documents.
enum NavigationPolicy {
    static func decide(url: URL?, isMainFrame: Bool) -> NavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if scheme == AppSchemeHandler.scheme, url.host == "localhost" {
            // Server responses are for fetch and XHR only: a page or frame loaded from the server
            // would run with the app's origin and its bridge.
            return isServerPath(url.path) ? .cancel : .allow
        }
        if !isMainFrame { return scheme == "about" ? .allow : .cancel }
        if ["about", "blob", "data", "javascript", "file"].contains(scheme) { return .cancel }
        return .openExternally
    }

    private static func isServerPath(_ path: String) -> Bool {
        path == ServerProxy.prefix || path.hasPrefix(ServerProxy.prefix + "/")
    }
}
