import UIKit
import WebKit

/// The app: one WKWebView showing the bundled web UI from opencode-rc://localhost. The WebView sits
/// in the safe area; external links open outside the app (NavigationPolicy).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let bridge = Bridge()
    let proxy = ServerProxy()
    var webView: WKWebView!
    private lazy var schemeHandler = AppSchemeHandler(root: Bundle.main.bundleURL.appendingPathComponent("public"), proxy: proxy)
    private lazy var sockets = WebSocketBridge(proxy: proxy, emit: { [weak bridge] e, d in bridge?.emit(e, d) })
    /// Sign-in views are presented from this controller (or what it already shows), never from a
    /// scene lookup that finds nothing while Control Center or a system alert is up.
    private(set) lazy var signIn = SignIn(
        present: { [weak self] view in
            guard let self, self.viewIfLoaded?.window != nil else { return false }
            var top: UIViewController = self
            while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
            top.present(view, animated: true)
            return true
        },
        dismiss: { view, done in
            guard view.presentingViewController != nil else { return done() }
            view.dismiss(animated: true, completion: done)
        })

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.name)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        bridge.webView = webView
        bridge.register("setServer") { [proxy] args, reply in
            do {
                try proxy.setServer(args["origin"] as? String ?? "")
                reply(.success(nil))
            } catch let error as BridgeError {
                reply(.failure(error))
            } catch {
                reply(.failure(.failed("bad server origin")))
            }
        }
        bridge.register("wsOpen") { [unowned self] args, reply in
            do {
                try sockets.open(id: args["id"] as? String ?? "", url: args["url"] as? String ?? "",
                                 protocols: args["protocols"] as? [String] ?? [])
                reply(.success(nil))
            } catch let error as BridgeError {
                reply(.failure(error))
            } catch {
                reply(.failure(.failed("socket failed")))
            }
        }
        bridge.register("wsSend") { [unowned self] args, reply in
            sockets.send(id: args["id"] as? String ?? "", text: args["text"] as? String, base64: args["base64"] as? String)
            reply(.success(nil))
        }
        bridge.register("wsClose") { [unowned self] args, reply in
            sockets.close(id: args["id"] as? String ?? "", code: args["code"] as? Int ?? 1000, reason: args["reason"] as? String ?? "")
            reply(.success(nil))
        }
        bridge.register("signIn") { [unowned self] args, reply in
            guard let url = URL(string: args["url"] as? String ?? "") else {
                reply(.failure(.failed("bad sign-in URL")))
                return
            }
            signIn.start(url: url, callbackScheme: args["callbackScheme"] as? String ?? "") { result in
                reply(result.map { ["url": $0] as Any? })
            }
        }

        let container = UIView()
        container.backgroundColor = .systemBackground
        container.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: URL(string: AppSchemeHandler.origin + "/")!))
    }

    private func handle(_ url: URL?, isMainFrame: Bool) -> WKNavigationActionPolicy {
        switch NavigationPolicy.decide(url: url, isMainFrame: isMainFrame) {
        case .allow: return .allow
        case .cancel: return .cancel
        case .openExternally:
            if let url { UIApplication.shared.open(url) }
            return .cancel
        }
    }

    // A new page load restarts the JS socket ids; the old page's sockets go.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        sockets.closeAll()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(handle(action.request.url, isMainFrame: action.targetFrame?.isMainFrame ?? true))
    }

    // target=_blank and window.open: never a second WebView.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if NavigationPolicy.decide(url: action.request.url, isMainFrame: true) == .openExternally,
           let url = action.request.url {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}
