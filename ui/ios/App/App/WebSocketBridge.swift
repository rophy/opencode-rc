import Foundation

/// WebSockets for the web UI (ui/src/native-transport.ts) through URLSessionWebSocketTask, so a
/// per-app VPN carries them. Only the server's ws(s) origin is reachable.
final class WebSocketBridge: NSObject, URLSessionWebSocketDelegate {
    private let proxy: ServerProxy
    private let emit: (String, [String: Any]) -> Void
    private lazy var session = URLSession(configuration: ServerProxy.defaultConfiguration, delegate: self, delegateQueue: .main)
    // JS id → task. Ids restart at every page load, so a navigation drops all sockets (closeAll).
    private(set) var sockets: [String: URLSessionWebSocketTask] = [:]
    private var ids: [Int: String] = [:]

    init(proxy: ServerProxy, emit: @escaping (String, [String: Any]) -> Void) {
        self.proxy = proxy
        self.emit = emit
    }

    static func allowed(_ url: URL, server: URL) -> Bool {
        let expected = server.scheme == "https" ? "wss" : "ws"
        return url.scheme == expected && url.host == server.host && url.port == server.port
    }

    func open(id: String, url: String, protocols: [String]) throws {
        guard let server = proxy.server, let target = URL(string: url), WebSocketBridge.allowed(target, server: server) else {
            throw BridgeError.failed("socket not allowed")
        }
        if let old = sockets.removeValue(forKey: id) {
            ids[old.taskIdentifier] = nil
            old.cancel(with: .goingAway, reason: nil)
        }
        let task = protocols.isEmpty ? session.webSocketTask(with: target) : session.webSocketTask(with: target, protocols: protocols)
        sockets[id] = task
        ids[task.taskIdentifier] = id
        receive(id, task)
        task.resume()
    }

    func send(id: String, text: String?, base64: String?) {
        guard let task = sockets[id] else { return }
        let message: URLSessionWebSocketTask.Message
        if let text { message = .string(text) }
        else if let base64, let data = Data(base64Encoded: base64) { message = .data(data) }
        else { return }
        task.send(message) { [weak self] error in
            if let error { self?.emit("ws.error", ["id": id, "message": error.localizedDescription]) }
        }
    }

    // Reports the close to JS at once (one ws.close), so later callbacks of the task are ignored:
    // URLSession may report a cancel as an error or not call didCloseWith at all.
    func close(id: String, code: Int, reason: String) {
        guard let task = sockets[id] else { return }
        finish(task, code: code, reason: reason, clean: true)
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure,
                    reason: reason.data(using: .utf8))
    }

    /// The page that owned the sockets is gone: cancel them all, with no events.
    func closeAll() {
        let tasks = Array(sockets.values)
        sockets.removeAll()
        ids.removeAll()
        for task in tasks { task.cancel(with: .goingAway, reason: nil) }
    }

    private func receive(_ id: String, _ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.sockets[id] === task else { return }
            switch result {
            case .success(.string(let text)): self.emit("ws.message", ["id": id, "text": text])
            case .success(.data(let data)): self.emit("ws.message", ["id": id, "base64": data.base64EncodedString()])
            case .success: break
            case .failure: return // didCompleteWithError reports it
            }
            self.receive(id, task)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard let id = ids[webSocketTask.taskIdentifier] else { return }
        emit("ws.open", ["id": id, "protocol": `protocol` ?? ""])
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(webSocketTask, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", clean: true)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else {
            let code = (task as? URLSessionWebSocketTask)?.closeCode.rawValue ?? 0
            finish(task, code: code == 0 ? 1005 : code, reason: "", clean: true)
            return
        }
        if let id = ids[task.taskIdentifier] { emit("ws.error", ["id": id, "message": error.localizedDescription]) }
        finish(task, code: 1006, reason: "", clean: false)
    }

    private func finish(_ task: URLSessionTask, code: Int, reason: String, clean: Bool) {
        guard let id = ids.removeValue(forKey: task.taskIdentifier) else { return }
        if sockets[id] === task { sockets[id] = nil }
        emit("ws.close", ["id": id, "code": code, "reason": reason, "wasClean": clean])
    }
}
