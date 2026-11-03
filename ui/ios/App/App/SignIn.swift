import SafariServices
import UIKit

/// Sign-in in an SFSafariViewController (ui/src/auth.ts nativeLogin). It counts as Safari, so a
/// per-app VPN's Safari Domains apply to it; only the IdP loads in it. The IdP redirects to
/// com.opencode.rc:/auth/callback, which iOS hands to SceneDelegate, which calls handle(_:).
/// Every start gets exactly one completion: the callback, cancelled (Done, swipe-down, a newer
/// sign-in) or failed (bad URL, nothing to present from).
///
/// Only one present or dismiss runs at a time. A start during one only replaces the wanted view;
/// when the transition ends, sync() closes what is up and shows the current view, if any.
final class SignIn: NSObject, SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    /// Shows the view, then calls back with true; with false when it cannot be shown.
    typealias Present = (UIViewController, @escaping (Bool) -> Void) -> Void
    /// Closes the view (at once if it is not up), then calls back.
    typealias Dismiss = (UIViewController, @escaping () -> Void) -> Void

    private let present: Present
    private let dismiss: Dismiss
    private var completion: ((Result<String, BridgeError>) -> Void)?
    private var callbackScheme = ""
    /// The view of the pending sign-in.
    private var view: SFSafariViewController?
    /// The view on screen.
    private var shown: UIViewController?
    private var busy = false

    init(present: @escaping Present, dismiss: @escaping Dismiss) {
        self.present = present
        self.dismiss = dismiss
    }

    func start(url: URL, callbackScheme: String, completion: @escaping (Result<String, BridgeError>) -> Void) {
        finish(.failure(.cancelled("superseded by a new sign-in")))
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), !callbackScheme.isEmpty else {
            completion(.failure(.failed("bad sign-in URL")))
            return
        }
        self.completion = completion
        self.callbackScheme = callbackScheme.lowercased()
        let safari = SFSafariViewController(url: url)
        safari.delegate = self
        safari.dismissButtonStyle = .cancel
        safari.presentationController?.delegate = self
        view = safari
        sync()
    }

    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard completion != nil, url.scheme?.lowercased() == callbackScheme else { return false }
        finish(.success(url.absoluteString))
        return true
    }

    // Done button.
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        closedByUser(controller)
    }

    // Swipe-down of the sheet.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        closedByUser(presentationController.presentedViewController)
    }

    // The view closed itself; only the current one ends the sign-in.
    private func closedByUser(_ controller: UIViewController) {
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

    /// Brings the screen to the wanted state, one transition at a time.
    private func sync() {
        guard !busy else { return }
        if let shown, shown !== view {
            busy = true
            dismiss(shown) { [weak self] in
                guard let self else { return }
                busy = false
                if self.shown === shown { self.shown = nil }
                sync()
            }
            return
        }
        guard shown == nil, let view else { return }
        busy = true
        present(view) { [weak self] ok in
            guard let self else { return }
            busy = false
            if ok {
                shown = view
            } else if self.view === view {
                finish(.failure(.failed("cannot show sign-in")))
                return
            }
            sync()
        }
    }
}
