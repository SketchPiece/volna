import Foundation
import Security

/// GPT-Live voices, mirrored from `core/src/realtime/session.ts` (LIVE_VOICES). The core validates the header.
enum RealtimeVoice: String, CaseIterable, Identifiable {
    case meridian, stone, vesper, ripple, beacon, cinder, gleam, willow, quartz, delta, bossa, tempo

    static let `default`: RealtimeVoice = .meridian
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

struct ConnectionSettings {
    /// The cloud core (docs/railway.md); a Mac core is set in Settings → Debug → Core.
    static let defaultEndpoint = "https://your-core.example.com"

    #if DEBUG
    /// Used only when provisioning a development build over the trusted USB connection.
    static func configureFromDevelopmentEnvironment() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let endpoint = environment["CALL_ASSISTANT_BRIDGE_URL"],
              let token = environment["CALL_ASSISTANT_BRIDGE_TOKEN"], !token.isEmpty else { return }
        guard let url = URL(string: endpoint), let host = url.host, Self.allowsScheme(url.scheme, host: host),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw VoiceError.message("Адрес ядра для iPhone: HTTPS или http в локальной сети.")
        }
        var settings = ConnectionSettings()
        try settings.saveToken(token)
        settings.endpoint = endpoint
    }
    #endif

    var voice: RealtimeVoice {
        get { RealtimeVoice(rawValue: UserDefaults.standard.string(forKey: "realtimeVoice") ?? "") ?? .default }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "realtimeVoice") }
    }
    /// Experiment: own quiet tunes while work runs (`WaitMusic`); off by default. The core hears it in `X-Wait-Music`.
    var waitMusic: Bool {
        get { UserDefaults.standard.bool(forKey: "waitMusic") }
        set { UserDefaults.standard.set(newValue, forKey: "waitMusic") }
    }
    var endpoint: String {
        get { UserDefaults.standard.string(forKey: "bridgeURL") ?? Self.defaultEndpoint }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "bridgeURL") }
    }
    var token: String {
        get {
            var query = Self.keychainQuery
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var value: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
                  let data = value as? Data else { return "" }
            return String(decoding: data, as: UTF8.self)
        }
    }
    func saveToken(_ value: String) throws {
        SecItemDelete(Self.keychainQuery as CFDictionary)
        guard !value.isEmpty else { return }
        var query = Self.keychainQuery
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw VoiceError.message("Не удалось сохранить токен (\(status)).") }
    }
    func sessionURL() throws -> URL {
        guard let url = URL(string: endpoint), let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              Self.allowsScheme(url.scheme, host: host)
        else { throw VoiceError.message("Используйте HTTPS-адрес ядра или http-адрес Mac в локальной сети.") }
        return url.appendingPathComponent("session")
    }
    /// HTTPS везде; http только на этот же компьютер и в локальную сеть (Mac в той же Wi-Fi, docs/device-setup.md).
    static func allowsScheme(_ scheme: String?, host: String) -> Bool {
        scheme == "https" || (scheme == "http" && isLocalNetworkHost(host))
    }
    /// Loopback, имена Bonjour (`*.local`) и частные адреса IPv4. Всё прочее считается интернетом.
    static func isLocalNetworkHost(_ host: String) -> Bool {
        let host = host.lowercased()
        if ["localhost", "127.0.0.1", "::1"].contains(host) || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
        guard parts.count == 4, host.split(separator: ".").count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (10, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        default: return false
        }
    }
    private static var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "CallAssistant.bridge",
         kSecAttrAccount as String: "token"]
    }
}

enum VoiceError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(message) = self { return message }; return nil }
}

/// What the idle screen shows under the title (Settings → «Главный экран»).
struct HomePreferences {
    var mode: HomeMode {
        get { HomeMode(rawValue: UserDefaults.standard.string(forKey: "homeMode") ?? "") ?? .default }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "homeMode") }
    }
    /// Development: the home screen hides conversations and work, as on the first launch. Nothing is deleted.
    var showsFirstRun: Bool {
        get { UserDefaults.standard.bool(forKey: "homeFirstRun") }
        set { UserDefaults.standard.set(newValue, forKey: "homeFirstRun") }
    }
}
