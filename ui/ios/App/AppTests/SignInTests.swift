import SafariServices
import XCTest
@testable import App

final class SignInTests: XCTestCase {
    var presented: [UIViewController] = []
    var dismissed: [UIViewController] = []
    lazy var signIn = SignIn(present: { self.presented.append($0) }, dismiss: { self.dismissed.append($0) })

    func testResolvesWithTheCallbackAndClosesTheView() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/authorize?x=1")!, callbackScheme: "com.opencode.rc") { result = $0 }
        XCTAssertEqual(presented.count, 1)
        XCTAssertFalse(signIn.handle(URL(string: "other.scheme:/x")!))
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c&state=s")!))
        XCTAssertEqual(try? result?.get(), "com.opencode.rc:/auth/callback?code=c&state=s")
        XCTAssertEqual(dismissed.count, 1)
        XCTAssertFalse(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
    }

    func testDoneButtonCancels() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/a")!, callbackScheme: "com.opencode.rc") { result = $0 }
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        if case .failure(let e) = result { XCTAssertEqual(e.code, "cancelled") } else { XCTFail("not cancelled") }
    }

    func testANewSignInCancelsThePendingOne() {
        var first: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/a")!, callbackScheme: "com.opencode.rc") { first = $0 }
        signIn.start(url: URL(string: "https://idp.example.com/b")!, callbackScheme: "com.opencode.rc") { _ in }
        if case .failure(let e) = first { XCTAssertEqual(e.code, "cancelled") } else { XCTFail("not cancelled") }
    }

    func testRefusesNonWebURLs() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "file:///etc/passwd")!, callbackScheme: "com.opencode.rc") { result = $0 }
        if case .failure(let e) = result { XCTAssertEqual(e.code, "failed") } else { XCTFail("not failed") }
        XCTAssertTrue(presented.isEmpty)
    }
}
