import XCTest
@testable import App

final class BundleFilesTests: XCTestCase {
    let root = URL(fileURLWithPath: "/bundle/public")
    let files: Set<String> = ["/bundle/public/index.html", "/bundle/public/assets/a.js",
                              "/bundle/public/v2/index.html", "/bundle/public/v2/assets/b.css"]
    func resolve(_ path: String) -> String? {
        BundleFiles.resolve(path: path, root: root, fileExists: { self.files.contains($0.path) })?.path
    }

    func testServesFiles() {
        XCTAssertEqual(resolve("/assets/a.js"), "/bundle/public/assets/a.js")
        XCTAssertEqual(resolve("/"), "/bundle/public/index.html")
        XCTAssertEqual(resolve("/v2/"), "/bundle/public/v2/index.html")
    }

    func testFallsBackToTheBuildsIndexForRoutes() {
        XCTAssertEqual(resolve("/s/abc"), "/bundle/public/index.html")
        XCTAssertEqual(resolve("/v2/s/abc"), "/bundle/public/v2/index.html")
    }

    func testRoutesWithATrailingSlashGetTheBuildsIndex() {
        XCTAssertEqual(resolve("/s/abc/"), "/bundle/public/index.html")
        XCTAssertEqual(resolve("/v2/s/abc/"), "/bundle/public/v2/index.html")
    }

    func testDirectoriesAreNotFiles() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("v2/s"), withIntermediateDirectories: true)
        try Data().write(to: dir.appendingPathComponent("index.html"))
        try Data().write(to: dir.appendingPathComponent("v2/index.html"))
        let base = dir.standardizedFileURL.path
        XCTAssertEqual(BundleFiles.resolve(path: "/assets", root: dir)?.path, base + "/index.html")
        XCTAssertEqual(BundleFiles.resolve(path: "/v2", root: dir)?.path, base + "/v2/index.html")
        XCTAssertEqual(BundleFiles.resolve(path: "/v2/s", root: dir)?.path, base + "/v2/index.html")
    }

    func testMissingFilesWithAnExtensionAre404() {
        XCTAssertNil(resolve("/assets/missing.js"))
    }

    func testRejectsPathsOutsideTheBundle() {
        XCTAssertNil(resolve("/../secret.txt"))
        XCTAssertNil(resolve("/assets/../../secret.txt"))
        XCTAssertNil(resolve("/%2e%2e/secret.txt"))
    }

    func testMimeTypes() {
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.js")), "text/javascript")
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.wasm")), "application/wasm")
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.html")), "text/html")
        XCTAssertEqual(BundleFiles.mimeType(for: URL(fileURLWithPath: "/a.bin")), "application/octet-stream")
    }
}
