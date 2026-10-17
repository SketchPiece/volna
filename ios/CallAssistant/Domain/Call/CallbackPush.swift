import Foundation

/// A VoIP push from the core: a background task finished and the owner asked Volna to call back.
/// Payload `{ "task": "<16 hex>", "title": "…" }` (core/src/tasks/delivery.ts). The task id goes back to the core
/// in `X-Callback-Task`, so the call opens with the task's result instead of the usual greeting.
struct CallbackPush: Equatable, Sendable {
    let taskID: String
    let title: String

    static func parse(_ payload: [AnyHashable: Any]) -> CallbackPush? {
        guard let id = payload["task"] as? String, id.count == 16,
              id.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        let title = (payload["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return CallbackPush(taskID: id, title: String(title.prefix(80)))
    }
}
