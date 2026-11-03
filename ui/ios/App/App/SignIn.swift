import SafariServices
import UIKit

/// Sign-in in an SFSafariViewController (ui/src/auth.ts nativeLogin). It counts as Safari, so a
/// per-app VPN's Safari Domains apply to it; only the IdP loads in it. The IdP redirects to
/// com.opencode.rc:/auth/callback, which iOS hands to SceneDelegate, which calls handle(_:).
/// Every start gets exactly one completion: the callback, cancelled (Done, swipe-down, a newer
/// sign-in) or failed (bad URL, nothing to present from).
final class SignIn: NSObject, SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    /// Shows the view; false when there is nothing to present from.
    typealias Present = (UIViewController) -> Bool
    /// Closes the view, then calls the completion.
    typealias Dismiss = (UIViewController, @escaping () -> Void) -> Void

    private let present: Present
    private let dismiss: Dismiss
    private var completion: ((Result<String, BridgeError>) -> Void)?
    private var callbackScheme = ""
    private var view: SFSafariViewController?

    init(present: @escaping Present, dismiss: @escaping Dismiss) {
        self.present = present
        self.dismiss = dismiss
    }

    func start(url: URL, callbackScheme: String, completion: @escaping (Result<String, BridgeError>) -> Void) {
        // The pending sign-in is answered now; its view goes before the new one is shown, since
        // UIKit does not present while a dismiss is running.
        let old = view
        view = nil
        finish(.failure(.cancelled("superseded by a new sign-in")))
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), !callbackScheme.isEmpty else {
            if let old { dismiss(old) {} }
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
        let show = { [weak self] in
            guard let self, self.view === safari else { return } // answered while the old view closed
            if !self.present(safari) {
                self.view = nil
                self.finish(.failure(.failed("cannot show sign-in")))
            }
        }
        if let old { dismiss(old, show) } else { show() }
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

    private func closedByUser(_ controller: UIViewController) {
        guard let view, controller === view else { return }
        self.view = nil
        finish(.failure(.cancelled("sign-in cancelled")))
    }

    private func finish(_ result: Result<String, BridgeError>) {
        guard let completion else { return }
        self.completion = nil
        if let view {
            self.view = nil
            dismiss(view) {}
        }
        completion(result)
    }
}
