import Foundation

/// HTTP к `/memory` ядра. Ничего не кэширует: память живёт только в ядре.
struct MemoryClient {
    var settings = ConnectionSettings()
    var session: URLSession = .shared

    func load() async throws -> MemorySnapshot { try await request("GET", "") }
    func setLevel(_ level: MemoryLevel) async throws -> MemorySnapshot {
        try await request("PUT", "settings", body: ["level": level.rawValue])
    }
    func setAllowSensitive(_ allowed: Bool) async throws -> MemorySnapshot {
        try await request("PUT", "settings", body: ["allowSensitive": allowed])
    }
    func forget(id: String) async throws -> MemorySnapshot { try await request("DELETE", "facts/\(id)") }
    func forgetCard(id: String) async throws -> MemorySnapshot { try await request("DELETE", "cards/\(id)") }
    func forgetAll() async throws -> MemorySnapshot { try await request("DELETE", "") }
    func deleteTechCard(id: String) async throws -> MemorySnapshot { try await request("DELETE", "techcards/\(id)") }
    func resetPersona() async throws -> MemorySnapshot { try await request("POST", "persona/reset") }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> MemorySnapshot {
        var url = try settings.sessionURL().deletingLastPathComponent().appendingPathComponent("memory")
        if !path.isEmpty { url.appendPathComponent(path) }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = method
        let token = settings.token
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw VoiceError.message(MemoryCopy.offline) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let error = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw VoiceError.message(error ?? "Ядро вернуло ошибку \(status).")
        }
        do { return try JSONDecoder().decode(MemorySnapshot.self, from: data) }
        catch { throw VoiceError.message("Ядро вернуло неожиданный ответ.") }
    }
}

/// Несекретные настройки памяти на телефоне: только для интерфейса, источник правды в ядре.
struct MemoryPreferences {
    /// Последний известный уровень для строки в настройках.
    var lastLevel: MemoryLevel? {
        get { MemoryLevel(rawValue: UserDefaults.standard.string(forKey: "memoryLevel") ?? "") }
        set { UserDefaults.standard.set(newValue?.rawValue, forKey: "memoryLevel") }
    }
    var debugMode: Bool {
        get { UserDefaults.standard.bool(forKey: "debugMode") }
        set { UserDefaults.standard.set(newValue, forKey: "debugMode") }
    }
    /// Снимки для дизайна: экран показывает демонстрационные данные без ядра.
    static var isPreviewRun: Bool { ProcessInfo.processInfo.arguments.contains("--memory-preview") }
}
