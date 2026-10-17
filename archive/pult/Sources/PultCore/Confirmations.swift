import Foundation
import Security

/// A decision only the owner may take, with a tap on the phone or, for Astra's apps, in Pult's panel or the Codex app
/// (docs/design/volna-confirm.html, docs/mac-agent-hub.md, 2.1). Never by voice.
/// The model can cause one to appear but has no way to answer it: the answer comes through `POST /confirmations/{id}`,
/// which the bridge exposes only to the phone app.
public struct Confirmation: Equatable, Sendable, Identifiable {
    /// `trustFolder`: Claude Desktop asks to trust a folder. `computerApp`: Codex (Астра) asks to operate an app on the Mac
    /// for a computer job (`ComputerJobs`); approval holds for that job's thread only.
    public enum Kind: String, Sendable { case trustFolder = "trust_folder", computerApp = "computer_app" }
    public enum State: String, Sendable { case pending, working, approved, declined, expired, failed }

    public let id: String
    public let kind: Kind
    public let folder: String
    /// What happens after approval: the prompt Pult will send, or the computer job's task.
    public let prompt: String
    /// `computerApp`: the app's name as Codex shows it («Finder»).
    public var app: String?
    public let createdAt: Date
    public let expiresAt: Date
    public var state: State = .pending
    /// After approval: `sent` or `typed_only`; after a failure: why (`dialog_gone`, `press_failed`).
    public var result: String?
    /// `claude:<sessionId>` of the chat that was sent.
    public var sessionId: String?
    public var resolvedAt: Date?

    public var project: String { (folder as NSString).lastPathComponent }
}

/// What the center needs from the outside world: pressing the dialog's buttons. Tests supply a fake.
public struct ConfirmationOutcome: Equatable, Sendable {
    public var state: Confirmation.State
    public var result: String?
    public var sessionId: String?
    public init(state: Confirmation.State, result: String? = nil, sessionId: String? = nil) {
        self.state = state; self.result = result; self.sessionId = sessionId
    }
}

/// Holds open decisions for two minutes. An expired one declines itself so no dialog is left hanging on the Mac.
@MainActor
public final class ConfirmationCenter {
    public typealias Perform = @MainActor (Confirmation, _ approve: Bool) async -> ConfirmationOutcome

    public static let lifetime: TimeInterval = 120
    /// Resolved decisions stay visible this long so the phone can show how it ended.
    public static let keepResolved: TimeInterval = 30

    public private(set) var items: [Confirmation] = []
    private let perform: Perform
    private let now: () -> Date
    private var timers: [String: Task<Void, Never>] = [:]

    public init(now: @escaping () -> Date = Date.init, perform: @escaping Perform) {
        self.now = now
        self.perform = perform
    }

    /// A new decision. A folder trust replaces an older pending one for the same folder; app requests stand on their own.
    @discardableResult
    public func add(_ kind: Confirmation.Kind, folder: String, prompt: String, app: String? = nil) -> Confirmation {
        let created = now()
        for index in items.indices where kind == .trustFolder && items[index].kind == .trustFolder
            && items[index].folder == folder && items[index].state == .pending {
            items[index].state = .expired
            items[index].resolvedAt = created
            timers.removeValue(forKey: items[index].id)?.cancel()
        }
        var item = Confirmation(id: Self.randomId(), kind: kind, folder: folder, prompt: prompt,
                                createdAt: created, expiresAt: created.addingTimeInterval(Self.lifetime))
        item.app = app
        items.append(item)
        timers[item.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.lifetime))
            guard !Task.isCancelled else { return }
            await self?.expire(item.id)
        }
        PultLog.write("confirmation \(kind.rawValue) opened for \(app ?? item.project)")
        return item
    }

    /// Pending decisions and those resolved in the last `keepResolved` seconds, oldest first.
    public func visible() -> [Confirmation] {
        let current = now()
        items.removeAll { item in item.resolvedAt.map { current.timeIntervalSince($0) > Self.keepResolved } ?? false }
        return items
    }

    /// The owner's tap. Nil for an unknown id; an already answered decision comes back unchanged.
    public func decide(_ id: String, approve: Bool) async -> Confirmation? {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        guard items[index].state == .pending else { return items[index] }
        if now() >= items[index].expiresAt { await expire(id); return items.first { $0.id == id } }
        timers.removeValue(forKey: id)?.cancel()
        items[index].state = .working
        let outcome = await perform(items[index], approve)
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        items[index].state = outcome.state
        items[index].result = outcome.result
        items[index].sessionId = outcome.sessionId
        items[index].resolvedAt = now()
        PultLog.write("confirmation \(id.prefix(6)) \(approve ? "approved" : "declined") → \(outcome.state.rawValue) \(outcome.result ?? "")")
        return items[index]
    }

    /// Someone answered the underlying question elsewhere (the Codex app): the decision disappears from the phone and the panel.
    public func withdraw(_ id: String) {
        timers.removeValue(forKey: id)?.cancel()
        items.removeAll { $0.id == id }
        PultLog.write("confirmation \(id.prefix(6)) withdrawn: answered elsewhere")
    }

    private func expire(_ id: String) async {
        guard let index = items.firstIndex(where: { $0.id == id }), items[index].state == .pending else { return }
        timers.removeValue(forKey: id)
        items[index].state = .working
        _ = await perform(items[index], false)
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].state = .expired
        items[index].resolvedAt = now()
        PultLog.write("confirmation \(id.prefix(6)) expired")
    }

    static func randomId() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
