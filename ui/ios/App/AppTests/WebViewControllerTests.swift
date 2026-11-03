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
    func testDialogsWithNothingToPresentFromAreAnsweredAtOnce() {
        let controller = WebViewController()
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        var alerted = false
        var confirmed: Bool?
        var prompted: String?? = .none
        controller.webView(webView, runJavaScriptAlertPanelWithMessage: "a", initiatedByFrame: WKFrameInfo()) { alerted = true }
        controller.webView(webView, runJavaScriptConfirmPanelWithMessage: "c", initiatedByFrame: WKFrameInfo()) { confirmed = $0 }
        controller.webView(webView, runJavaScriptTextInputPanelWithPrompt: "p", defaultText: "d", initiatedByFrame: WKFrameInfo()) { prompted = .some($0) }
        XCTAssertTrue(alerted)
        XCTAssertEqual(confirmed, false)
        XCTAssertEqual(prompted, .some(nil))
    }
}
