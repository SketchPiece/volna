import SwiftUI
import AppKit
import UserNotifications
import PultCore

@main
struct PultApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            PanelView(hub: delegate.hub)
        } label: {
            MenuBarLabel(hub: delegate.hub)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(hub: delegate.hub)
        }
    }
}

struct MenuBarLabel: View {
    var hub: AgentHub
    /// The wave mark as a template image, so it follows the menu bar's light or dark appearance.
    private static let mark: NSImage? = {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("MenuBarIcon.png"), let image = NSImage(contentsOf: url) else { return nil }
        if let retina = Bundle.main.resourceURL.flatMap({ NSImage(contentsOf: $0.appendingPathComponent("MenuBarIcon@2x.png")) })?.representations.first {
            image.addRepresentation(retina)
        }
        image.isTemplate = true
        image.size = NSSize(width: 18, height: 18)
        return image
    }()

    var body: some View {
        let needs = hub.needsYou.count
        HStack(spacing: 3) {
            if let mark = Self.mark { Image(nsImage: mark) } else { Image(systemName: "waveform") }
            if needs > 0 { Text("\(needs)") }
        }
    }
}

/// Owns the hub, notification permissions and the notification click → deep link path.
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor let hub = AgentHub()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Theme.registerFonts()
        PultLog.write("Пульт запущен, bundle \(Bundle.main.bundleIdentifier ?? "-")")
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            PultLog.write("notifications: granted=\(granted) \(error.map { "\($0)" } ?? "")")
        }
        Task { @MainActor in
            hub.onChanges = { [weak self] changes in self?.notify(changes) }
            hub.update(settings: AppSettings.hubSettings())
            hub.start()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { hub.stop() }
        PultLog.write("Пульт остановлен")
    }

    @MainActor
    private func notify(_ changes: [HubChange]) {
        let settings = AppSettings.self
        for change in changes {
            let content = UNMutableNotificationContent()
            let session: HubSession
            switch change {
            case .needsYou(let s):
                guard settings.notifyNeedsYou else { continue }
                session = s
                content.title = "Ждёт тебя: \(s.name)"
                content.body = [s.origin.label, s.project, s.detail].compactMap { $0 }.joined(separator: " · ")
            case .finished(let s):
                guard settings.notifyFinished else { continue }
                session = s
                content.title = "Готово: \(s.name)"
                content.body = s.origin == .pult ? String((s.detail ?? "").prefix(200)) : [s.origin.label, s.project].joined(separator: " · ")
            case .failed(let s):
                guard settings.notifyFailed else { continue }
                session = s
                content.title = "Помехи: \(s.name)"
                content.body = s.origin == .pult ? String((s.detail ?? "").prefix(200)) : [s.origin.label, s.project].joined(separator: " · ")
            }
            content.sound = .default
            if let url = session.openURL { content.userInfo = ["open": url.absoluteString] }
            let request = UNNotificationRequest(identifier: session.id + ":" + UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request)
            PultLog.write("notify: \(content.title)")
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let open = response.notification.request.content.userInfo["open"] as? String, let url = URL(string: open) {
            NSWorkspace.shared.open(url)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

/// Persisted preferences. Kept as static accessors so the delegate and views read the same keys.
enum AppSettings {
    static let defaults = UserDefaults.standard
    static var notifyNeedsYou: Bool { defaults.object(forKey: "notifyNeedsYou") as? Bool ?? true }
    static var notifyFinished: Bool { defaults.object(forKey: "notifyFinished") as? Bool ?? true }
    static var notifyFailed: Bool { defaults.object(forKey: "notifyFailed") as? Bool ?? true }
    static var codexEnabled: Bool { defaults.object(forKey: "codexEnabled") as? Bool ?? true }
    static var codexDays: Int { defaults.object(forKey: "codexDays") as? Int ?? 3 }
    static var hookPort: Int { defaults.object(forKey: "hookPort") as? Int ?? 48611 }
    static var bridgeEnabled: Bool { defaults.object(forKey: "bridgeEnabled") as? Bool ?? true }
    static var bridgePort: Int { defaults.object(forKey: "bridgePort") as? Int ?? 48612 }
    static var claudeAutoSend: Bool { defaults.object(forKey: "claudeAutoSend") as? Bool ?? true }

    static func hubSettings() -> AgentHub.Settings {
        var settings = AgentHub.Settings()
        settings.codexEnabled = codexEnabled
        settings.codexDays = codexDays
        settings.hookPort = UInt16(clamping: hookPort)
        settings.bridgeEnabled = bridgeEnabled
        settings.bridgePort = UInt16(clamping: bridgePort)
        settings.claudeAutoSend = claudeAutoSend
        return settings
    }
}
