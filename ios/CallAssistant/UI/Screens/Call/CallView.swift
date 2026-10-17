import SwiftUI

/// Commands the call screen can issue. Previews pass `.none`.
struct CallActions {
    var start: () -> Void = {}
    var end: () -> Void = {}
    var toggleMute: () -> Void = {}
    var showTranscript: () -> Void = {}
    var openSettings: () -> Void = {}
    /// A conversation tapped in the home list.
    var openRecord: (CallRecord) -> Void = { _ in }
    static let none = CallActions()
}

/// Binds the coordinator to the pure screen and owns the sheets.
struct CallView: View {
    @ObservedObject var call: CallCoordinator
    @ObservedObject private var history: CallHistoryStore
    @StateObject private var work = WorkFeed()
    @State private var settings = false
    @State private var showTranscript = false
    @State private var openRecord: CallRecord?
    @State private var localError: String?
    @State private var homeMode = HomePreferences().mode
    @State private var firstRun = HomePreferences().showsFirstRun

    init(call: CallCoordinator) {
        self.call = call
        self.history = call.history
    }

    var body: some View {
        CallScreen(
            state: call.state,
            voiceLevel: call.voiceLevel,
            localError: localError,
            home: firstRun ? .init(mode: homeMode) : .init(mode: homeMode, records: history.records, work: work.items),
            actions: CallActions(
                start: {
                    localError = nil
                    Task { do { try await call.start() } catch { localError = error.localizedDescription } }
                },
                end: { call.end() },
                toggleMute: { call.toggleMute() },
                showTranscript: { showTranscript = true },
                openSettings: { settings = true },
                openRecord: { openRecord = $0 }
            )
        )
        .sensoryFeedback(trigger: call.state.phase) { old, new in CallFeedback.phaseChange(from: old, to: new) }
        .sheet(isPresented: $settings, onDismiss: {
            homeMode = HomePreferences().mode
            firstRun = HomePreferences().showsFirstRun
        }) { SettingsView(call: call) }
        .sheet(isPresented: $showTranscript) { TranscriptSheet(call: call) }
        .sheet(item: $openRecord) { CallRecordSheet(record: $0) }
        // Work refreshes only while its list can be seen.
        .task(id: homeMode == .work && !call.active) {
            guard homeMode == .work, !call.active else { return }
            await work.follow()
        }
    }
}

/// Pure call screen: draws a `CallState`, knows nothing about services.
struct CallScreen: View {
    /// What the idle screen lists under the title.
    struct Home {
        var mode: HomeMode = .default
        var records: [CallRecord] = []
        var work: [WorkItem] = []
    }

    var state: CallState
    var voiceLevel: Double? = nil
    var localError: String? = nil
    var home = Home()
    var actions: CallActions
    /// Centres of the mark and of the call key: the mark grows out of the key and sinks back into it.
    /// The mark's centre is remembered from the last call; before the first one the stage's centre stands in.
    @State private var markMidY: CGFloat?
    @State private var stageMidY: CGFloat = 0
    @State private var keyMidY: CGFloat = 0
    /// The page scroll of the conversations (docs/design/canvas/home-scroll): how far it went, and the heights the list
    /// runs under (the title above, the call key below).
    @State private var scrollY: CGFloat = 0
    @State private var headerHeight: CGFloat = 0
    @State private var controlsHeight: CGFloat = 64
    @State private var bottomInset: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var markState: WaveMark.State { .init(phase: state.phase, isMuted: state.isMuted) }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            header
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
                // The title scrolls away with the conversations and slides under the top bar.
                .offset(y: pageScrolls ? -max(0, scrollY) : 0)
                .opacity(pageScrolls ? 1 - min(1, max(0, scrollY) / max(1, headerHeight)) : 1)
                .clipped()
            stage
            if let error = state.error ?? localError {
                ErrorCard(text: error)
                    .padding(.bottom, 20)
                    .accessibilityIdentifier("callError")
            }
            controls
        }
        .padding(.horizontal, 24).padding(.bottom, 24)
        .frame(maxHeight: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: { bottomInset = $0 }
        .coordinateSpace(.named(Self.space))
        .background(Wave.Palette.ivory.ignoresSafeArea())
        .tint(Wave.Palette.signal)
        .onChange(of: pageScrolls) { _, scrolls in if !scrolls { scrollY = 0 } }
    }

    // MARK: - Sections

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Text(CallCopy.title(for: state.phase))
                if state.phase == .ended { SignOffDots() }
            }
            .font(Wave.Fonts.title).foregroundStyle(Wave.Palette.bakelite)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 22)
            HStack(spacing: 8) {
                if let symbol = CallCopy.statusSymbol(for: state) {
                    Image(systemName: symbol)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(state.phase == .speaking ? Wave.Palette.signal : Wave.Palette.ink2)
                        .frame(width: 18)
                        .accessibilityHidden(true)
                }
                Text(state.status)
                    .font(Wave.Fonts.text).foregroundStyle(Wave.Palette.ink2)
                    .accessibilityIdentifier("callStatus")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
            .animation(.easeOut(duration: 0.18), value: state.status)
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 10) {
                BrandMark(size: 26)
                Text(CallCopy.brand).font(Wave.Fonts.brand).foregroundStyle(Wave.Palette.bakelite)
            }
            .accessibilityElement(children: .combine)
            // Board «Б» of home-scroll: once the title has scrolled away, the bar says what is below it.
            if collapsed {
                Text(HomeCopy.modeTitle(.talks).uppercased())
                    .font(Wave.Fonts.status).tracking(1.3).foregroundStyle(Wave.Palette.ink2)
                    .padding(.leading, 4)
                    .transition(.opacity.combined(with: .offset(y: 6)))
            }
            Spacer(minLength: 8)
            if !state.active {
                IconButton(symbol: "slider.horizontal.3", label: CallCopy.settings, action: actions.openSettings)
                    .accessibilityIdentifier("settings")
            }
        }
        .frame(minHeight: 44)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .overlay(alignment: .bottom) {
            // A soft edge the rows slide under.
            LinearGradient(colors: [Wave.Palette.shade.opacity(0.55), Wave.Palette.shade.opacity(0)], startPoint: .top, endPoint: .bottom)
                .frame(height: 10)
                .offset(y: 10)
                .padding(.horizontal, -24)
                .opacity(collapsed ? 1 : 0)
                .allowsHitTesting(false)
        }
        .zIndex(1)
        .animation(.easeOut(duration: 0.2), value: collapsed)
    }

    /// In a call (and after a failed one) the mark; at rest the home list. The mark grows out of the call key
    /// and sinks back into it (docs/design/canvas/home-idle, board «В»).
    @ViewBuilder private var stage: some View {
        ZStack {
            if showsMark {
                VStack(spacing: 16) {
                    WaveMark(size: markSize, state: markState, level: voiceLevel)
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).midY } action: { markMidY = $0 }
                    if state.active, let date = state.startedAt {
                        Text(date, style: .timer)
                            .font(Wave.Fonts.timer).monospacedDigit()
                            .foregroundStyle(state.isMuted ? Wave.Palette.ink2 : Wave.Palette.bakelite)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, state.active ? 48 : 28).padding(.bottom, 28)
                .frame(maxHeight: .infinity)
                .transition(reduceMotion ? .opacity : .modifier(active: FromKey(dy: keyMidY - (markMidY ?? stageMidY), scale: 72 / markSize.diameter),
                                                                identity: FromKey(dy: 0, scale: 1)))
            } else if pageScrolls {
                talksPage
                    .transition(.asymmetric(insertion: AnyTransition.opacity.combined(with: .offset(y: 16)).animation(.easeOut(duration: 0.35).delay(0.55)),
                                            removal: AnyTransition.opacity.animation(.easeOut(duration: 0.15))))
            } else {
                HomeList(mode: home.mode, records: home.records, work: home.work)
                    .padding(.top, 28).padding(.bottom, 20)
                    // Back only once the mark has sunk into the key; out at once when a call starts.
                    .transition(.asymmetric(insertion: AnyTransition.opacity.combined(with: .offset(y: 16)).animation(.easeOut(duration: 0.35).delay(0.55)),
                                            removal: AnyTransition.opacity.animation(.easeOut(duration: 0.15))))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).midY } action: { stageMidY = $0 }
        // Out of a call the mark leaves first; into one it waits for the key to turn round.
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.55, dampingFraction: 0.86).delay(showsMark ? 0.12 : 0), value: showsMark)
    }

    /// The whole page scrolls (docs/design/canvas/home-scroll, boards «Б» and «В»): the scroll view reaches up under the
    /// title, which moves with it, and down under the call key; the rows are the page, not a box inside it.
    private var talksPage: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: headerHeight)
                HomeTalks(records: home.records, open: actions.openRecord)
                    .padding(.top, 28)
                Color.clear.frame(height: controlsHeight + 24 + 28)
            }
            .padding(.horizontal, 24)
        }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, y in scrollY = y }
        .mask {
            VStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: collapsed ? 14 : 0)
                Color.black
            }
        }
        .padding(.horizontal, -24)
        .padding(.top, -headerHeight)
        .padding(.bottom, -(controlsHeight + 24))
        // Rows run on under the home indicator instead of stopping at the safe area.
        .ignoresSafeArea(.container, edges: .bottom)
    }

    private static let space = "callScreen"
    /// At rest with conversations to list, the page scrolls; in a call, on the work list and before the first call it does not.
    private var pageScrolls: Bool { !showsMark && home.mode == .talks && !home.records.isEmpty }
    /// The title has gone under the top bar.
    private var collapsed: Bool { pageScrolls && scrollY > headerHeight - 8 }
    /// Board «В»: scrolled down, the wide call key folds into a round one at the right and the rows run past it.
    private var folded: Bool { pageScrolls && scrollY > 60 }
    private var showsMark: Bool { state.active || state.phase == .failed }
    private var markSize: WaveMark.Size { state.active ? .xl : .lg }

    /// One red key for both states; the microphone and transcript keys appear beside it once it is round.
    private var controls: some View {
        VStack(spacing: 0) {
            if state.active && state.isDemo {
                Text(CallCopy.demoLabel)
                    .font(Wave.Fonts.status).tracking(1).foregroundStyle(Wave.Palette.ink2)
                    .padding(.bottom, 18)
                    .transition(.opacity)
            }
            // Microphone and transcript flank the end-call key; their centres align with its centre. Both sides get the
            // same width, otherwise the longer «Стенограмма» pushes the end-call key off the screen's centre.
            HStack(alignment: .top, spacing: 16) {
                if state.active {
                    RoundControl(symbol: state.isMuted ? "mic.slash" : "mic", label: state.isMuted ? CallCopy.unmute : CallCopy.mute, selected: state.isMuted, diameter: 52, action: actions.toggleMute)
                        .accessibilityIdentifier("mute").disabled(!state.connected)
                        .opacity(state.connected ? 1 : 0.45)
                        .padding(.top, 10)
                        .frame(width: Self.sideKeyWidth)
                        .transition(.opacity.combined(with: .scale(scale: 0.6)))
                }
                CallKey(round: state.active, folded: folded, title: CallCopy.callToAction(for: state.phase), action: state.active ? actions.end : actions.start)
                    .accessibilityLabel(state.active ? (state.phase == .connecting ? CallCopy.cancelCall : CallCopy.endCall) : CallCopy.callToAction(for: state.phase))
                    .accessibilityIdentifier(state.active ? "endCall" : "startCall")
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).midY } action: { keyMidY = $0 }
                if state.active {
                    RoundControl(symbol: "doc.text", label: CallCopy.transcript, selected: false, diameter: 52, action: actions.showTranscript)
                        .accessibilityIdentifier("transcript").disabled(!state.connected)
                        .opacity(state.connected ? 1 : 0.45)
                        .padding(.top, 10)
                        .frame(width: Self.sideKeyWidth)
                        .transition(.opacity.combined(with: .scale(scale: 0.6)))
                }
            }
            .frame(maxWidth: .infinity, alignment: folded ? .trailing : .center)
            if state.phase == .connecting {
                Text(CallCopy.cancel).font(Wave.Fonts.small).foregroundStyle(Wave.Palette.ink2).padding(.top, 10)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { controlsHeight = $0 }
        // Rows sliding under the wide key fade out above it; the folded key floats over them.
        .background(alignment: .bottom) {
            LinearGradient(stops: [.init(color: Wave.Palette.ivory.opacity(0), location: 0), .init(color: Wave.Palette.ivory, location: 0.55)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: controlsHeight + 24 + 56 + bottomInset)
                .padding(.horizontal, -24)
                .offset(y: 24 + bottomInset)
                .opacity(pageScrolls && !folded ? 1 : 0)
                .allowsHitTesting(false)
        }
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.72), value: folded)
        // The key turns round at once when a call starts and widens only after the mark has sunk into it.
        // Inner of the two, so it wins when a call starts or ends; phase changes inside a call keep the short fade.
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.5, dampingFraction: 0.82).delay(state.active ? 0 : 0.45), value: state.active)
        .animation(.easeOut(duration: 0.18), value: state.phase)
    }

    /// Wide enough for «Стенограмма» under a 52 pt key at the largest default text size.
    private static let sideKeyWidth: CGFloat = 104
}

/// The mark on its way out of the call key: moved down onto the key, shrunk to its size, faded at the small end.
private struct FromKey: ViewModifier {
    var dy: CGFloat
    var scale: CGFloat
    func body(content: Content) -> some View {
        content
            .scaleEffect(scale)
            .offset(y: dy)
            .opacity(scale < 1 ? 0.3 : 1)
    }
}

// MARK: - Previews

private extension CallState {
    static func preview(_ phase: CallPhase, muted: Bool = false) -> CallState {
        var state = CallState()
        state.phase = phase
        state.isMuted = muted
        state.startedAt = phase == .idle ? nil : Date().addingTimeInterval(-134)
        state.connectionTime = 1.8
        state.transcript = phase == .ended ? "Качели раскачиваются сильнее всего, если толкать их точно в такт. Это и есть резонанс, товарищ." : ""
        state.lines = phase == .ended ? [
            TranscriptLine(id: 0, speaker: .you, text: "Что такое резонанс, объясни по-простому.", offset: 7),
            TranscriptLine(id: 1, speaker: .wave, text: state.transcript, offset: 11)
        ] : []
        state.error = phase == .failed ? CallCopy.connectTimeout : nil
        return state
    }
}

#Preview("Эфир открыт") { CallScreen(state: .preview(.idle), actions: .none) }
#Preview("Настройка") { CallScreen(state: .preview(.connecting), actions: .none) }
#Preview("Говорит Волна") { CallScreen(state: .preview(.speaking), actions: .none) }
#Preview("Микрофон выкл") { CallScreen(state: .preview(.listening, muted: true), actions: .none) }
#Preview("Помехи") { CallScreen(state: .preview(.failed), actions: .none) }
#Preview("Конец связи") { CallScreen(state: .preview(.ended), actions: .none) }

/// Three dots after «Конец связи» that light up one by one while the screen waits to return to idle.
private struct SignOffDots: View {
    @State private var lit = 0
    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<3, id: \.self) { index in
                Text(".").opacity(index < lit ? 1 : 0.18)
            }
        }
        .accessibilityHidden(true)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(450))
                withAnimation(.easeOut(duration: 0.2)) { lit = (lit + 1) % 4 }
            }
        }
    }
}
