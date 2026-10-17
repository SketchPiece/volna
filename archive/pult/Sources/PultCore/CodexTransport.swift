import Foundation

/// How `CodexClient` reaches an app-server: its own child over stdio, or a shared server over WebSocket
/// (`CodexHost`, docs/mac-agent-hub.md, 2.1). Either way one JSON-RPC message is one line of text.
public protocol CodexTransport: AnyObject, Sendable {
    var lines: AsyncStream<String> { get }
    func open() async throws
    func send(line: String) throws
    func close()
}

/// `codex app-server` as a child process on stdio.
public final class StdioCodexTransport: CodexTransport, @unchecked Sendable {
    private let process: LineProcess
    public var lines: AsyncStream<String> { process.lines }

    public init(executable: String = "codex", arguments: [String] = ["app-server"], environment: [String: String] = [:]) {
        process = LineProcess(name: executable, arguments: arguments, environment: environment)
    }

    public func open() async throws { try process.start() }
    public func send(line: String) throws { try process.send(line: line) }
    public func close() { process.terminate() }
}

/// A shared app-server on `ws://127.0.0.1:PORT`: every text frame is one JSON-RPC message.
public final class WebSocketCodexTransport: NSObject, CodexTransport, URLSessionWebSocketDelegate, @unchecked Sendable {
    public let url: URL
    public let lines: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var opened: CheckedContinuation<Void, Error>?
    private let lock = NSLock()

    public init(url: URL) {
        self.url = url
        var continuation: AsyncStream<String>.Continuation!
        lines = AsyncStream { continuation = $0 }
        self.continuation = continuation
        super.init()
    }

    public func open() async throws {
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        // A long turn sends large frames (thread/resume history); the default 1 MB is too small.
        task.maximumMessageSize = 64 * 1024 * 1024
        self.session = session
        self.task = task
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.withLock { opened = continuation }
            task.resume()
        }
        receive()
    }

    public func send(line: String) throws {
        guard let task, task.state == .running else { throw CodexHostError.notConnected }
        task.send(.string(line)) { [weak self] error in
            if error != nil { self?.close() }
        }
    }

    public func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        finishOpen(with: CodexHostError.notConnected)
        continuation.finish()
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let text)):
                self.continuation.yield(text)
                self.receive()
            case .success(.data(let data)):
                self.continuation.yield(String(decoding: data, as: UTF8.self))
                self.receive()
            case .success:
                self.receive()
            case .failure:
                self.close()
            }
        }
    }

    private func finishOpen(with error: Error?) {
        let waiting = lock.withLock { () -> CheckedContinuation<Void, Error>? in defer { opened = nil }; return opened }
        if let error { waiting?.resume(throwing: error) } else { waiting?.resume() }
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        finishOpen(with: nil)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finishOpen(with: error ?? CodexHostError.notConnected)
        continuation.finish()
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        continuation.finish()
    }
}
