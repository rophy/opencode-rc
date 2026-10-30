import Capacitor
import UIKit
import WebKit

/// Signs in through a WKWebView in a sheet owned by the app. Unlike a Safari-based
/// sheet (ASWebAuthenticationSession), its traffic belongs to the app, so a per-app VPN
/// carries it. The sheet loads any host the IdP uses; the navigation to the callback
/// scheme is stopped and returned to JS. Swiping the sheet down cancels.
@objc(SystemAuthPlugin)
public class SystemAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SystemAuthPlugin"
    public let jsName = "SystemAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var sheet: SignInSheetController?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              let scheme = call.getString("callbackScheme"), !scheme.isEmpty else {
            call.reject("url and callbackScheme are required", "failed")
            return
        }
        DispatchQueue.main.async {
            if let previous = self.pendingCall {
                self.pendingCall = nil
                previous.reject("superseded by a new sign-in", "cancelled")
                self.sheet?.dismiss(animated: false)
                self.sheet = nil
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("could not start the sign-in session", "failed")
                return
            }
            self.pendingCall = call
            let sheet = SignInSheetController(url: url, callbackScheme: scheme) { [weak self] result in
                self?.finish(call, result)
            }
            self.sheet = sheet
            presenter.present(sheet, animated: true)
        }
    }

    private func finish(_ call: CAPPluginCall, _ result: SignInSheetController.Result) {
        guard pendingCall === call else { return }
        pendingCall = nil
        let sheet = self.sheet
        self.sheet = nil
        let settle = {
            switch result {
            case .callback(let url): call.resolve(["url": url.absoluteString])
            case .cancelled: call.reject("sign-in cancelled", "cancelled")
            case .failed(let message): call.reject(message, "failed")
            }
        }
        if let sheet = sheet, sheet.presentingViewController != nil {
            sheet.dismiss(animated: true, completion: settle)
        } else {
            settle()
        }
    }
}

final class SignInSheetController: UIViewController, WKNavigationDelegate, WKUIDelegate,
    UIAdaptivePresentationControllerDelegate {
    enum Result {
        case callback(URL)
        case cancelled
        case failed(String)
    }

    private let startURL: URL
    private let callbackScheme: String
    private var onResult: ((Result) -> Void)?
    private var webView: WKWebView!

    init(url: URL, callbackScheme: String, onResult: @escaping (Result) -> Void) {
        self.startURL = url
        self.callbackScheme = callbackScheme.lowercased()
        self.onResult = onResult
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        presentationController?.delegate = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func loadView() {
        let config = WKWebViewConfiguration()
        // The app's own store: the IdP session stays for later sign-ins in the app.
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: startURL))
    }

    private func report(_ result: Result) {
        guard let onResult = onResult else { return }
        self.onResult = nil
        webView.stopLoading()
        onResult(result)
    }

    // Swiping the sheet down.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        report(.cancelled)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        if scheme == callbackScheme {
            decisionHandler(.cancel)
            report(.callback(url))
            return
        }
        // Web pages only: never hand a link to another app from the sign-in sheet.
        decisionHandler(["https", "http", "about", "data", "blob"].contains(scheme) ? .allow : .cancel)
    }

    // Links that open a new window (target=_blank, window.open) load in the sheet.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil { webView.load(action.request) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    // A page that cannot load (no network, TLS) closes the sheet: the app then shows
    // its sign-in error instead of leaving the user on an error page.
    private func failed(_ error: Error) {
        let nsError = error as NSError
        // Our own cancel of the callback navigation, or a load replaced by another one.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == WKErrorDomain && nsError.code == 102 { return } // frame load interrupted
        report(.failed(nsError.localizedDescription))
    }
}
