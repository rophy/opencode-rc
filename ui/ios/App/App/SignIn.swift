import SafariServices
import UIKit

/// Sign-in in an SFSafariViewController (ui/src/auth.ts nativeLogin). It counts as Safari, so a
/// per-app VPN's Safari Domains apply to it; only the IdP loads in it. The IdP redirects to
/// com.opencode.rc:/auth/callback, which iOS hands to SceneDelegate, which calls handle(_:).
/// Every start gets exactly one completion: the callback, cancelled (Done, swipe-down, a newer
/// sign-in) or failed (bad URL, nothing to present from).
///
/// Only one present or dismiss runs at a time. A start during one only replaces the wanted view;
/// when the transition ends, sync() closes what is up and shows the current view, if any. A
/// transition that never reports its end is given up after `watchdog` seconds, so it cannot block
/// later sign-ins.
final class SignIn: NSObject, SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
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
    private var view: SFSafariViewController?
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
