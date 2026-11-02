import XCTest
@testable import App

final class NavigationPolicyTests: XCTestCase {
    func decide(_ s: String, main: Bool = true) -> NavigationDecision {
        NavigationPolicy.decide(url: URL(string: s), isMainFrame: main)
    }

    func testAllowsTheApp() {
        XCTAssertEqual(decide("opencode-rc://localhost/s/x"), .allow)
        XCTAssertEqual(decide("opencode-rc://localhost/", main: false), .allow)
    }

    func testOpensEverythingElseOutside() {
        XCTAssertEqual(decide("https://example.com/"), .openExternally)
        XCTAssertEqual(decide("http://example.com/"), .openExternally)
        XCTAssertEqual(decide("mailto:a@example.com"), .openExternally)
        XCTAssertEqual(decide("opencode-rc://other/"), .openExternally)
    }

    func testCancelsLocalOnlySchemesAtTheTop() {
        XCTAssertEqual(decide("about:blank"), .cancel)
        XCTAssertEqual(decide("blob:opencode-rc://localhost/1"), .cancel)
        XCTAssertEqual(decide("data:text/html,x"), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(url: nil, isMainFrame: true), .cancel)
    }

    func testSubframesStayInTheApp() {
        XCTAssertEqual(decide("https://example.com/", main: false), .cancel)
        XCTAssertEqual(decide("about:blank", main: false), .allow)
        XCTAssertEqual(decide("about:srcdoc", main: false), .allow)
    }
}
