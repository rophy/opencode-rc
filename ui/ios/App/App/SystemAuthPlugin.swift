import AuthenticationServices
import Capacitor

/// Signs in through ASWebAuthenticationSession (RFC 8252). The session captures the
/// redirect to the app's callback scheme itself, so no URL-scheme routing is needed.
@objc(SystemAuthPlugin)
public class SystemAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "SystemAuthPlugin"
    public let jsName = "SystemAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    private var session: ASWebAuthenticationSession?
    private var pendingCall: CAPPluginCall?

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
                self.session?.cancel()
            }
            self.pendingCall = call
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callbackURL, error in
                guard let self = self, self.pendingCall === call else { return }
                self.pendingCall = nil
                self.session = nil
                if let callbackURL = callbackURL {
                    call.resolve(["url": callbackURL.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.reject("sign-in cancelled", "cancelled")
                } else {
                    call.reject(error?.localizedDescription ?? "sign-in failed", "failed")
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.pendingCall = nil
                self.session = nil
                call.reject("could not start the sign-in session", "failed")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
