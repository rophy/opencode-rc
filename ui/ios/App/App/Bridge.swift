import WebKit

struct BridgeError: Error {
    let code: String
    let message: String
    static func failed(_ message: String) -> BridgeError { BridgeError(code: "failed", message: message) }
    static func cancelled(_ message: String) -> BridgeError { BridgeError(code: "cancelled", message: message) }
}

/// The JS ↔ native bridge (ui/src/native.ts). JS calls window.webkit.messageHandlers.rcNative
/// .postMessage({method, args}) and gets a promise; errors reach JS as "<code>: <message>".
/// Native events go to window.__rcNativeEmit(event, data). Only the app's main frame may call.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "rcNative"
    typealias Method = (_ args: [String: Any], _ reply: @escaping (Result<Any?, BridgeError>) -> Void) -> Void
    private var methods: [String: Method] = [:]
    weak var webView: WKWebView?

    func register(_ name: String, _ method: @escaping Method) {
        methods[name] = method
    }

    static func accepts(isMainFrame: Bool, scheme: String, host: String) -> Bool {
        isMainFrame && scheme == AppSchemeHandler.scheme && host == "localhost"
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard Bridge.accepts(isMainFrame: message.frameInfo.isMainFrame, scheme: origin.protocol, host: origin.host) else {
            NSLog("bridge: dropped a message from %@://%@", origin.protocol, origin.host)
            replyHandler(nil, "failed: not allowed")
            return
        }
        dispatch(body: message.body, replyHandler: replyHandler)
    }

    func dispatch(body: Any, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = body as? [String: Any], let name = body["method"] as? String else {
            replyHandler(nil, "failed: bad message")
            return
        }
        guard let method = methods[name] else {
            replyHandler(nil, "failed: unknown method \(name)")
            return
        }
        method(body["args"] as? [String: Any] ?? [:]) { result in
            switch result {
            case .success(let value): replyHandler(value, nil)
            case .failure(let error): replyHandler(nil, "\(error.code): \(error.message)")
            }
        }
    }

    func emit(_ event: String, _ data: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: ["event": event, "data": data]),
              let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("(m => window.__rcNativeEmit && window.__rcNativeEmit(m.event, m.data))(\(text))")
    }
}
