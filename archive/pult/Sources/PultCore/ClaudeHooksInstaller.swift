import Foundation

/// Adds or removes the HTTP hooks that make every Claude session on this machine report to Пульт.
/// Only touches entries whose URL carries the Пульт path; everything else in the file is preserved.
public enum ClaudeHooksInstaller {
    public static let events = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "Notification", "PermissionRequest"]
    public static let path = "/pult/hook"
    /// `PreToolUse` for `AskUserQuestion`: Пульт may hold the question for Волна (`QuestionDesk`) and answer it.
    public static let askPath = "/pult/ask"
    /// Seconds Claude Code waits for that hook; longer than `QuestionDesk.wait`, so Пульт always answers first.
    public static let askTimeout = 300

    public static var settingsURL: URL { ClaudeSessions.configDirectory.appendingPathComponent("settings.json") }

    public static func url(port: UInt16) -> String { "http://127.0.0.1:\(port)\(path)" }
    public static func askURL(port: UInt16) -> String { "http://127.0.0.1:\(port)\(askPath)" }

    public static func isInstalled(in settings: JSONValue, port: UInt16? = nil) -> Bool {
        guard let hooks = settings["hooks"]?.object else { return false }
        return hooks.values.contains { matchers in
            (matchers.array ?? []).contains { matcher in
                (matcher["hooks"]?.array ?? []).contains { isOurs($0, port: port) }
            }
        }
    }

    public static func install(port: UInt16, into settings: JSONValue) -> JSONValue {
        var root = settings.object ?? [:]
        var hooks = uninstall(from: settings)["hooks"]?.object ?? [:]
        for event in events {
            var matchers = hooks[event]?.array ?? []
            matchers.append(["hooks": [["type": "http", "url": .string(url(port: port)), "timeout": 3]]])
            hooks[event] = .array(matchers)
        }
        var pre = hooks["PreToolUse"]?.array ?? []
        pre.append(["matcher": "AskUserQuestion", "hooks": [["type": "http", "url": .string(askURL(port: port)), "timeout": .number(Double(askTimeout))]]])
        hooks["PreToolUse"] = .array(pre)
        root["hooks"] = .object(hooks)
        return .object(root)
    }

    public static func uninstall(from settings: JSONValue) -> JSONValue {
        var root = settings.object ?? [:]
        guard var hooks = root["hooks"]?.object else { return settings }
        for (event, matchers) in hooks {
            let kept = (matchers.array ?? []).compactMap { matcher -> JSONValue? in
                var m = matcher.object ?? [:]
                let handlers = (m["hooks"]?.array ?? []).filter { !isOurs($0, port: nil) }
                if handlers.isEmpty { return nil }
                m["hooks"] = .array(handlers)
                return .object(m)
            }
            if kept.isEmpty { hooks[event] = nil } else { hooks[event] = .array(kept) }
        }
        if hooks.isEmpty { root["hooks"] = nil } else { root["hooks"] = .object(hooks) }
        return .object(root)
    }

    /// Rewrites the user's settings file, keeping a backup copy next to it.
    public static func apply(installed: Bool, port: UInt16, at url: URL = settingsURL) throws {
        let data = (try? Data(contentsOf: url)) ?? Data("{}".utf8)
        let current = try JSONDecoder().decode(JSONValue.self, from: data)
        let next = installed ? install(port: port, into: current) : uninstall(from: current)
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: url.appendingPathExtension("pult-backup"))
            try FileManager.default.copyItem(at: url, to: url.appendingPathExtension("pult-backup"))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(next).write(to: url, options: .atomic)
        PultLog.write(installed ? "hooks installed on port \(port)" : "hooks removed")
    }

    /// Installed by an older Пульт: our hooks are there, the question hook is not.
    public static func lacksAskHook(in settings: JSONValue) -> Bool {
        guard isInstalled(in: settings) else { return false }
        return !(settings["hooks"]?["PreToolUse"]?.array ?? []).contains { matcher in
            (matcher["hooks"]?.array ?? []).contains { $0["url"]?.string?.hasSuffix(askPath) == true }
        }
    }

    public static func currentlyInstalled(at url: URL = settingsURL) -> Bool {
        guard let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return false }
        return isInstalled(in: value)
    }

    private static func isOurs(_ handler: JSONValue, port: UInt16?) -> Bool {
        guard handler["type"]?.string == "http", let url = handler["url"]?.string, url.hasSuffix(path) || url.hasSuffix(askPath) else { return false }
        if let port { return url == self.url(port: port) || url == askURL(port: port) }
        return true
    }
}
