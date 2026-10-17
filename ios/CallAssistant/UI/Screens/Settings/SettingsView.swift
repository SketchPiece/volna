import SwiftUI
import AVFAudio
import Intents

struct SettingsView: View {
    @ObservedObject private var siri = SiriInvocation.shared
    @ObservedObject var call: CallCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = ConnectionSettings().endpoint
    @State private var token = ConnectionSettings().token
    @State private var voice = ConnectionSettings().voice
    @State private var message: String?
    @State private var checking = false
    @State private var showVoices = false
    @State private var showMemory = false
    @State private var debugMode = MemoryPreferences().debugMode
    @State private var homeMode = HomePreferences().mode
    @State private var firstRun = HomePreferences().showsFirstRun
    @State private var waitMusic = ConnectionSettings().waitMusic
    @State private var serverLamp: LampState = .off
    @State private var micStatus = Self.microphoneStatus()
    @State private var siriStatus = Self.siriStatus()
    @State private var phoneAccess: [DevicePermission: DevicePermissionStatus] = Self.readPhoneAccess()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    conversationGroup
                    homeGroup
                    permissionsGroup
                    siriGroup
                    developmentGroup
                    if debugMode { connectionGroup }
                    Text(Self.versionLabel)
                        .font(Wave.Fonts.foot).tracking(1.3).foregroundStyle(Wave.Palette.ink2)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .background(Wave.Palette.ivory.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Настройки").font(Wave.Fonts.brand).foregroundStyle(Wave.Palette.bakelite) }
                // iOS 26 wraps toolbar buttons in a glass pill; the design system wants plain signal text here.
                if #available(iOS 26.0, *) {
                    ToolbarItem(placement: .confirmationAction) { doneButton }.sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .confirmationAction) { doneButton }
                }
            }
            .toolbarBackground(Wave.Palette.ivory, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $showVoices) { VoicePickerView(voice: $voice, disabled: call.active) }
            .navigationDestination(isPresented: $showMemory) { MemoryView(callActive: call.active) }
            .onChange(of: voice) { _, newValue in
                var settings = ConnectionSettings()
                settings.voice = newValue
            }
        }
        .tint(Wave.Palette.signal)
    }

    private var doneButton: some View {
        Button("Готово") { do { try save(); dismiss() } catch { message = error.localizedDescription } }
            .font(Wave.Fonts.label).foregroundStyle(Wave.Palette.signal)
    }

    // MARK: - Groups

    private var chevron: some View {
        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Wave.Palette.ink2.opacity(0.55))
    }

    private var conversationGroup: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsGroup(header: "Разговор", shadow: .sm) {
                Button { showVoices = true } label: {
                    SettingsRow(title: "Голос") {
                        HStack(spacing: 8) {
                            Text(voice.title).font(Wave.Fonts.body(14)).foregroundStyle(Wave.Palette.ink2)
                            chevron
                        }
                    }
                }
                .buttonStyle(PressableRowStyle())
                .accessibilityLabel("Голос")
                .accessibilityValue(voice.title)
                .accessibilityIdentifier("voicePicker")
                .disabled(call.active)
                RowDivider()
                Button { showMemory = true } label: {
                    SettingsRow(title: MemoryCopy.settingsRow, subtitle: MemoryCopy.settingsNote) { chevron }
                }
                .buttonStyle(PressableRowStyle())
                .accessibilityLabel(MemoryCopy.settingsRow)
                .accessibilityIdentifier("memory")
                RowDivider()
                SettingsRow(title: "Музыка в ожидании", tag: "эксперимент") {
                    Toggle("Музыка в ожидании", isOn: $waitMusic)
                        .labelsHidden().toggleStyle(WaveToggleStyle())
                        .accessibilityIdentifier("waitMusic")
                }
            }
            hint("Голос и музыка меняются со следующего звонка.")
        }
        .onChange(of: waitMusic) { _, on in
            var settings = ConnectionSettings()
            settings.waitMusic = on
        }
    }

    /// What the idle screen lists under the title (docs/design/canvas/home-idle, board «Д′»).
    private var homeGroup: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(HomeCopy.modeHeader.uppercased()).font(Wave.Fonts.status).tracking(1.3).foregroundStyle(Wave.Palette.ink2).padding(.leading, 20)
            HStack(spacing: 12) {
                ForEach(HomeMode.allCases, id: \.self) { mode in
                    SelectableRow(title: HomeCopy.modeTitle(mode), selected: homeMode == mode) {
                        homeMode = mode
                        var preferences = HomePreferences()
                        preferences.mode = mode
                    }
                    .accessibilityIdentifier("homeMode.\(mode.rawValue)")
                }
            }
        }
    }

    /// Microphone, Siri and the device tools (reminders, calendar, contacts) in one place.
    /// Device tools exist for the model only while the permission is granted here; the prompt is shown
    /// from this screen on purpose: nobody can answer it during a call from the lock screen.
    private var permissionsGroup: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsGroup(header: "Разрешения", shadow: .sm) {
                permissionRow(title: "Микрофон", status: micStatus, identifier: "access.microphone") {
                    _ = await Permissions.requestMicrophone()
                    micStatus = Self.microphoneStatus()
                }
                RowDivider()
                permissionRow(title: "Siri", status: siriStatus, identifier: "access.siri") {
                    _ = await Permissions.requestSiri()
                    SiriInvocation.shared.refresh()
                    siriStatus = Self.siriStatus()
                }
                RowDivider()
                devicePermissionRow(.reminders, title: "Напоминания")
                RowDivider()
                devicePermissionRow(.calendar, title: "Календарь")
                RowDivider()
                devicePermissionRow(.contacts, title: "Контакты")
            }
            hint("Без доступа Волна скажет, что не дотягивается до приложения.")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            phoneAccess = Self.readPhoneAccess()
            micStatus = Self.microphoneStatus()
            siriStatus = Self.siriStatus()
        }
    }

    private func devicePermissionRow(_ permission: DevicePermission, title: String) -> some View {
        permissionRow(title: title, status: phoneAccess[permission] ?? .undetermined, identifier: "access.\(permission.rawValue)") {
            _ = await Permissions.request(permission)
            phoneAccess = Self.readPhoneAccess()
        }
    }

    /// Granted: a quiet check. Not asked yet: a raised «Разрешить». Refused: a link to iOS Settings, the only place to lift it.
    private func permissionRow(title: String, status: DevicePermissionStatus, identifier: String, request: @escaping () async -> Void) -> some View {
        SettingsRow(title: title) {
            switch status {
            case .granted:
                Label("есть", systemImage: "checkmark")
                    .font(Wave.Fonts.body(14)).foregroundStyle(Wave.Palette.ink2)
                    .accessibilityLabel("\(title): разрешено")
            case .undetermined:
                Button("Разрешить") { Task { await request() } }
                    .buttonStyle(RaisedButtonStyle(compact: true))
                    .accessibilityLabel("Разрешить: \(title)")
            case .denied:
                Button { openSystemSettings() } label: {
                    HStack(spacing: 4) { Text("Настройки iOS"); Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)) }
                        .font(Wave.Fonts.body(14)).foregroundStyle(Wave.Palette.signal)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(title): открыть настройки iOS")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var siriGroup: some View {
        SettingsGroup(header: "Siri", shadow: .sm) {
            SettingsRow(title: "«Siri, \(siri.phrase)»", subtitle: siri.languageCode.isEmpty ? nil : "язык Siri: \(siri.languageCode.uppercased())") { EmptyView() }
        }
    }

    private var developmentGroup: some View {
        SettingsGroup(header: "Для разработки", shadow: .sm) {
            Button { call.preview(); dismiss() } label: {
                SettingsRow(title: "Демо звонка", subtitle: "без микрофона и расходов API") { chevron }
            }
            .buttonStyle(PressableRowStyle())
            .accessibilityIdentifier("preview")
            RowDivider()
            SettingsRow(title: "Режим отладки", subtitle: "ядро, замеры звонка, счётчики памяти") {
                Toggle("Режим отладки", isOn: $debugMode)
                    .labelsHidden().toggleStyle(WaveToggleStyle())
                    .accessibilityIdentifier("debugMode")
            }
            RowDivider()
            SettingsRow(title: "Главный экран с нуля", subtitle: "прячет разговоры и работу, ничего не удаляет") {
                Toggle("Главный экран с нуля", isOn: $firstRun)
                    .labelsHidden().toggleStyle(WaveToggleStyle())
                    .accessibilityIdentifier("homeFirstRun")
            }
            if debugMode, let latency = call.connectionTime {
                RowDivider()
                SettingsRow(title: "Последний звонок") {
                    Text(String(format: "%.1f с · %@", latency, call.launchSource)).font(Wave.Fonts.mono(12.5, .medium)).foregroundStyle(Wave.Palette.ink2)
                }
            }
        }
        .onChange(of: firstRun) { _, on in
            var preferences = HomePreferences()
            preferences.showsFirstRun = on
        }
        .onChange(of: debugMode) { _, on in
            var preferences = MemoryPreferences()
            preferences.debugMode = on
        }
    }

    private var connectionGroup: some View {
        SettingsGroup(header: "Ядро", shadow: .sm) {
            VStack(spacing: 10) {
                PressedField {
                    TextField("Адрес ядра", text: $endpoint)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(Wave.Fonts.mono(13.5))
                        .accessibilityIdentifier("serverURL")
                }
                PressedField {
                    SecureField("Токен (если задан)", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            RowDivider()
            SettingsRow(title: "Подключение") {
                HStack(spacing: 12) {
                    if serverLamp == .on { LampValue(text: "В эфире", lamp: .on) }
                    Button(checking ? "Проверяю…" : "Проверить") { Task { await check() } }
                        .buttonStyle(RaisedButtonStyle(compact: true))
                        .disabled(checking)
                        .accessibilityLabel("Проверить подключение")
                        .accessibilityIdentifier("checkConnection")
                }
            }
            if let message {
                RowDivider()
                SettingsNote(text: message).accessibilityIdentifier("connectionResult")
            }
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(Wave.Fonts.caption).foregroundStyle(Wave.Palette.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private static func readPhoneAccess() -> [DevicePermission: DevicePermissionStatus] {
        Dictionary(uniqueKeysWithValues: DevicePermission.allCases.map { ($0, Permissions.status(of: $0)) })
    }

    private static func microphoneStatus() -> DevicePermissionStatus {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        default: .undetermined
        }
    }

    private static func siriStatus() -> DevicePermissionStatus {
        switch INPreferences.siriAuthorizationStatus() {
        case .authorized: .granted
        case .denied, .restricted: .denied
        default: .undetermined
        }
    }

    private static var versionLabel: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "ВОЛНА \(version) · СБОРКА \(build)"
    }

    // MARK: - Actions

    private func save() throws {
        var settings = ConnectionSettings()
        let old = settings.endpoint
        settings.endpoint = endpoint
        do { _ = try settings.sessionURL(); try settings.saveToken(token) }
        catch { settings.endpoint = old; throw error }
    }
    private func check() async {
        checking = true; serverLamp = .off; defer { checking = false }
        do {
            try save()
            let url = try ConnectionSettings().sessionURL().deletingLastPathComponent().appendingPathComponent("health")
            let (data, response) = try await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 8))
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw VoiceError.message("Ядро вернуло неожиданный ответ.")
            }
            let ready = json["ready"] as? Bool == true
            serverLamp = ready ? .on : .off
            message = ready ? "Ядро доступно, ключи заданы. Доступ к модели проверится при звонке." : "Ядро доступно. Добавь OPENAI_API_KEY и OPEN_ROUTER_API_KEY в core/.env."
        } catch { message = error.localizedDescription }
    }
}
