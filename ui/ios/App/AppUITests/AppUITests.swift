import XCTest

/// Launches the app and checks that the bundled web UI renders and responds to taps.
/// Assumes a build without a preset server (no OPENCODE_RC_CONFIG serverUrl).
final class AppUITests: XCTestCase {
    func testLaunchShowsSignInAndServerSettings() {
        let app = XCUIApplication()
        app.launch()
        // CI simulators are slow: the first render took about 20 s in a passing run.
        XCTAssertTrue(app.buttons["Sign in with OIDC"].waitForExistence(timeout: 90))
        app.buttons["Server settings"].tap()
        XCTAssertTrue(app.staticTexts["Connect to Server"].waitForExistence(timeout: 10))
    }
}
