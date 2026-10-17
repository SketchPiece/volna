import Foundation

/// A child process spoken to over newline-delimited text on stdin/stdout.
/// Both agents (`codex app-server`, `claude -p --input-format stream-json`) use exactly this shape.
public final class LineProcess: @unchecked Sendable {
    public let name: String
    public let arguments: [String]
    public private(set) var lines: AsyncStream<String>
    public private(set) var stderrLines: AsyncStream<String>

    private let process = Process()
    private let stdin = Pipe()
    private let stdout = Pipe()
    private let stderr = Pipe()
    private var linesContinuation: AsyncStream<String>.Continuation?
    private var stderrContinuation: AsyncStream<String>.Continuation?
    private let queue = DispatchQueue(label: "pult.line-process")
    private var stdoutBuffer = Data()
    private var stderrBuffer = Data()
    private var exitContinuations: [CheckedContinuation<Int32, Never>] = []
    private var exitStatus: Int32?

    public init(name: String, arguments: [String], currentDirectory: String? = nil, environment: [String: String] = [:]) {
        self.name = name
        self.arguments = arguments
        var continuation: AsyncStream<String>.Continuation?
        lines = AsyncStream { continuation = $0 }
        linesContinuation = continuation
        var errContinuation: AsyncStream<String>.Continuation?
        stderrLines = AsyncStream { errContinuation = $0 }
        stderrContinuation = errContinuation

        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [name] + arguments
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Executables.searchPath(base: env["PATH"])
        for (key, value) in environment { env[key] = value }
        process.environment = env
        if let currentDirectory { process.currentDirectoryURL = URL(fileURLWithPath: currentDirectory) }
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
    }

    public func start() throws {
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            self?.queue.async { self?.consume(data, isError: false) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            self?.queue.async { self?.consume(data, isError: true) }
        }
        process.terminationHandler = { [weak self] process in
            guard let self else { return }
            self.queue.async {
                self.stdout.fileHandleForReading.readabilityHandler = nil
                self.stderr.fileHandleForReading.readabilityHandler = nil
                self.flushTail()
                self.linesContinuation?.finish()
                self.stderrContinuation?.finish()
                self.exitStatus = process.terminationStatus
                let waiters = self.exitContinuations
                self.exitContinuations = []
                waiters.forEach { $0.resume(returning: process.terminationStatus) }
            }
        }
        try process.run()
    }

    public var processIdentifier: Int32 { process.processIdentifier }
    public var isRunning: Bool { process.isRunning }

    public func send(line: String) throws {
        guard process.isRunning else { throw LineProcessError.notRunning(name) }
        try stdin.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8))
    }

    public func closeInput() {
        try? stdin.fileHandleForWriting.close()
    }

    public func terminate() {
        guard process.isRunning else { return }
        process.terminate()
    }

    public func waitUntilExit() async -> Int32 {
        await withCheckedContinuation { continuation in
            queue.async {
                if let status = self.exitStatus { continuation.resume(returning: status) } else { self.exitContinuations.append(continuation) }
            }
        }
    }

    private func consume(_ data: Data, isError: Bool) {
        if data.isEmpty { return }
        if isError { stderrBuffer.append(data) } else { stdoutBuffer.append(data) }
        var buffer = isError ? stderrBuffer : stdoutBuffer
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newline]
            buffer = buffer[buffer.index(after: newline)...]
            let line = String(decoding: lineData, as: UTF8.self)
            if isError { stderrContinuation?.yield(line) } else { linesContinuation?.yield(line) }
        }
        if isError { stderrBuffer = Data(buffer) } else { stdoutBuffer = Data(buffer) }
    }

    private func flushTail() {
        if !stdoutBuffer.isEmpty { linesContinuation?.yield(String(decoding: stdoutBuffer, as: UTF8.self)); stdoutBuffer = Data() }
        if !stderrBuffer.isEmpty { stderrContinuation?.yield(String(decoding: stderrBuffer, as: UTF8.self)); stderrBuffer = Data() }
    }
}

public enum LineProcessError: Error, CustomStringConvertible {
    case notRunning(String)
    public var description: String {
        switch self { case .notRunning(let name): return "\(name) is not running" }
    }
}

/// Where the agent CLIs usually live when the app is launched from Finder (no shell PATH).
public enum Executables {
    public static func searchPath(base: String?) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        let existing = (base ?? "").split(separator: ":").map(String.init)
        return (existing + extra.filter { !existing.contains($0) }).joined(separator: ":")
    }

    /// Runs a CLI to completion and returns stdout. For short listing commands only.
    public static func run(_ name: String, _ arguments: [String], currentDirectory: String? = nil) async throws -> (status: Int32, stdout: String, stderr: String) {
        let process = LineProcess(name: name, arguments: arguments, currentDirectory: currentDirectory)
        try process.start()
        process.closeInput()
        async let out = collect(process.lines)
        async let err = collect(process.stderrLines)
        let status = await process.waitUntilExit()
        return (status, await out, await err)
    }

    private static func collect(_ stream: AsyncStream<String>) async -> String {
        var result: [String] = []
        for await line in stream { result.append(line) }
        return result.joined(separator: "\n")
    }
}
