import SafariServices
import UIKit

/// Sign-in in an SFSafariViewController (ui/src/auth.ts nativeLogin). It counts as Safari, so a
/// per-app VPN's Safari Domains apply to it; only the IdP loads in it. The IdP redirects to
/// com.opencode.rc:/auth/callback, which iOS hands to SceneDelegate, which calls handle(_:).
final class SignIn: NSObject, SFSafariViewControllerDelegate {
    static let shared = SignIn(
        present: { vc in UIApplication.shared.topViewController?.present(vc, animated: true) },
        dismiss: { vc in vc.dismiss(animated: true) })

    private let present: (UIViewController) -> Void
    private let dismiss: (UIViewController) -> Void
    private var completion: ((Result<String, BridgeError>) -> Void)?
    private var callbackScheme = ""
    private var view: SFSafariViewController?

    init(present: @escaping (UIViewController) -> Void, dismiss: @escaping (UIViewController) -> Void) {
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
        view = safari
        present(safari)
    }

    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard completion != nil, url.scheme?.lowercased() == callbackScheme else { return false }
        finish(.success(url.absoluteString))
        return true
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        view = nil
        finish(.failure(.cancelled("sign-in cancelled")))
    }

    private func finish(_ result: Result<String, BridgeError>) {
        guard let completion else { return }
        self.completion = nil
        if let view { dismiss(view) }
        view = nil
        completion(result)
    }
}

extension UIApplication {
    var topViewController: UIViewController? {
        let scene = connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
