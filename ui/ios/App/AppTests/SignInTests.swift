import SafariServices
import XCTest
@testable import App

final class SignInTests: XCTestCase {
    var presented: [UIViewController] = []
    var dismissed: [UIViewController] = []
    var dismissDone: [() -> Void] = []
    var canPresent = true
    lazy var signIn = SignIn(
        present: { self.presented.append($0); return self.canPresent },
        dismiss: { self.dismissed.append($0); self.dismissDone.append($1) })

    /// Starts a sign-in and counts its replies.
    func start(_ url: String) -> (results: () -> [Result<String, BridgeError>], view: () -> UIViewController?) {
        var results: [Result<String, BridgeError>] = []
        let before = presented.count
        signIn.start(url: URL(string: url)!, callbackScheme: "com.opencode.rc") { results.append($0) }
        return ({ results }, { self.presented.count > before ? self.presented[before] : nil })
    }

    func code(_ results: [Result<String, BridgeError>]) -> [String] {
        results.map { if case .failure(let e) = $0 { return e.code } else { return "ok" } }
    }

    func testResolvesWithTheCallbackAndClosesTheView() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/authorize?x=1")!, callbackScheme: "com.opencode.rc") { result = $0 }
        XCTAssertEqual(presented.count, 1)
        XCTAssertFalse(signIn.handle(URL(string: "other.scheme:/x")!))
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c&state=s")!))
        XCTAssertEqual(try? result?.get(), "com.opencode.rc:/auth/callback?code=c&state=s")
        XCTAssertEqual(dismissed.count, 1)
        XCTAssertTrue(dismissed[0] === presented[0])
        XCTAssertFalse(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
    }

    func testDoneButtonCancels() {
        let a = start("https://idp.example.com/a")
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        XCTAssertEqual(code(a.results()), ["cancelled"])
        XCTAssertTrue(dismissed.isEmpty) // Safari closes itself
    }

    func testSwipeDownCancels() {
        let a = start("https://idp.example.com/a")
        let controller = presented[0].presentationController!
        XCTAssertTrue(controller.delegate === signIn)
        signIn.presentationControllerDidDismiss(controller)
        signIn.presentationControllerDidDismiss(controller)
        XCTAssertEqual(code(a.results()), ["cancelled"])
    }

    func testANewSignInCancelsThePendingOneAndShowsAfterTheOldViewCloses() {
        let a = start("https://idp.example.com/a")
        let b = start("https://idp.example.com/b")
        XCTAssertEqual(code(a.results()), ["cancelled"])
        XCTAssertEqual(dismissed.count, 1)
        XCTAssertTrue(dismissed[0] === presented[0])
        XCTAssertEqual(presented.count, 1) // not while the old view is closing
        dismissDone[0]()
        XCTAssertEqual(presented.count, 2)
        // Late callbacks from the old view do not touch the new sign-in.
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        signIn.presentationControllerDidDismiss(presented[0].presentationController!)
        XCTAssertTrue(b.results().isEmpty)
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
        XCTAssertEqual(code(b.results()), ["ok"])
        XCTAssertEqual(code(a.results()), ["cancelled"])
    }

    func testASignInAnsweredWhileTheOldViewClosesIsNotShown() {
        _ = start("https://idp.example.com/a")
        let b = start("https://idp.example.com/b")
        let c = start("https://idp.example.com/c")
        XCTAssertEqual(code(b.results()), ["cancelled"])
        dismissDone.forEach { $0() }
        XCTAssertEqual(presented.count, 2) // a and c, never b
        XCTAssertTrue(c.results().isEmpty)
    }

    func testFailsWhenThereIsNothingToPresentFrom() {
        canPresent = false
        let a = start("https://idp.example.com/a")
        XCTAssertEqual(code(a.results()), ["failed"])
        XCTAssertFalse(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
        XCTAssertEqual(code(a.results()), ["failed"])
    }

    func testRefusesNonWebURLs() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "file:///etc/passwd")!, callbackScheme: "com.opencode.rc") { result = $0 }
        if case .failure(let e) = result { XCTAssertEqual(e.code, "failed") } else { XCTFail("not failed") }
        XCTAssertTrue(presented.isEmpty)
    }
}
