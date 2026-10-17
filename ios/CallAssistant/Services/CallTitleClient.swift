import Foundation

/// Asks the core to name a finished conversation (`POST /calls/title`, Luna reads the transcript).
/// Nil when the core is unreachable or has no model: the record keeps `CallRecord.title(for:)`.
struct CallTitleClient {
    var settings = ConnectionSettings()
    var session: URLSession = .shared

    func title(for lines: [TranscriptLine]) async -> String? {
        guard let base = try? settings.sessionURL().deletingLastPathComponent() else { return nil }
        var request = URLRequest(url: base.appendingPathComponent("calls/title"), timeoutInterval: 25)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let token = settings.token
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try? JSONEncoder().encode(Body(lines: lines.map { .init(speaker: $0.speaker.rawValue, text: $0.text) }))
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let title = try? JSONDecoder().decode(Answer.self, from: data).title.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty else { return nil }
        return String(title.prefix(CallRecord.maxTitle + 1))
    }

    private struct Body: Encodable {
        struct Line: Encodable { var speaker: String; var text: String }
        var lines: [Line]
    }
    private struct Answer: Decodable { var title: String }
}
