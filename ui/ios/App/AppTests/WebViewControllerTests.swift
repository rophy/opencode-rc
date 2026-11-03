import XCTest
import WebKit
@testable import App

final class ReloadSpyWebView: WKWebView {
    var reloads = 0
    override func reload() -> WKNavigation? {
        reloads += 1
        return nil
    }
}

@MainActor
final class WebViewControllerTests: XCTestCase {
    func testReloadsWhenTheWebContentProcessEnds() {
        let controller = WebViewController()
        let webView = ReloadSpyWebView(frame: .zero, configuration: WKWebViewConfiguration())
        controller.webViewWebContentProcessDidTerminate(webView)
        XCTAssertEqual(webView.reloads, 1)
    }

    // Not in a window: nothing to present from, so each panel is answered at once.
    // Calls the panels directly: WebKit never sets up a hand-made WKFrameInfo, and freeing one
    // crashed the test run on the iOS 26 simulator.
    func testDialogsWithNothingToPresentFromAreAnsweredAtOnce() {
        let controller = WebViewController()
        var alerted = false
        var confirmed: Bool?
        var prompted: String?? = .none
        controller.showAlert("a") { alerted = true }
        controller.showConfirm("c") { confirmed = $0 }
        controller.showPrompt("p", defaultText: "d") { prompted = .some($0) }
        XCTAssertTrue(alerted)
        XCTAssertEqual(confirmed, false)
        XCTAssertEqual(prompted, .some(nil))
    }
}
