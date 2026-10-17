import SwiftUI
import AppKit
import PultCore

/// Everything the background panel needs configured, drawn in «Бакелит и лампа».
struct SettingsView: View {
    var hub: AgentHub
    @AppStorage("notifyNeedsYou") private var notifyNeedsYou = true
    @AppStorage("notifyFinished") private var notifyFinished = true
    @AppStorage("notifyFailed") private var notifyFailed = true
    @AppStorage("codexEnabled") private var codexEnabled = true
    @AppStorage("codexDays") private var codexDays = 3
    @AppStorage("hookPort") private var hookPort = 48611
    @AppStorage("bridgeEnabled") private var bridgeEnabled = true
    @AppStorage("bridgePort") private var bridgePort = 48612
    @AppStorage("claudeAutoSend") private var claudeAutoSend = true
    @State private var accessibilityTrusted = ClaudeDesktopComposer.isTrusted
    @State private var tokenCopied = false
    @State private var tokenError: String?
    @State private var hooksInstalled = ClaudeHooksInstaller.currentlyInstalled()
    @State private var hooksError: String?

    @State private var showAdvanced = false
    @State private var confirmRotate = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            group("УВЕДОМЛЯТЬ, КОГДА") {
                toggleRow("Сессия ждёт меня", $notifyNeedsYou)
                toggleRow("Ход завершён", $notifyFinished)
                toggleRow("Процесс упал", $notifyFailed)
            }
            group("ИСТОЧНИКИ", hint: hooksInstalled ? nil : "Без хуков Пульт узнаёт о Claude с опозданием до 8 секунд.") {
                row("Claude", note: claudeNote, mark: .claude) {
                    status(hub.claudeError != nil ? .off : hub.hookPort != nil && hooksInstalled ? .on : .dim,
                           hub.claudeError != nil ? "помехи" : hooksInstalled ? (hub.hookPort == nil ? "приёмник выключен" : "мгновенно") : "опрос")
                    toggle(Binding(get: { hooksInstalled }, set: { setHooks($0) }))
                }
                if let hooksError { errorLine(hooksError) }
                row("Codex", note: hub.codexError ?? hub.codexVersion.map { String($0.split(separator: " ").first ?? "") }, mark: .openAI) {
                    status(hub.codexError != nil ? .off : hub.codexVersion == nil ? .dim : .on,
                           hub.codexError != nil ? "помехи" : hub.codexVersion == nil ? "не запущен" : "в эфире")
                    toggle($codexEnabled)
                }
                if codexEnabled {
                    row("Треды Codex за") {
                        HStack(spacing: 8) {
                            Button { codexDays = max(1, codexDays - 1) } label: { Image(systemName: "minus") }.buttonStyle(RoundKeyStyle(size: 22))
                            Text("\(codexDays) дн.").font(Theme.mono(12)).frame(minWidth: 44)
                            Button { codexDays = min(30, codexDays + 1) } label: { Image(systemName: "plus") }.buttonStyle(RoundKeyStyle(size: 22))
                        }
                    }
                    .padding(.leading, 25)
                }
                // Astra's jobs are live in the Codex app only when it runs on Pult's shared server (CodexHost).
                row("Приложение Codex на сервере Пульта", note: hub.codexLinkError ?? "задания Астры видны в нём вживую") {
                    status(hub.codexLink == .linked ? .on : hub.codexLink == .noApp || hub.codexLink == .serverDown ? .off : .dim,
                           hub.codexRelinking ? "перезапуск…" : hub.codexLink.label)
                    if hub.codexLink != .linked && hub.codexLink != .noApp {
                        Button(hub.codexLink == .appClosed ? "Запустить" : "Подключить") { Task { await hub.relinkCodexApp() } }
                            .buttonStyle(RaisedButtonStyle()).disabled(hub.codexRelinking)
                    }
                }
                .padding(.leading, 25)
            }
            group("ВОЛНА") {
                row("Волна управляет Пультом", note: hub.bridgeError ?? hub.bridgePort.map { _ in "запросов \(hub.bridgeRequestCount)" }) {
                    status(hub.bridgeError != nil ? .off : hub.bridgePort == nil ? .dim : .on,
                           hub.bridgeError != nil ? "помехи" : hub.bridgePort == nil ? "выключено" : "подключена")
                    toggle($bridgeEnabled)
                }
                row("Токен для моста") {
                    Button(tokenCopied ? "Скопирован" : "Скопировать") { copyToken() }.buttonStyle(RaisedButtonStyle())
                }
                if let tokenError { errorLine(tokenError) }
                row("Отправлять новые чаты сам", note: "нажимает Return в Claude Desktop, нужен Универсальный доступ") {
                    if !accessibilityTrusted {
                        status(.off, "нет доступа")
                        Button("Разрешить") { ClaudeDesktopComposer.requestTrust() }.buttonStyle(RaisedButtonStyle())
                    }
                    toggle($claudeAutoSend)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Button { withAnimation(.easeOut(duration: 0.15)) { showAdvanced.toggle() } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).rotationEffect(.degrees(showAdvanced ? 90 : 0))
                        Text("ДОПОЛНИТЕЛЬНО").font(Theme.mono(10)).tracking(1.4)
                    }
                    .foregroundStyle(Theme.ink2).contentShape(Rectangle())
                }
                .buttonStyle(.plain).padding(.leading, 4)
                if showAdvanced {
                    card {
                        row("Порт хуков Claude") { portField($hookPort) }
                        row("Порт API для Волны") { portField($bridgePort) }
                        row("Сменить токен моста", note: "старый перестанет работать") {
                            Button("Сменить…") { confirmRotate = true }.buttonStyle(RaisedButtonStyle())
                        }
                        row("Журнал") {
                            Button("Открыть") { NSWorkspace.shared.open(PultLog.url) }.buttonStyle(RaisedButtonStyle())
                        }
                    }
                    hintLine("В server/.env моста: PULT_URL=http://127.0.0.1:\(String(bridgePort)) и PULT_TOKEN.")
                }
            }
            Text("ПУЛЬТ 0.1").font(Theme.mono(10)).tracking(1.4).foregroundStyle(Theme.ink2).padding(.leading, 4)
        }
        .padding(20)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.ivory)
        .foregroundStyle(Theme.bakelite)
        .navigationTitle("Волна: Пульт")
        .confirmationDialog("Сменить токен моста?", isPresented: $confirmRotate) {
            Button("Сменить", role: .destructive) { rotateToken() }
        } message: {
            Text("Мост перестанет достучаться до Пульта, пока в server/.env не будет новый PULT_TOKEN.")
        }
        .onChange(of: codexEnabled) { apply() }
        .onChange(of: codexDays) { apply() }
        .onChange(of: hookPort) { apply() }
        .onChange(of: bridgeEnabled) { apply() }
        .onChange(of: bridgePort) { apply() }
        .onChange(of: claudeAutoSend) { apply() }
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in accessibilityTrusted = ClaudeDesktopComposer.isTrusted }
    }

    private var claudeNote: String? {
        if let error = hub.claudeError { return error }
        return hooksInstalled ? "хуки · событий \(hub.hookEventCount)" : "опрос claude agents раз в 8 с"
    }

    @ViewBuilder
    private func group<Content: View>(_ title: String, hint: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Theme.mono(10)).tracking(1.4).foregroundStyle(Theme.ink2).padding(.leading, 4)
            card(content)
            if let hint { hintLine(hint) }
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        _VariadicCard(content: content())
    }

    private func hintLine(_ text: String) -> some View {
        Text(text).font(Theme.body(12)).foregroundStyle(Theme.ink2).padding(.horizontal, 4).fixedSize(horizontal: false, vertical: true)
    }

    private func errorLine(_ text: String) -> some View {
        Text(text).font(Theme.body(12)).foregroundStyle(Theme.signal).padding(.horizontal, 14).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row<Control: View>(_ label: String, note: String? = nil, mark: AgentMark.Vendor? = nil, @ViewBuilder control: () -> Control) -> some View {
        HStack(spacing: 10) {
            if let mark { AgentMark(vendor: mark, size: 15) }
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(Theme.body(13))
                if let note { Text(note).font(Theme.mono(10.5)).foregroundStyle(Theme.ink2).lineLimit(1).truncationMode(.middle) }
            }
            Spacer(minLength: 8)
            control()
        }
        .padding(.horizontal, 14).padding(.vertical, 7).frame(minHeight: 44)
    }

    private func toggleRow(_ label: String, _ value: Binding<Bool>) -> some View {
        row(label) { toggle(value) }
    }

    private func toggle(_ value: Binding<Bool>) -> some View {
        Toggle("", isOn: value).toggleStyle(.switch).labelsHidden().tint(Theme.lamp).controlSize(.small)
    }

    private func status(_ lamp: Lamp.Kind, _ text: String) -> some View {
        HStack(spacing: 6) {
            Lamp(kind: lamp, size: 7)
            Text(text).font(Theme.mono(10.5)).foregroundStyle(Theme.ink2).lineLimit(1)
        }
    }

    private func portField(_ value: Binding<Int>) -> some View {
        TextField("", value: value, format: .number.grouping(.never))
            .textFieldStyle(.plain).font(Theme.mono(12)).multilineTextAlignment(.trailing)
            .padding(.horizontal, 8).padding(.vertical, 4).frame(width: 72)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.shade.opacity(0.3)))
    }

    private func apply() { hub.update(settings: AppSettings.hubSettings()) }

    private func copyToken() {
        do {
            let token = try BridgeToken.ensure()
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(token, forType: .string)
            tokenCopied = true
            tokenError = nil
            Task { try? await Task.sleep(for: .seconds(2)); tokenCopied = false }
        } catch { tokenError = "Связка ключей: \(error.localizedDescription)" }
    }

    private func rotateToken() {
        do {
            _ = try BridgeToken.rotate()
            tokenError = nil
            apply()
            hub.start()
        } catch { tokenError = "Связка ключей: \(error.localizedDescription)" }
    }

    private func setHooks(_ enabled: Bool) {
        do {
            try ClaudeHooksInstaller.apply(installed: enabled, port: UInt16(clamping: hookPort))
            hooksInstalled = enabled
            hooksError = nil
        } catch {
            hooksError = "Не удалось изменить settings.json: \(error.localizedDescription)"
        }
    }
}

/// A raised card whose rows are separated by hairlines, like a grouped list.
private struct _VariadicCard<Content: View>: View {
    var content: Content
    var body: some View {
        _VariadicView.Tree(Layout()) { content }
            .background(
                RoundedRectangle(cornerRadius: 18).fill(Theme.ivory)
                    .shadow(color: Theme.shade, radius: 5, x: 3, y: 3).shadow(color: Theme.light, radius: 5, x: -3, y: -3)
            )
    }

    struct Layout: _VariadicView_MultiViewRoot {
        func body(children: _VariadicView.Children) -> some View {
            VStack(spacing: 0) {
                ForEach(children) { child in
                    child
                    if child.id != children.last?.id { Rectangle().fill(Theme.line).frame(height: 1) }
                }
            }
        }
    }
}
