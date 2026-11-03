import SafariServices
import XCTest
@testable import App

/// The fake screen works like UIKit: one transition at a time, nothing is presented over a view
/// that is up, and closing a view that is not up completes at once.
final class SignInTests: XCTestCase {
    var presented: [UIViewController] = []
    var dismissed: [UIViewController] = []
    var onScreen: UIViewController?
    var transition: (() -> Void)?
    var canPresent = true
    var losePresents = false // present starts but never reports its end
    var timers: [() -> Void] = []
    lazy var signIn = SignIn(
        present: { view, done in
            guard self.canPresent else { return done(false) }
            if self.losePresents { self.presented.append(view); return }
            if self.onScreen != nil || self.transition != nil {
                XCTFail("presented while busy")
                return done(false)
            }
            self.presented.append(view)
            self.transition = { self.onScreen = view; done(true) }
        },
        dismiss: { view, done in
            guard view === self.onScreen else { return done() }
            XCTAssertNil(self.transition, "dismissed while busy")
            self.dismissed.append(view)
            self.transition = { self.onScreen = nil; done() }
        },
        watchdog: 10,
        after: { delay, run in XCTAssertEqual(delay, 10); self.timers.append(run) })

    /// Ends the running transitions.
    func settle() {
        while let t = transition { transition = nil; t() }
    }

    /// Starts a sign-in; returns its replies.
    func start(_ url: String) -> () -> [Result<String, BridgeError>] {
        var results: [Result<String, BridgeError>] = []
        signIn.start(url: URL(string: url)!, callbackScheme: "com.opencode.rc") { results.append($0) }
        return { results }
    }

    func codes(_ results: [Result<String, BridgeError>]) -> [String] {
        results.map { if case .failure(let e) = $0 { return e.code } else { return "ok" } }
    }

    func testResolvesWithTheCallbackAndClosesTheView() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "https://idp.example.com/authorize?x=1")!, callbackScheme: "com.opencode.rc") { result = $0 }
        settle()
        XCTAssertEqual(presented.count, 1)
        XCTAssertFalse(signIn.handle(URL(string: "other.scheme:/x")!))
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c&state=s")!))
        XCTAssertEqual(try? result?.get(), "com.opencode.rc:/auth/callback?code=c&state=s")
        settle()
        XCTAssertEqual(dismissed.count, 1)
        XCTAssertTrue(dismissed[0] === presented[0])
        XCTAssertNil(onScreen)
        XCTAssertFalse(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
    }

    func testDoneButtonCancels() {
        let a = start("https://idp.example.com/a")
        settle()
        onScreen = nil // Safari closes itself
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        settle()
        XCTAssertEqual(codes(a()), ["cancelled"])
        XCTAssertTrue(dismissed.isEmpty)
    }

    func testSwipeDownCancels() {
        let a = start("https://idp.example.com/a")
        settle()
        let controller = presented[0].presentationController!
        XCTAssertTrue(controller.delegate === signIn)
        onScreen = nil
        signIn.presentationControllerDidDismiss(controller)
        signIn.presentationControllerDidDismiss(controller)
        settle()
        XCTAssertEqual(codes(a()), ["cancelled"])
        XCTAssertTrue(dismissed.isEmpty)
    }

    func testANewSignInCancelsThePendingOneAndShowsAfterTheOldViewCloses() {
        let a = start("https://idp.example.com/a")
        settle()
        let b = start("https://idp.example.com/b")
        XCTAssertEqual(codes(a()), ["cancelled"])
        XCTAssertEqual(dismissed.count, 1)
        XCTAssertTrue(dismissed[0] === presented[0])
        XCTAssertEqual(presented.count, 1) // not while the old view is closing
        settle()
        XCTAssertEqual(presented.count, 2)
        XCTAssertTrue(onScreen === presented[1])
        // Late callbacks from the old view do not touch the new sign-in.
        signIn.safariViewControllerDidFinish(presented[0] as! SFSafariViewController)
        signIn.presentationControllerDidDismiss(presented[0].presentationController!)
        XCTAssertTrue(b().isEmpty)
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
        XCTAssertEqual(codes(b()), ["ok"])
        XCTAssertEqual(codes(a()), ["cancelled"])
    }

    func testThreeRapidStartsShowTheLast() {
        let a = start("https://idp.example.com/a")
        settle()
        let b = start("https://idp.example.com/b")
        let c = start("https://idp.example.com/c")
        XCTAssertEqual(codes(a()), ["cancelled"])
        XCTAssertEqual(codes(b()), ["cancelled"])
        XCTAssertEqual(presented.count, 1) // A is still closing
        settle()
        XCTAssertEqual(presented.count, 2) // A, then C; B never
        XCTAssertTrue(onScreen === presented[1])
        XCTAssertTrue(c().isEmpty)
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
        settle()
        XCTAssertEqual(codes(a()), ["cancelled"])
        XCTAssertEqual(codes(b()), ["cancelled"])
        XCTAssertEqual(codes(c()), ["ok"])
        XCTAssertNil(onScreen)
    }

    func testAStartWhileTheViewIsAppearingWaitsForIt() {
        let a = start("https://idp.example.com/a")
        let b = start("https://idp.example.com/b") // A's present is still running
        XCTAssertEqual(codes(a()), ["cancelled"])
        XCTAssertEqual(presented.count, 1)
        XCTAssertTrue(dismissed.isEmpty)
        settle()
        XCTAssertEqual(dismissed.count, 1)
        XCTAssertTrue(dismissed[0] === presented[0])
        XCTAssertEqual(presented.count, 2)
        XCTAssertTrue(onScreen === presented[1])
        XCTAssertTrue(b().isEmpty)
    }

    func testFailsWhenThereIsNothingToPresentFrom() {
        canPresent = false
        let a = start("https://idp.example.com/a")
        XCTAssertEqual(codes(a()), ["failed"])
        XCTAssertFalse(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
        XCTAssertEqual(codes(a()), ["failed"])
    }

    func testRefusesNonWebURLs() {
        var result: Result<String, BridgeError>?
        signIn.start(url: URL(string: "file:///etc/passwd")!, callbackScheme: "com.opencode.rc") { result = $0 }
        if case .failure(let e) = result { XCTAssertEqual(e.code, "failed") } else { XCTFail("not failed") }
        XCTAssertTrue(presented.isEmpty)
    }

    func testALostTransitionIsGivenUpByTheWatchdog() {
        losePresents = true
        let a = start("https://idp.example.com/a")
        XCTAssertEqual(presented.count, 1)
        losePresents = false
        let b = start("https://idp.example.com/b")
        XCTAssertEqual(codes(a()), ["cancelled"])
        XCTAssertEqual(presented.count, 1) // still waiting for A's present
        timers.forEach { $0() }
        XCTAssertEqual(presented.count, 2)
        settle()
        XCTAssertTrue(onScreen === presented[1])
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!))
        XCTAssertEqual(codes(b()), ["ok"])
        XCTAssertEqual(codes(a()), ["cancelled"])
    }

    func testAnOldWatchdogDoesNotEndANewerTransition() {
        let a = start("https://idp.example.com/a")
        settle()
        XCTAssertTrue(signIn.handle(URL(string: "com.opencode.rc:/auth/callback?code=c")!)) // A's dismiss starts
        XCTAssertEqual(timers.count, 2)
        timers[0]() // A's present watchdog: that transition already ended
        let b = start("https://idp.example.com/b")
        XCTAssertEqual(presented.count, 1) // B waits for A's dismiss ("presented while busy" otherwise)
        settle()
        XCTAssertEqual(presented.count, 2)
        XCTAssertTrue(onScreen === presented[1])
        timers.forEach { $0() } // all ended: no effect
        XCTAssertEqual(presented.count, 2)
        XCTAssertEqual(codes(a()), ["ok"])
        XCTAssertTrue(b().isEmpty)
    }
}
