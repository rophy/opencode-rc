import Foundation

enum NavigationDecision: Equatable {
    case allow, openExternally, cancel
}

/// What the main WebView may load: only the app. Other top-level loads open in Safari or the app
/// that owns the scheme; subframes may hold only the app or empty documents.
enum NavigationPolicy {
    static func decide(url: URL?, isMainFrame: Bool) -> NavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if scheme == AppSchemeHandler.scheme, url.host == "localhost" { return .allow }
        if !isMainFrame { return scheme == "about" ? .allow : .cancel }
        if ["about", "blob", "data", "javascript", "file"].contains(scheme) { return .cancel }
        return .openExternally
    }
}
