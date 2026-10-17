import AppKit
import Foundation

public enum CodexHostError: Error, CustomStringConvertible {
    case noApp, serverDown, notConnected, appWontQuit
    public var description: String {
        switch self {
        case .noApp: return "приложение Codex не найдено"
        case .serverDown: return "сервер Codex не поднялся"
        case .notConnected: return "нет соединения с сервером Codex"
        case .appWontQuit: return "Codex не закрылся: возможно, он что-то спрашивает"
        }
    }
}

/// Is the Codex app on the shared server, so Astra's jobs show up in it live and its approval dialogs are answerable anywhere.
public enum CodexLink: String, Equatable, Sendable {
    /// ChatGPT.app is not installed.
    case noApp
    /// Pult could not start the shared server.
    case serverDown
    /// The server runs; the app is closed. Starting it through Pult links it.
    case appClosed
    /// The app runs on its own server: jobs work, but the app sees them only after the fact.
    case appOwnServer
    case linked

    public var label: String {
        switch self {
        case .noApp: return "Codex не установлен"
        case .serverDown: return "сервер Codex не запущен"
        case .appClosed: return "Codex закрыт"
        case .appOwnServer: return "Codex не подключён"
        case .linked: return "подключён"
        }
    }
}

/// The shared `codex app-server` Pult and ChatGPT.app both talk to (docs/mac-agent-hub.md, 2.1, checked 23.09.2026).
/// Pult starts the app's own bundled binary with the flags the app gives its private server, plus `--listen ws://127.0.0.1:PORT`,
/// and relaunches the app with `CODEX_APP_SERVER_WS_URL` pointing at it. The server is left running when Pult quits:
/// the app would lose its backend otherwise. On the next start Pult reuses it if it answers `/readyz`.
@MainActor
public final class CodexHost {
    public static let bundleId = "com.openai.codex"
    public static let urlVariable = "CODEX_APP_SERVER_WS_URL"
    public static let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/VolnaPult-codex.log")

    public let port: UInt16
    public var url: URL { URL(string: "ws://127.0.0.1:\(port)")! }
    public private(set) var link: CodexLink = .appClosed

    public init(port: UInt16 = 48613) { self.port = port }

    public static var appURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) }

    /// What the app starts its own server with (`ps` of ChatGPT.app 26.915), minus the per-launch tools pipe it alone can make.
    static func serverArguments(port: UInt16) -> [String] {
        ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled",
         "-c", "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
         "--listen", "ws://127.0.0.1:\(port)"]
    }

    static func serverEnvironment(app: URL) -> [String: String] {
        ["CODEX_INTERNAL_ORIGINATOR_OVERRIDE": "Codex",
         // Computer Use runs its REPL on the app's own node.
         "CODEX_MCP_NODE_PATH": app.appendingPathComponent("Contents/Resources/cua_node/bin/node").path]
    }

    /// Starts the server unless one already answers. True when it is ready.
    @discardableResult
    public func ensureServer() async -> Bool {
        if await ready() { return true }
        guard let app = Self.appURL else { link = .noApp; return false }
        let process = Process()
        process.executableURL = app.appendingPathComponent("Contents/Resources/codex")
        process.arguments = Self.serverArguments(port: port)
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = Executables.searchPath(base: environment["PATH"])
        Self.serverEnvironment(app: app).forEach { environment[$0] = $1 }
        process.environment = environment
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        if !FileManager.default.fileExists(atPath: Self.log.path) { FileManager.default.createFile(atPath: Self.log.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: Self.log) {
            _ = try? handle.seekToEnd()
            process.standardOutput = handle
            process.standardError = handle
        }
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch {
            PultLog.write("codex server failed to start: \(error)")
            link = .serverDown
            return false
        }
        PultLog.write("codex server started, pid \(process.processIdentifier), port \(port)")
        for _ in 0..<40 {
            try? await Task.sleep(for: .milliseconds(250))
            if await ready() { return true }
        }
        link = .serverDown
        return false
    }

    public func ready() async -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/readyz")!)
        request.timeoutInterval = 1.5
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    /// Looks at who holds a connection to the server: ChatGPT.app among them means the app is linked.
    @discardableResult
    public func refreshLink() async -> CodexLink {
        guard Self.appURL != nil else { link = .noApp; return link }
        guard await ready() else { link = .serverDown; return link }
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).isEmpty else { link = .appClosed; return link }
        let result = try? await Executables.run("lsof", ["-nP", "-iTCP:\(port)", "-sTCP:ESTABLISHED", "-Fpc"])
        link = Self.appConnected(lsof: result?.stdout ?? "") ? .linked : .appOwnServer
        return link
    }

    /// `lsof -F pc` prints `p<pid>` then `c<command>` per process.
    static func appConnected(lsof output: String) -> Bool {
        output.split(separator: "\n").contains { $0 == "cChatGPT" || $0 == "cCodex" }
    }

    /// Quits the app (like ⌘Q) and opens it again pointed at the shared server. Starts the server first if needed.
    public func relaunchApp() async throws {
        guard let app = Self.appURL else { link = .noApp; throw CodexHostError.noApp }
        guard await ensureServer() else { throw CodexHostError.serverDown }
        for running in NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId) { running.terminate() }
        for _ in 0..<60 where !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).isEmpty {
            try? await Task.sleep(for: .milliseconds(250))
        }
        guard NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).isEmpty else { throw CodexHostError.appWontQuit }
        let configuration = NSWorkspace.OpenConfiguration()
        var environment = ProcessInfo.processInfo.environment
        environment[Self.urlVariable] = url.absoluteString
        configuration.environment = environment
        configuration.activates = true
        _ = try await NSWorkspace.shared.openApplication(at: app, configuration: configuration)
        PultLog.write("codex app relaunched on \(url.absoluteString)")
        for _ in 0..<40 {
            try? await Task.sleep(for: .milliseconds(500))
            if await refreshLink() == .linked { return }
        }
    }
}
