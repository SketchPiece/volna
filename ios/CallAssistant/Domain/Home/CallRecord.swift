import Foundation

/// A finished conversation on the home screen: when, how long, a title and the whole transcript.
/// Kept only on the phone (`CallHistoryStore`); the core has its own transcripts for memory.
struct CallRecord: Equatable, Sendable, Identifiable, Codable {
    var id: UUID
    var startedAt: Date
    var duration: TimeInterval
    var title: String
    var lines: [TranscriptLine]

    /// The call that just ended, or nil when there is nothing to keep: a demo, a call never answered, no words.
    static func finished(_ state: CallState, at end: Date, id: UUID = UUID()) -> CallRecord? {
        guard !state.isDemo, let started = state.startedAt else { return nil }
        let lines = state.lines.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !lines.isEmpty else { return nil }
        return CallRecord(id: id, startedAt: started, duration: max(0, end.timeIntervalSince(started)), title: title(for: lines), lines: lines)
    }

    /// The owner's first real request: the first line of theirs with three words or more (a bare «привет» is skipped),
    /// else their first line, else Volna's first. One sentence, capitalised, at most `maxTitle` characters.
    static func title(for lines: [TranscriptLine]) -> String {
        let owner = lines.filter { $0.speaker == .you }.map(\.text)
        let source = owner.first { words($0) >= 3 } ?? owner.first ?? lines.first?.text ?? ""
        var text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if let end = text.firstIndex(where: { ".?!".contains($0) }), text.distance(from: text.startIndex, to: end) >= 12 {
            text = String(text[..<end])
        }
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:—-!?…"))
        if text.count > maxTitle {
            let cut = text.prefix(maxTitle)
            text = (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)) + "…"
        }
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    static let maxTitle = 60

    private static func words(_ text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace }).count
    }
}
