import SwiftUI
import AppKit
import PultCore

enum PanelTab: String { case code, tasks }

/// Two tabs under the header: a pressed track, the chosen tab a raised key (docs/design/volna-pult-tabs.html).
struct PanelTabs: View {
    @Binding var selection: PanelTab
    var codeCount: Int
    var tasksCount: Int
    var tasksNeedYou: Bool

    var body: some View {
        HStack(spacing: 4) {
            tab(.code, title: "Код", count: codeCount, lamp: nil)
            tab(.tasks, title: "Работа", count: tasksCount, lamp: tasksNeedYou ? .hot : nil)
        }
        .padding(4)
        .background(
            Capsule().fill(Theme.ivory)
                .overlay(Capsule().stroke(Theme.shade.opacity(0.9), lineWidth: 2).blur(radius: 2).offset(x: 1.5, y: 1.5).mask(Capsule()))
                .overlay(Capsule().stroke(Theme.light, lineWidth: 2).blur(radius: 2).offset(x: -1.5, y: -1.5).mask(Capsule()))
        )
        .padding(.horizontal, 14).padding(.bottom, 10)
    }

    private func tab(_ tab: PanelTab, title: String, count: Int, lamp: Lamp.Kind?) -> some View {
        let chosen = selection == tab
        return Button { selection = tab } label: {
            HStack(spacing: 7) {
                if let lamp { Lamp(kind: lamp, size: 7) }
                Text(title).font(Theme.body(12.5, weight: .semibold))
                if count > 0 { Text("\(count)").font(Theme.mono(10.5)).foregroundStyle(Theme.ink2) }
            }
            .foregroundStyle(chosen ? Theme.bakelite : Theme.ink2)
            .frame(maxWidth: .infinity).frame(height: 28)
            .background(
                Capsule().fill(chosen ? Theme.ivory : Color.clear)
                    .shadow(color: chosen ? Theme.shade : .clear, radius: 3, x: 2, y: 2)
                    .shadow(color: chosen ? Theme.light : .clear, radius: 3, x: -2, y: -2)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// The «Работа» tab: Astra's jobs (a click opens the thread in Codex) and the bridge's background tasks.
struct TasksList: View {
    var hub: AgentHub

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            linkBanner
            let rows = hub.taskRows
            if rows.isEmpty {
                Text("Работы нет. Её даёт Волна: «сделай на маке…» или долгое исследование.")
                    .font(Theme.body(12.5)).foregroundStyle(Theme.ink2).padding(12)
            }
            group("ЖДЁТ ТЕБЯ", rows.filter { $0.state == .needsYou })
            group("В РАБОТЕ", rows.filter { $0.state == .working })
            group("ГОТОВО", rows.filter { $0.state == .done || $0.state == .failed })
        }
        .padding(.vertical, 8)
    }

    static func height(for hub: AgentHub) -> CGFloat {
        let rows = hub.taskRows
        let groups = [TaskRow.State.needsYou, .working].map { s in rows.contains { $0.state == s } } + [rows.contains { $0.state == .done || $0.state == .failed }]
        let banner: CGFloat = hub.codexLink == .linked ? 0 : 64
        let waiting = CGFloat(rows.filter { $0.confirmationId != nil }.count) * 36
        return min(460, CGFloat(rows.count) * 56 + CGFloat(groups.filter { $0 }.count) * 30 + waiting + banner + (rows.isEmpty ? 48 : 0) + 16)
    }

    /// Astra's jobs are live in the Codex app only when it runs on Pult's shared server; one button fixes that.
    @ViewBuilder
    private var linkBanner: some View {
        if hub.codexLink != .linked {
            HStack(alignment: .center, spacing: 10) {
                Lamp(kind: hub.codexLink == .noApp || hub.codexLink == .serverDown ? .off : .dim)
                VStack(alignment: .leading, spacing: 2) {
                    Text(hub.codexRelinking ? "Перезапускаю Codex…" : "Codex: \(hub.codexLink.label)").font(Theme.body(12.5, weight: .medium))
                    Text(hub.codexLinkError ?? bannerHint).font(Theme.mono(10)).foregroundStyle(hub.codexLinkError == nil ? Theme.ink2 : Theme.signal).lineLimit(2)
                }
                Spacer(minLength: 6)
                if hub.codexLink != .noApp {
                    Button(hub.codexLink == .appClosed ? "Запустить" : "Подключить") { Task { await hub.relinkCodexApp() } }
                        .buttonStyle(RaisedButtonStyle(signal: true))
                        .disabled(hub.codexRelinking)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.light.opacity(0.6)))
            .padding(.horizontal, 6)
        }
    }

    private var bannerHint: String {
        switch hub.codexLink {
        case .appOwnServer: return "задания Астры видны в нём только после конца; Codex перезапустится"
        case .appClosed: return "откроется на общем сервере Пульта"
        case .serverDown: return "Пульт попробует поднять сервер заново"
        case .noApp, .linked: return ""
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ rows: [TaskRow]) -> some View {
        if !rows.isEmpty {
            HStack {
                Text(title).font(Theme.mono(10)).tracking(1.4).foregroundStyle(Theme.ink2)
                Spacer()
                Text("\(rows.count)").font(Theme.mono(10)).foregroundStyle(Theme.ink2)
            }
            .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 2)
            ForEach(rows) { row in TaskLine(row: row, hub: hub).padding(.horizontal, 6) }
        }
    }
}

struct TaskLine: View {
    var row: TaskRow
    var hub: AgentHub
    @State private var hovering = false

    var body: some View {
        Button {
            if let url = row.openURL { NSWorkspace.shared.open(url) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Lamp(kind: lamp).padding(.top, 5)
                mark.padding(.top, 3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(Theme.body(13, weight: .medium))
                        .foregroundStyle(row.state == .needsYou ? Theme.signal : Theme.bakelite).lineLimit(2)
                    if let line = row.line {
                        if row.state == .working {
                            Text(line).font(Theme.body(12.5)).foregroundStyle(Theme.bakelite).lineLimit(2)
                        } else {
                            Text(line).font(Theme.mono(10.5)).foregroundStyle(row.state == .needsYou ? Theme.signal : Theme.ink2).lineLimit(1)
                        }
                    }
                    if let id = row.confirmationId {
                        HStack(spacing: 8) {
                            Button("Разрешить") { Task { await hub.decide(confirmation: id, approve: true) } }.buttonStyle(RaisedButtonStyle(signal: true))
                            Button("Отклонить") { Task { await hub.decide(confirmation: id, approve: false) } }.buttonStyle(RaisedButtonStyle())
                        }
                        .padding(.top, 6)
                    }
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 6) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(time(at: context.date)).font(Theme.mono(10.5)).foregroundStyle(Theme.ink2).monospacedDigit()
                    }
                    if row.openURL != nil {
                        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.ink2)
                            .opacity(hovering ? 1 : 0).help("Открыть в Codex")
                    }
                }
                .padding(.top, 2)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionRowStyle(enabled: row.openURL != nil))
        .onHover { hovering = $0 }
    }

    private var lamp: Lamp.Kind {
        switch row.state {
        case .needsYou: return .hot
        case .working: return .live
        case .done: return .dim
        case .failed: return .off
        }
    }

    @ViewBuilder
    private var mark: some View {
        switch row.source {
        case .astra: AgentMark(vendor: .openAI, size: 15)
        case .bridge: WaveMark().frame(width: 15, height: 15)
        }
    }

    /// Running: how long it has been going; finished: how long ago.
    private func time(at now: Date) -> String {
        if row.state == .needsYou || row.state == .working {
            let seconds = max(0, Int(now.timeIntervalSince(row.startedAt)))
            return seconds < 3600 ? String(format: "%d:%02d", seconds / 60, seconds % 60) : "\(seconds / 3600) ч"
        }
        let seconds = Int(now.timeIntervalSince(row.finishedAt ?? row.startedAt))
        if seconds < 60 { return "сейчас" }
        if seconds < 3600 { return "\(seconds / 60) мин" }
        return "\(seconds / 3600) ч"
    }
}

/// Volna's own mark for the bridge's tasks: one signal-red wave.
struct WaveMark: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            let w = size.width, h = size.height, mid = h / 2, amp = h * 0.22
            path.move(to: CGPoint(x: w * 0.06, y: mid))
            path.addCurve(to: CGPoint(x: w * 0.4, y: mid), control1: CGPoint(x: w * 0.17, y: mid - amp * 2), control2: CGPoint(x: w * 0.29, y: mid - amp * 2))
            path.addCurve(to: CGPoint(x: w * 0.72, y: mid), control1: CGPoint(x: w * 0.51, y: mid + amp * 2), control2: CGPoint(x: w * 0.61, y: mid + amp * 2))
            path.addCurve(to: CGPoint(x: w * 0.94, y: mid - amp * 0.6), control1: CGPoint(x: w * 0.8, y: mid - amp), control2: CGPoint(x: w * 0.88, y: mid - amp))
            context.stroke(path, with: .color(Theme.signal), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
        }
        .accessibilityLabel("Волна")
    }
}
