import UIKit
import WebKit

/// Sign-in in a WKWebView sheet owned by the app (ui/src/auth.ts nativeLogin). Its traffic is the
/// app's, so a per-app VPN carries it, unlike Safari-based views, which reach only the VPN's Safari
/// Domains. The sheet opens the server's /auth/start; the server signs in at the IdP and redirects
/// to the callback scheme, which the sheet stops and returns. Every start gets exactly one
/// completion: the callback, cancelled (Cancel, swipe-down, a newer sign-in) or failed (bad URL, a
/// page that cannot load, nothing to present from).
///
/// Only one present or dismiss runs at a time. A start during one only replaces the wanted view;
/// when the transition ends, sync() closes what is up and shows the current view, if any. A
/// transition that never reports its end is given up after `watchdog` seconds, so it cannot block
/// later sign-ins.
final class SignIn: NSObject, UIAdaptivePresentationControllerDelegate {
    /// Shows the view, then calls back with true (at once if it is already up); with false when it
    /// cannot be shown.
    typealias Present = (UIViewController, @escaping (Bool) -> Void) -> Void
    /// Closes the view (at once if it is not up), then calls back.
    typealias Dismiss = (UIViewController, @escaping () -> Void) -> Void

    private let present: Present
    private let dismiss: Dismiss
    private var completion: ((Result<String, BridgeError>) -> Void)?
    private var callbackScheme = ""
    /// The view of the pending sign-in.
    private var view: SignInSheet?
    /// The view on screen.
    private var shown: UIViewController?
    /// The transition in flight, if any.
    private var inFlight: Int?
    private var transitions = 0
    private let watchdog: TimeInterval
    private let after: (TimeInterval, @escaping () -> Void) -> Void

    init(present: @escaping Present, dismiss: @escaping Dismiss, watchdog: TimeInterval = 10,
         after: @escaping (TimeInterval, @escaping () -> Void) -> Void = { delay, run in
             DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: run)
         }) {
        self.present = present
        self.dismiss = dismiss
        self.watchdog = watchdog
        self.after = after
    }

    func start(url: URL, callbackScheme: String, completion: @escaping (Result<String, BridgeError>) -> Void) {
        finish(.failure(.cancelled("superseded by a new sign-in")))
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), !callbackScheme.isEmpty else {
            completion(.failure(.failed("bad sign-in URL")))
            return
        }
        self.completion = completion
        self.callbackScheme = callbackScheme.lowercased()
        let sheet = SignInSheet(url: url, callbackScheme: self.callbackScheme)
        sheet.onEvent = { [weak self, weak sheet] event in
            guard let self, let sheet else { return }
            self.sheet(sheet, reported: event)
        }
        sheet.presentationController?.delegate = self
        view = sheet
        sync()
    }

    /// Ends the pending sign-in with the callback URL.
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard completion != nil, url.scheme?.lowercased() == callbackScheme else { return false }
        finish(.success(url.absoluteString))
        return true
    }

    /// What a sheet saw; only the current one ends the sign-in.
    func sheet(_ sheet: SignInSheet, reported event: SignInSheet.Event) {
        guard sheet === view else { return }
        switch event {
        case .callback(let url): handle(url)
        case .cancelled: finish(.failure(.cancelled("sign-in cancelled")))
        case .failed(let reason): finish(.failure(.failed(reason)))
        }
    }

    // Swipe-down of the sheet: it is already closed.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        let controller = presentationController.presentedViewController
        guard let view, controller === view else { return }
        if shown === view { shown = nil }
        finish(.failure(.cancelled("sign-in cancelled")))
    }

    private func finish(_ result: Result<String, BridgeError>) {
        guard let completion else { return }
        self.completion = nil
        view = nil
        completion(result)
        sync()
    }

    /// Brings the screen to the wanted state, one transition at a time. Completions always record
    /// what is on screen; a late one (after the watchdog) does not end a newer transition.
    private func sync() {
        guard inFlight == nil else { return }
        if let shown, shown !== view {
            let token = begin()
            dismiss(shown) { [weak self] in
                guard let self else { return }
                _ = end(token)
                if self.shown === shown { self.shown = nil }
                sync()
            }
            return
        }
        guard shown == nil, let view else { return }
        let token = begin()
        present(view) { [weak self] ok in
            guard let self else { return }
            let current = end(token)
            if ok {
                if shown == nil { shown = view }
            } else if current, self.view === view {
                finish(.failure(.failed("cannot show sign-in")))
                return
            }
            sync()
        }
    }

    private func begin() -> Int {
        transitions += 1
        let token = transitions
        inFlight = token
        after(watchdog) { [weak self] in
            guard let self, inFlight == token else { return }
            NSLog("sign-in: a transition did not end in %.0f s; going on", watchdog)
            inFlight = nil
            sync()
        }
        return token
    }

    /// Ends the transition; false when the watchdog already gave up on it.
    private func end(_ token: Int) -> Bool {
        guard inFlight == token else { return false }
        inFlight = nil
        return true
    }
}

/// The sign-in page: a WKWebView in a navigation controller with a Cancel button. It loads web
/// pages only (the server and whatever hosts the IdP uses), stops the navigation to the callback
/// scheme, and reports a page that cannot load, so the app shows its error instead of the sheet.
final class SignInSheet: UINavigationController, WKNavigationDelegate, WKUIDelegate {
    enum Event {
        case callback(URL)
        case cancelled
        case failed(String)
    }

    enum Decision: Equatable {
        case allow, callback, cancel
    }

    var onEvent: ((Event) -> Void)?
    private let startURL: URL
    private let callbackScheme: String
    private let page = UIViewController()
    private var webView: WKWebView!

    init(url: URL, callbackScheme: String) {
        startURL = url
        self.callbackScheme = callbackScheme
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        viewControllers = [page]
        page.navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
        page.navigationItem.title = url.host
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    static func decide(url: URL?, callbackScheme: String) -> Decision {
        guard let scheme = url?.scheme?.lowercased() else { return .cancel }
        if scheme == callbackScheme { return .callback }
        // Web pages only: never hand a link to another app from the sign-in sheet.
        return ["https", "http", "about", "data", "blob"].contains(scheme) ? .allow : .cancel
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        // The app's own store: the IdP session stays for later sign-ins in the app.
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        page.view = webView
        webView.load(URLRequest(url: startURL))
    }

    @objc private func cancelTapped() {
        onEvent?(.cancelled)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        switch SignInSheet.decide(url: url, callbackScheme: callbackScheme) {
        case .allow:
            decisionHandler(.allow)
        case .callback:
            decisionHandler(.cancel)
            if let url { onEvent?(.callback(url)) }
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    // An error page from the server (e.g. a wrong server URL) ends the sign-in with its status.
    // The IdP's own pages stay: the user may read them and cancel.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse,
           http.statusCode >= 400, http.url?.host == startURL.host {
            decisionHandler(.cancel)
            onEvent?(.failed("\(startURL.host ?? "the server") answered HTTP \(http.statusCode)"))
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        page.navigationItem.title = webView.url?.host
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

    private func failed(_ error: Error) {
        let nsError = error as NSError
        // Our own cancel of the callback navigation, or a load replaced by another one.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == WKErrorDomain && nsError.code == 102 { return } // frame load interrupted
        let host = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.host
        onEvent?(.failed(host.map { "\($0): \(nsError.localizedDescription)" } ?? nsError.localizedDescription))
    }
}
