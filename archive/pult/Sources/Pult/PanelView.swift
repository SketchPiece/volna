import SwiftUI
import AppKit
import PultCore

/// The menu bar panel: who works, who waits, one click to the native client.
struct PanelView: View {
    var hub: AgentHub
    @Environment(\.openSettings) private var openSettings
    @State private var showAllIdle = false
    @State private var creating = false
    @State private var newAgent: HubSession.Agent = .claude
    @State private var newFolder = ""
    @State private var newText = ""
    @AppStorage("panelTab") private var tab: PanelTab = .code

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            PanelTabs(selection: $tab, codeCount: hub.needsYou.count + hub.working.count,
                      tasksCount: hub.taskRows.filter { $0.state == .needsYou || $0.state == .working }.count,
                      tasksNeedYou: hub.taskRows.contains { $0.state == .needsYou })
            Divider().overlay(Theme.line)
            if tab == .tasks {
                ScrollView { TasksList(hub: hub) }.frame(height: TasksList.height(for: hub))
            } else {
                codeList
            }
            if creating { newSessionForm }
            Divider().overlay(Theme.line)
            footer
        }
        .frame(width: 380)
        .background(Theme.ivory)
        .foregroundStyle(Theme.bakelite)
        .onAppear {
            // A job waiting for the owner's tap opens the panel on «Работа».
            if hub.taskRows.contains(where: { $0.state == .needsYou }) { tab = .tasks }
            hub.refreshTasks()
        }
    }

    private var codeList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if hub.lastRefresh == nil {
                    Text("Опрашиваю эфир…").font(Theme.body(12.5)).foregroundStyle(Theme.ink2).padding(12)
                }
                if hub.sessions.isEmpty {
                    Text(hub.claudeError == nil ? "В эфире тихо: живых сессий нет." : "Не удалось опросить Claude: \(hub.claudeError ?? "")")
                        .font(Theme.body(12.5)).foregroundStyle(Theme.ink2).padding(12)
                }
                group("ЖДУТ ТЕБЯ", hub.needsYou, lamp: .hot)
                group("В РАБОТЕ", hub.working, lamp: .live)
                let idle = hub.sessions.filter { $0.state == .idle }
                group("В ОЖИДАНИИ", showAllIdle ? idle : Array(idle.prefix(5)), lamp: .dim)
                if idle.count > 5 && !showAllIdle {
                    Button("Ещё \(idle.count - 5)") { showAllIdle = true }.buttonStyle(.plain).font(Theme.mono(10.5)).foregroundStyle(Theme.ink2).padding(.leading, 12)
                }
                let rest = hub.sessions.filter { $0.state == .failed || $0.state == .off }
                group("ВНЕ ЭФИРА", Array(rest.prefix(4)), lamp: .off)
            }
            .padding(.vertical, 8)
        }
        .frame(height: listHeight)
    }

    /// ScrollView inside a MenuBarExtra window collapses without an explicit height, so it is sized from the rows.
    private var listHeight: CGFloat {
        let idle = hub.sessions.filter { $0.state == .idle }.count
        let shownIdle = showAllIdle ? idle : min(idle, 5)
        let rest = min(hub.sessions.filter { $0.state == .failed || $0.state == .off }.count, 4)
        let rows = hub.needsYou.count + hub.working.count + shownIdle + rest
        let groups = [hub.needsYou.count, hub.working.count, shownIdle, rest].filter { $0 > 0 }.count
        let extra: CGFloat = (idle > 5 && !showAllIdle ? 22 : 0) + (rows == 0 ? 44 : 0)
        let tall = hub.sessions.filter { $0.origin == .pult && ($0.state == .needsYou || $0.state == .idle) }.count
        return min(440, CGFloat(rows) * 50 + CGFloat(tall) * 34 + CGFloat(groups) * 30 + 16 + extra)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Эфир").font(Theme.display(14))
            Spacer()
            let rows = hub.taskRows
            let needs = tab == .tasks ? rows.filter { $0.state == .needsYou }.count : hub.needsYou.count
            let working = tab == .tasks ? rows.filter { $0.state == .working }.count : hub.working.count
            StatusPill(text: needs > 0 ? "\(needs) ЖДЁТ" : working > 0 ? "\(working) В РАБОТЕ" : "ТИХО",
                       lamp: needs > 0 ? .hot : working > 0 ? .live : .dim)
            Button {
                creating.toggle()
                if newFolder.isEmpty { newFolder = hub.recentProjects.first ?? "" }
            } label: { Image(systemName: creating ? "xmark" : "plus") }
                .buttonStyle(RoundKeyStyle()).help("Новая сессия")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    @ViewBuilder
    private func group(_ title: String, _ sessions: [HubSession], lamp: Lamp.Kind) -> some View {
        if !sessions.isEmpty {
            HStack {
                Text(title).font(Theme.mono(10)).tracking(1.4).foregroundStyle(Theme.ink2)
                Spacer()
                Text("\(sessions.count)").font(Theme.mono(10)).foregroundStyle(Theme.ink2)
            }
            .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 2)
            ForEach(sessions) { session in row(session, lamp: session.state == .failed ? .off : lamp) }
        }
    }

    private func row(_ session: HubSession, lamp: Lamp.Kind) -> some View {
        SessionRow(session: session, lamp: lamp, detail: detail(for: session), time: session.updatedAt.map(relative)) {
            if let run = hub.run(for: session), session.state == .needsYou {
                HStack(spacing: 8) {
                    Button("Разрешить") { run.decide(true) }.buttonStyle(RaisedButtonStyle(signal: true))
                    Button("Отклонить") { run.decide(false) }.buttonStyle(RaisedButtonStyle())
                }
                .padding(.top, 6)
            }
        } trailing: {
            if let run = hub.run(for: session), session.state == .idle || session.state == .failed {
                Button { hub.forget(run) } label: { Image(systemName: "xmark.circle") }
                    .buttonStyle(.plain).foregroundStyle(Theme.ink2).help("Убрать из эфира")
            }
        }
        .padding(.horizontal, 6)
    }

    /// The vendor mark already says Claude or Codex, so the origin loses the vendor's name.
    private func detail(for session: HubSession) -> String {
        let origin: String = switch session.origin {
        case .claudeDesktop: "Desktop"
        case .claudeCLI: "CLI"
        case .claudeBackground: "фон"
        case .codexApp: "ChatGPT"
        case .codexCLI: "CLI"
        case .codexOther: "Codex"
        case .pult: "Пульт"
        }
        var parts = [origin]
        if let model = session.modelLabel { parts.append(session.effort.map { "\(model) \($0)" } ?? model) }
        parts.append(session.project)
        if let detail = session.detail { parts.append(detail) }
        return parts.joined(separator: " · ")
    }

    private func relative(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "сейчас" }
        if seconds < 3600 { return "\(seconds / 60) мин" }
        if seconds < 86_400 { return "\(seconds / 3600) ч" }
        return "\(seconds / 86_400) дн"
    }

    /// New session in the agent's own app with the text as the user's own first message.
    private var newSessionForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("НОВАЯ СЕССИЯ").font(Theme.mono(10)).tracking(1.2).foregroundStyle(Theme.ink2)
            HStack(spacing: 8) {
                agentKey(.claude, title: "Claude")
                agentKey(.codex, title: "Codex")
            }
            do {
                Menu {
                    ForEach(hub.recentProjects, id: \.self) { folder in Button(folder) { newFolder = folder } }
                    Divider()
                    Button("Другая папка…") { chooseFolder() }
                } label: {
                    HStack {
                        Text(newFolder.isEmpty ? "Папка проекта" : (newFolder as NSString).lastPathComponent).font(Theme.body(12.5)).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.down").font(.system(size: 10))
                    }
                    .foregroundStyle(Theme.ink2)
                }
                .menuStyle(.borderlessButton).padding(.horizontal, 12).frame(height: 32)
                .background(Capsule().fill(Theme.ivory).shadow(color: Theme.shade, radius: 3, x: 2, y: 2).shadow(color: Theme.light, radius: 3, x: -2, y: -2))
            }
            TextField("С чего начать?", text: $newText, axis: .vertical)
                .textFieldStyle(.plain).font(Theme.body(13)).lineLimit(2...5)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.ivory).shadow(color: Theme.shade, radius: 3, x: 2, y: 2).shadow(color: Theme.light, radius: 3, x: -2, y: -2))
            HStack {
                Text("Пульт запустит сессию и пришлёт ответ").font(Theme.mono(10)).foregroundStyle(Theme.ink2)
                Spacer()
                Button("Начать") { startNewSession() }
                    .buttonStyle(RaisedButtonStyle(signal: true))
                    .disabled(newText.trimmingCharacters(in: .whitespaces).isEmpty || newFolder.isEmpty)
            }
        }
        .padding(12)
        .background(Theme.ivory)
        .overlay(Divider().overlay(Theme.line), alignment: .top)
    }

    private func agentKey(_ agent: HubSession.Agent, title: String) -> some View {
        Button { newAgent = agent } label: {
            HStack(spacing: 6) {
                AgentMark(vendor: agent == .claude ? .claude : .openAI, size: 13)
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(KeyButtonStyle(pressed: newAgent == agent))
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.prompt = "Выбрать"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK, let url = panel.url { newFolder = url.path }
    }

    private func startNewSession() {
        let text = newText.trimmingCharacters(in: .whitespacesAndNewlines)
        hub.startRun(agent: newAgent, cwd: newFolder, prompt: text)
        creating = false; newText = ""
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button { NSApp.activate(ignoringOtherApps: true); openSettings() } label: {
                Label("Настройки", systemImage: "gearshape")
            }
            .buttonStyle(RaisedButtonStyle())
            Spacer()
            Button { NSApp.terminate(nil) } label: { Label("Выйти", systemImage: "power") }
                .buttonStyle(QuietButtonStyle())
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}

/// A session line: lamp, vendor mark, name, detail, age on the right; a chevron appears on hover since a click opens it.
struct SessionRow<Below: View, Trailing: View>: View {
    var session: HubSession
    var lamp: Lamp.Kind
    var detail: String
    var time: String?
    @ViewBuilder var below: Below
    @ViewBuilder var trailing: Trailing
    @State private var hovering = false

    var body: some View {
        Button {
            if let url = session.openURL { NSWorkspace.shared.open(url) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Lamp(kind: lamp).padding(.top, 5)
                AgentMark(vendor: session.agent == .claude ? .claude : .openAI, size: 15).padding(.top, 3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.name)
                        .font(Theme.body(13, weight: .medium))
                        .foregroundStyle(session.state == .needsYou ? Theme.signal : Theme.bakelite)
                        .lineLimit(2)
                    Text(detail).font(Theme.mono(10.5)).foregroundStyle(Theme.ink2)
                        .lineLimit(session.origin == .pult && session.state == .idle ? 3 : 1)
                        .help(session.detail ?? "")
                    below
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 6) {
                    if let time { Text(time).font(Theme.mono(10.5)).foregroundStyle(Theme.ink2) }
                    HStack(spacing: 6) {
                        trailing
                        if session.openURL != nil {
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.ink2)
                                .opacity(hovering ? 1 : 0)
                                .help(session.agent == .claude ? "Открыть в Claude" : "Открыть в Codex")
                        }
                    }
                }
                .padding(.top, 2)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionRowStyle(enabled: session.openURL != nil))
        .onHover { hovering = $0 }
    }
}

/// One click opens the session; the row answers with a hover tint and a pressed (inset) look.
struct SessionRowStyle: ButtonStyle {
    var enabled: Bool
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && enabled
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(pressed ? Theme.shade.opacity(0.45) : hovering && enabled ? Theme.light.opacity(0.7) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(pressed ? Theme.shade : Color.clear, lineWidth: 1)
                    )
            )
            .scaleEffect(pressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: pressed)
            .animation(.easeOut(duration: 0.15), value: hovering)
            .onHover { hovering = $0 }
            .opacity(enabled ? 1 : 0.7)
    }
}

/// A key that stays pressed (inset) while selected, like the voice rows on the phone.
struct KeyButtonStyle: ButtonStyle {
    var pressed: Bool
    func makeBody(configuration: Configuration) -> some View {
        let down = pressed || configuration.isPressed
        configuration.label
            .font(Theme.body(12.5, weight: .semibold))
            .foregroundStyle(down ? Theme.signal : Theme.bakelite)
            .padding(.horizontal, 12).frame(height: 32)
            .background(
                Capsule().fill(down ? Theme.shade.opacity(0.35) : Theme.ivory)
                    .shadow(color: down ? .clear : Theme.shade, radius: 3, x: 2, y: 2)
                    .shadow(color: down ? .clear : Theme.light, radius: 3, x: -2, y: -2)
            )
    }
}
