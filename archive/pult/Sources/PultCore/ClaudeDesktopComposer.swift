import AppKit
import ApplicationServices

/// Starts a new Claude Desktop (Code) chat with the owner's dictated text and sends it.
///
/// Claude Desktop fills the composer from `claude://code/new?folder=…&q=…` but never sends a prompt that came by link
/// (it marks it unsafe). By the owner's decision of 22.09.2026 Pult presses Return itself through Accessibility, and only
/// after it has read the focused composer of the frontmost Claude window back and found exactly the dictated text.
/// Anything else leaves the chat filled in, unsent. Needs Accessibility for «Волна: Пульт» (Settings → Privacy & Security).
///
/// A folder Claude Desktop does not trust yet brings up «Trust this workspace?» with focus on Cancel. Pult never answers it
/// on its own: it reports `.needsTrust`, and only a tap on the phone (`ConfirmationCenter`) makes it press a button there.
@MainActor
public enum ClaudeDesktopComposer {
    public static let bundleId = "com.anthropic.claudefordesktop"

    public enum Outcome: Equatable, Sendable {
        case sent
        /// Claude Desktop asks whether to trust the folder; the chat waits behind the dialog.
        case needsTrust
        /// The chat is open with the text typed in; the reason says why Pult did not press Return.
        case filled(reason: String)
    }

    public static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Shows the system prompt that adds Pult to the Accessibility list.
    public static func requestTrust() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    public static func start(folder: String, prompt: String, autoSend: Bool, timeout: Duration = .seconds(8)) async -> Outcome? {
        guard let url = NewSessionLink.claude(folder: folder, prompt: prompt), NSWorkspace.shared.open(url) else { return nil }
        guard autoSend else { return .filled(reason: "auto_send_off") }
        guard isTrusted else { return .filled(reason: "no_accessibility") }
        return await sendWhenReady(folder: folder, prompt: prompt, timeout: timeout, stopAtTrustDialog: true)
    }

    /// Answers the trust dialog for `folder` after the owner decided on the phone. Nil when the dialog is gone.
    /// Approve presses «Trust workspace» and then sends the prompt the usual way; decline presses Cancel.
    public static func answerTrust(folder: String, prompt: String, approve: Bool) async -> Outcome? {
        guard isTrusted, let app = claudeApp(), let dialog = trustDialog(in: app.element, folder: folder) else { return nil }
        let button = approve ? dialog.trust : dialog.cancel
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { return .filled(reason: "press_failed") }
        guard approve else { return .filled(reason: "declined") }
        return await sendWhenReady(folder: folder, prompt: prompt, timeout: .seconds(8), stopAtTrustDialog: false)
    }

    /// Whether Claude Desktop shows the trust dialog for this folder right now.
    public static func isAskingTrust(folder: String) -> Bool {
        guard isTrusted, let app = claudeApp() else { return false }
        return trustDialog(in: app.element, folder: folder) != nil
    }

    /// Brings Claude forward, finds the composer holding exactly the prompt, focuses it and presses Return.
    /// Pult is a background app: after a tap on the phone nobody touched the Mac, so `NSRunningApplication.activate()`
    /// is ignored by macOS; the Accessibility attribute `AXFrontmost` still works. Observed 22.09.2026.
    private static func sendWhenReady(folder: String, prompt: String, timeout: Duration, stopAtTrustDialog: Bool) async -> Outcome {
        let expected = normalized(prompt)
        let deadline = ContinuousClock.now + timeout
        var seen = "no app"
        while ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(300))
            guard let app = claudeApp() else { continue }
            if stopAtTrustDialog, trustDialog(in: app.element, folder: folder) != nil { return .needsTrust }
            if !app.running.isActive { AXUIElementSetAttributeValue(app.element, kAXFrontmostAttribute as CFString, kCFBooleanTrue) }
            let focusedValue = composerText(app.element)
            if focusedValue.map(normalized) != expected, let field = field(holding: expected, in: app.element) {
                AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            let value = composerText(app.element)
            seen = "active=\(app.running.isActive) focused=\(value.map { "\($0.count) chars" } ?? "none") match=\(value.map(normalized) == expected)"
            guard app.running.isActive, let value, normalized(value) == expected else { continue }
            pressReturn(pid: app.running.processIdentifier)
            try? await Task.sleep(for: .milliseconds(700))
            if let after = composerText(app.element), normalized(after) == expected { return .filled(reason: "send_not_confirmed") }
            return .sent
        }
        PultLog.write("composer not ready after \(timeout): \(seen), prompt \(expected.count) chars")
        return .filled(reason: "composer_not_found")
    }

    /// An editable element anywhere in Claude's windows whose value is exactly the prompt.
    private static func field(holding expected: String, in app: AXUIElement) -> AXUIElement? {
        var queue: [AXUIElement] = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var visited = 0
        while !queue.isEmpty, visited < 6000 {
            let element = queue.removeFirst()
            visited += 1
            if let value = attribute(element, kAXValueAttribute) as? String, normalized(value) == expected,
               let role = attribute(element, kAXRoleAttribute) as? String,
               [kAXTextAreaRole as String, kAXTextFieldRole as String, "AXWebArea", "AXGroup"].contains(role) {
                return element
            }
            queue += (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        }
        return nil
    }

    /// Whitespace-insensitive form: the editor turns line breaks into paragraphs and may trim.
    nonisolated static func normalized(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    // MARK: - Accessibility

    private static func claudeApp() -> (running: NSRunningApplication, element: AXUIElement)? {
        guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return nil }
        let element = AXUIElementCreateApplication(running.processIdentifier)
        // Electron builds its accessibility tree only for clients that ask for it.
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        return (running, element)
    }

    private static func composerText(_ app: AXUIElement) -> String? {
        guard let focused = attribute(app, kAXFocusedUIElementAttribute).map({ $0 as! AXUIElement }) else { return nil }
        return attribute(focused, kAXValueAttribute) as? String
    }

    /// The dialog «Trust this workspace?» (Claude Desktop, observed 22.09.2026): its title, the folder path as its own text,
    /// and the buttons «Trust workspace» and «Cancel». All four must be there, otherwise it is not our dialog.
    private static func trustDialog(in app: AXUIElement, folder: String) -> (trust: AXUIElement, cancel: AXUIElement)? {
        var texts: [String] = []
        var buttons: [(String, AXUIElement)] = []
        var queue: [AXUIElement] = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var visited = 0
        while !queue.isEmpty, visited < 6000 {
            let element = queue.removeFirst()
            visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String
            let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
                .lazy.compactMap { attribute(element, $0) as? String }.first { !$0.isEmpty }
            if role == kAXButtonRole as String {
                buttons.append((label ?? childText(element) ?? "", element))
            } else if let label {
                texts.append(label)
            }
            queue += (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        }
        let target = (folder as NSString).standardizingPath
        guard texts.contains(where: { $0.contains("Trust this workspace?") }),
              texts.contains(where: { ($0.trimmingCharacters(in: .whitespaces) as NSString).standardizingPath == target }),
              let trust = buttons.first(where: { $0.0 == "Trust workspace" })?.1,
              let cancel = buttons.first(where: { $0.0 == "Cancel" })?.1 else { return nil }
        return (trust, cancel)
    }

    private static func childText(_ element: AXUIElement) -> String? {
        ((attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [])
            .lazy.compactMap { attribute($0, kAXValueAttribute) as? String ?? attribute($0, kAXTitleAttribute) as? String }.first
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    private static func pressReturn(pid: pid_t) {
        let returnKey: CGKeyCode = 36
        for down in [true, false] {
            CGEvent(keyboardEventSource: nil, virtualKey: returnKey, keyDown: down)?.postToPid(pid)
        }
    }
}
