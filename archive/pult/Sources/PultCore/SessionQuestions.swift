import Foundation

/// A question a Claude session asked with `AskUserQuestion`, caught by the `PreToolUse` hook before the dialog shows.
/// The id is the hook's `tool_use_id`, so one question has one id wherever it is seen.
public struct SessionQuestion: Sendable, Equatable {
    public struct Option: Sendable, Equatable {
        public var label: String
        public var description: String?
    }

    public struct Item: Sendable, Equatable {
        public var question: String
        public var header: String?
        public var options: [Option]
        public var multiSelect: Bool
    }

    /// pending: held, Волна may answer; answered: the answer went to the session;
    /// passed: handed back, the session shows its own dialog (phone, Desktop); expired: nobody answered in time.
    public enum State: String, Sendable { case pending, answered, passed, expired }

    public var id: String
    public var sessionId: String
    public var cwd: String
    public var items: [Item]
    public var input: JSONValue
    public var state: State
    public var answers: [String: String]
    public var createdAt: Date
    public var expiresAt: Date

    /// Parses the hook body. Nil for anything but a well-formed AskUserQuestion call.
    public init?(hook payload: JSONValue, now: Date = Date(), wait: TimeInterval) {
        guard payload["tool_name"]?.string == "AskUserQuestion", let input = payload["tool_input"],
              let id = payload["tool_use_id"]?.string, !id.isEmpty, let rawItems = input["questions"]?.array, !rawItems.isEmpty else { return nil }
        var items: [Item] = []
        for raw in rawItems {
            guard let question = raw["question"]?.string, !question.isEmpty else { return nil }
            let options = (raw["options"]?.array ?? []).compactMap { option -> Option? in
                guard let label = option["label"]?.string, !label.isEmpty else { return nil }
                return Option(label: label, description: option["description"]?.string)
            }
            items.append(Item(question: question, header: raw["header"]?.string, options: options, multiSelect: raw["multiSelect"]?.bool ?? false))
        }
        self.id = id
        sessionId = payload["session_id"]?.string ?? ""
        cwd = payload["cwd"]?.string ?? ""
        self.items = items
        self.input = input
        state = .pending
        answers = [:]
        createdAt = now
        expiresAt = now.addingTimeInterval(wait)
    }

    /// The project folder name; a worktree under `.claude/worktrees/` belongs to the repo above it.
    public var project: String {
        let path = cwd.components(separatedBy: "/.claude/worktrees/").first ?? cwd
        return (path as NSString).lastPathComponent
    }

    /// What the PreToolUse hook returns: the call goes through with `answers` filled in, no dialog.
    public var hookOutput: JSONValue {
        var input = self.input.object ?? [:]
        input["answers"] = .object(answers.mapValues(JSONValue.string))
        return ["hookSpecificOutput": ["hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": .object(input)]]
    }
}

/// Why an answer was refused.
public enum QuestionAnswerError: Error, Equatable {
    case unknown
    case notPending(SessionQuestion.State)
    /// A question text that is not in this call, or no answer for one that is.
    case mismatch(String)
}

/// Holds session questions while Волна is on a call and hands them back otherwise.
///
/// Rule without guessing: the bridge polls `GET /questions?listen=1` only while a call is live; a question is held
/// only if such a poll came within `listenerWindow`. When the call ends, polls stop, and a held question goes back to the
/// session's own dialog within that window. No call at all: the hook returns at once and nothing changes for the session.
@MainActor
public final class QuestionDesk {
    /// How long one question may stay held. The hook's own timeout (`ClaudeHooksInstaller.askTimeout`) must be longer.
    public var wait: TimeInterval
    public var listenerWindow: TimeInterval
    public var tick: Duration
    public private(set) var questions: [SessionQuestion] = []
    public var onChange: (@MainActor () -> Void)?
    private var listenerSeen: Date?

    public init(wait: TimeInterval = 240, listenerWindow: TimeInterval = 8, tick: Duration = .milliseconds(250)) {
        self.wait = wait; self.listenerWindow = listenerWindow; self.tick = tick
    }

    public func heardListener(at now: Date = Date()) { listenerSeen = now }

    public func isListening(at now: Date = Date()) -> Bool {
        guard let listenerSeen else { return false }
        return now.timeIntervalSince(listenerSeen) <= listenerWindow
    }

    /// Pending first, then the latest resolved ones, so Волна can tell what became of a question.
    public func visible(limit: Int = 10) -> [SessionQuestion] {
        Array((questions.filter { $0.state == .pending } + questions.filter { $0.state != .pending }.reversed()).prefix(limit))
    }

    /// The hook's answer: the call with answers filled in, or nil to let the session ask as usual.
    public func ask(_ payload: JSONValue) async -> JSONValue? {
        guard isListening(), let question = SessionQuestion(hook: payload, wait: wait) else { return nil }
        if let index = questions.firstIndex(where: { $0.id == question.id }) { questions.remove(at: index) }
        questions.append(question)
        questions = Array(questions.suffix(30))
        PultLog.write("question held \(question.id.suffix(8)) from \(question.sessionId.prefix(8))")
        onChange?()
        while true {
            guard let current = questions.first(where: { $0.id == question.id }) else { return nil }
            switch current.state {
            case .answered: return current.hookOutput
            case .passed, .expired: return nil
            case .pending:
                if Date() >= current.expiresAt { resolve(question.id, .expired); return nil }
                if !isListening() { resolve(question.id, .passed); return nil }
            }
            try? await Task.sleep(for: tick)
        }
    }

    /// Answers by question text; a single-question call also takes `single` (the chosen label or free text).
    @discardableResult
    public func answer(_ id: String, answers given: [String: String] = [:], single: String? = nil) -> Result<SessionQuestion, QuestionAnswerError> {
        guard let index = questions.firstIndex(where: { $0.id == id }) else { return .failure(.unknown) }
        let question = questions[index]
        guard question.state == .pending else { return .failure(.notPending(question.state)) }
        var answers: [String: String] = [:]
        if let single = single?.trimmingCharacters(in: .whitespacesAndNewlines), !single.isEmpty {
            guard question.items.count == 1 else { return .failure(.mismatch("this call has \(question.items.count) questions; answer each by its text")) }
            answers[question.items[0].question] = single
        } else {
            for (text, value) in given {
                guard question.items.contains(where: { $0.question == text }) else { return .failure(.mismatch("no such question: \(text)")) }
                let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty { answers[text] = value }
            }
            if let missing = question.items.first(where: { answers[$0.question] == nil }) { return .failure(.mismatch("no answer for: \(missing.question)")) }
        }
        questions[index].answers = answers
        resolve(id, .answered)
        return .success(questions[index])
    }

    /// Owner wants to answer in the session itself: the dialog shows there.
    @discardableResult
    public func pass(_ id: String) -> Result<SessionQuestion, QuestionAnswerError> {
        guard let question = questions.first(where: { $0.id == id }) else { return .failure(.unknown) }
        guard question.state == .pending else { return .failure(.notPending(question.state)) }
        resolve(id, .passed)
        return .success(questions.first(where: { $0.id == id })!)
    }

    private func resolve(_ id: String, _ state: SessionQuestion.State) {
        guard let index = questions.firstIndex(where: { $0.id == id }), questions[index].state == .pending else { return }
        questions[index].state = state
        PultLog.write("question \(state.rawValue) \(id.suffix(8))")
        onChange?()
    }
}
