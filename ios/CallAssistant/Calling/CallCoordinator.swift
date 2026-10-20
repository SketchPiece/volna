import Foundation
import AVFAudio
import UIKit

/// Orchestrates one call at a time: accepts commands, drives services, folds their events
/// through `CallReducer` and publishes the resulting `CallState`. The only owner of call state.
@MainActor
final class CallCoordinator: ObservableObject {
    static let shared = AppContainer.makeCoordinator()

    @Published private(set) var state = CallState()
    /// Voice level 0…1 for the wave mark: measured in a call, scripted in the demo; nil when there is none (idle, simulator).
    @Published private(set) var voiceLevel: Double?
    /// Finished conversations for the home screen; the coordinator adds each answered call when it ends.
    let history: CallHistoryStore

    // Convenience accessors used by screens
    var phase: CallPhase { state.phase }
    var active: Bool { state.active }
    var connected: Bool { state.connected }
    var isMuted: Bool { state.isMuted }
    var isSpeaker: Bool { state.isSpeaker }
    var route: String { state.route }
    var error: String? { state.error }
    var startedAt: Date? { state.startedAt }
    var connectionTime: Double? { state.connectionTime }
    var transcript: String { state.transcript }
    var launchSource: String { state.launchSource }
    var status: String { state.status }

    private let system: SystemCallService
    private let audio: AudioRouting
    private let transport: RealtimeTransport
    private let tools: DeviceToolRunner
    /// Ringback while the call is «connecting»; cut by the answer.
    private let ringback: RingbackPlayer
    /// Experiment: own quiet tunes while work started in this call runs and both sides are silent.
    private let waitMusicPlayer: WaitMusicPlayer
    private var waitMusic = WaitMusic(enabled: false)
    private var callID: UUID?
    private var networkTask: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var observations: [NSObjectProtocol] = []
    private var pendingShortcutCall: (source: String, requestedAt: Date)?
    /// Who is talking, derived from levels and transcripts: GPT-Live sends no turn events.
    private var activity = SpeechActivity()
    private var thinkingTimeout: Task<Void, Never>?
    /// Scripted conversation of the demo call.
    private var demoTask: Task<Void, Never>?
    /// When to ask Volna to greet (after `session.started` and CallKit's audio activation, in either order)
    /// and when the call counts as answered (Volna's first word).
    private var greeting = GreetingGate()
    private var greetingTask: Task<Void, Never>?
    /// Returns the ended screen to idle after `endedScreenDuration`.
    private var resetTask: Task<Void, Never>?
    static let endedScreenDuration: Duration = .seconds(3)
    /// Phone tools relayed by the core, which runs the delegation; long-polled while the session is up.
    private let relay: DeviceToolRelay
    private var relayTask: Task<Void, Never>?
    /// Volna is calling back about this background task; sent to the core in `X-Callback-Task` when answered.
    private var callbackTask: String?
    private var ringDeadline: Task<Void, Never>?
    /// How long the callback rings before it counts as missed; the core then sends a notification instead.
    static let ringTimeout: Duration = .seconds(40)

    init(system: SystemCallService, audio: AudioRouting, transport: RealtimeTransport, tools: DeviceToolRunner,
         relay: DeviceToolRelay = DeviceToolRelay(),
         ringback: RingbackPlayer = RingbackPlayer(), history: CallHistoryStore? = nil,
         waitMusicPlayer: WaitMusicPlayer = WaitMusicPlayer()) {
        self.system = system
        self.history = history ?? CallHistoryStore()
        self.audio = audio
        self.transport = transport
        self.tools = tools
        self.relay = relay
        self.ringback = ringback
        self.waitMusicPlayer = waitMusicPlayer
        system.delegate = self
        transport.handler = { [weak self] event in self?.handle(event) }
        audio.onRouteChanged = { [weak self] route in self?.dispatch(.routeChanged(isSpeaker: route.isSpeaker, name: route.name)) }
        audio.onFatal = { [weak self] message in if self?.active == true { self?.finish(error: message) } }
        audio.onWarning = { [weak self] message in self?.dispatch(.warning(message)) }
        // The model hears silence while a burst sounds, so the tone is never taken for the owner's voice.
        ringback.onTone = { [weak self] on in
            guard let self else { return }
            self.transport.setMuted(on || self.isMuted)
        }
        observations.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.startPendingShortcutCall() }
        })
    }

    // MARK: - Commands

    /// App Intents may execute while the foreground transition is still inactive.
    /// Complete the handoff first; the system call starts only after didBecomeActive.
    func requestShortcutCall(source: String = "Siri / Команды") {
        guard !active else { return }
        pendingShortcutCall = (source, Date())
        startPendingShortcutCall()
    }

    /// SiriKit gives the host a system call handoff, including while locked.
    /// It must not wait on the foreground-only Shortcuts queue.
    func requestSystemCall() {
        guard !active else { return }
        pendingShortcutCall = nil
        CallLaunchDiagnostics.record("sirikit.start state=\(UIApplication.shared.applicationState.rawValue) protectedData=\(UIApplication.shared.isProtectedDataAvailable)")
        Task { @MainActor in
            do { try await self.start(source: "SiriKit") }
            catch { if self.phase != .failed { self.finish(error: error.localizedDescription) } }
        }
    }

    func start(source: String = "Приложение") async throws {
        guard !active else { return }
        _ = try ConnectionSettings().sessionURL()
        dispatch(.startRequested(source: source, at: Date()))
        let id = UUID(); callID = id
        let granted = await Permissions.ensureMicrophone()
        guard callID == id else { return }
        guard granted else {
            finish(error: CallCopy.microphoneDenied)
            throw VoiceError.message(CallCopy.microphoneDenied)
        }
        do { try await system.requestStart(id: id) }
        catch {
            if callID == id { finish(error: error.localizedDescription) }
            throw error
        }
    }

    /// A VoIP push: Volna calls the owner back about a finished background task. iOS demands a CallKit report for every
    /// VoIP push, so an invalid push or one arriving during a call still rings briefly and ends at once.
    func incomingCallback(_ push: CallbackPush?, completion: @escaping () -> Void) {
        let id = UUID()
        guard let push, !active else {
            system.reportIncoming(id: id) { [weak self] _ in
                self?.system.reportUnanswered(id: id)
                completion()
            }
            return
        }
        pendingShortcutCall = nil
        callID = id
        callbackTask = push.taskID
        dispatch(.startRequested(source: CallCopy.callbackSource, at: Date()))
        system.reportIncoming(id: id) { [weak self] error in
            completion()
            guard let self, self.callID == id, error != nil else { return }
            // Do Not Disturb, a blocked caller or another call: the core's fallback notification carries the result.
            self.cleanup()
            self.dispatch(.ended)
        }
        ringDeadline = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.ringTimeout)
            guard let self, !Task.isCancelled, self.callID == id, self.phase == .connecting else { return }
            CallLaunchDiagnostics.record("callback.unanswered")
            self.cleanup()
            self.dispatch(.ended)
            self.system.reportUnanswered(id: id)
        }
    }

    func end() {
        pendingShortcutCall = nil
        guard active else { return }
        let id = callID
        let demo = state.isDemo
        // Release mic/network immediately, without waiting for a system callback.
        cleanup()
        dispatch(.ended)
        if let id, !demo { system.requestEnd(id: id) }
    }

    func toggleMute() {
        guard connected else { return }
        let muted = !isMuted
        if state.isDemo { applyMute(muted); return }
        guard let id = callID else { return }
        system.requestMute(id: id, muted: muted)
    }

    func preview() {
        guard !active else { return }
        dispatch(.previewStarted(at: Date(), transcript: CallCopy.previewTranscript))
        playDemo()
    }

    /// Plays `DemoConversation` in a loop so the screen and the wave go through every phase:
    /// the owner asks, Volna thinks, then answers. Levels arrive ten times per second, like real ones.
    /// With the microphone off the owner stays silent, so Volna has nothing to answer.
    private func playDemo() {
        demoTask?.cancel()
        demoTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(DemoConversation.openingPause))
            var queue: [DemoConversation.Exchange] = []
            var seed = 0
            while !Task.isCancelled {
                guard let self, self.state.isDemo, self.state.connected else { return }
                if queue.isEmpty { queue = MemoryPreferences.isPreviewRun ? DemoConversation.exchanges.reversed() : DemoConversation.exchanges.shuffled() }
                let exchange = queue.removeLast()
                seed += 1
                if !self.isMuted {
                    self.dispatch(.speechStarted)
                    let finished = await self.speakDemo(exchange.question, seed: seed, owner: true)
                    try? await Task.sleep(for: .seconds(0.6))
                    if finished, !Task.isCancelled {
                        self.dispatch(.speechStopped)
                        try? await Task.sleep(for: .seconds(Double.random(in: DemoConversation.thinking)))
                        guard !Task.isCancelled else { return }
                        self.dispatch(.outputStarted)
                        _ = await self.speakDemo(exchange.answer, seed: seed + 100, owner: false)
                        guard !Task.isCancelled else { return }
                        self.dispatch(.outputStopped)
                    }
                }
                try? await Task.sleep(for: .seconds(Double.random(in: DemoConversation.pauseBetween)))
            }
        }
    }

    /// Speaks one demo phrase word by word with a speech-like level. False when the owner muted mid-phrase.
    private func speakDemo(_ text: String, seed: Int, owner: Bool) async -> Bool {
        let words = DemoConversation.deltas(text)
        let length = Double(words.count) * DemoConversation.secondsPerWord
        let start = Date()
        var said = 0
        defer { voiceLevel = 0 }
        while !Task.isCancelled {
            if owner && isMuted { return false }
            let elapsed = Date().timeIntervalSince(start)
            if elapsed > length { return true }
            voiceLevel = DemoConversation.level(at: elapsed, length: length, seed: seed)
            let due = min(words.count, Int(elapsed / DemoConversation.secondsPerWord) + 1)
            while said < due {
                dispatch(owner ? .inputTranscriptDelta(words[said]) : .transcriptDelta(words[said]))
                said += 1
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    // MARK: - Events

    private func dispatch(_ event: CallEvent) {
        let previous = state
        let next = CallReducer.reduce(state, event)
        if next != state { state = next }
        if previous.active, !next.active, let record = CallRecord.finished(previous, at: Date()) { recordLater(record) }
        if next.phase == .ended {
            scheduleReset()
        } else {
            resetTask?.cancel(); resetTask = nil
        }
    }

    /// The new row slides into the list once the mark has sunk back into the call key.
    private func recordLater(_ record: CallRecord) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.recordDelay)
            self?.history.add(record)
        }
    }
    static let recordDelay: Duration = .milliseconds(700)

    private func scheduleReset() {
        guard resetTask == nil else { return }
        resetTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.endedScreenDuration)
            guard let self, !Task.isCancelled else { return }
            self.resetTask = nil
            self.dispatch(.reset)
        }
    }

    private func handle(_ event: RealtimeEvent) {
        switch event {
        case .ready: didStartSession()
        case let .failure(message): finish(error: message)
        case let .level(input, output):
            guard state.live, !state.isDemo else { return }
            voiceLevel = phase == .speaking ? output : input
            dispatchActivity(activity.observe(input: input, output: output))
            updateWaitMusic()
        case let .message(type, payload):
            guard state.live else { return }
            switch type {
            case "session.output_transcript.delta":
                applyGreeting(greeting.waveSpoke(), trigger: "transcript")
                dispatchActivity(activity.outputTranscriptArrived())
                dispatch(.transcriptDelta(payload["delta"] as? String ?? ""))
            case "session.input_transcript.delta":
                applyGreeting(greeting.ownerSpoke(), trigger: "owner")
                waitMusic.ownerSpoke(at: Date())
                dispatchActivity(activity.inputTranscriptArrived())
                dispatch(.inputTranscriptDelta(payload["delta"] as? String ?? ""))
            case "session.closed":
                let reason = payload["reason"] as? String ?? ""
                if ["expired", "content", "connection_lost"].contains(reason) { finish(error: CallCopy.sessionClosed(reason)) } else { end() }
            default: break
            }
        }
    }

    /// Phase changes inferred by `SpeechActivity`. After the user stops, Volna may stay silent (full duplex has no
    /// obligation to answer), so «thinking» falls back to «listening» after four seconds without output.
    /// Volna's first audible output answers the call before it turns into «speaking»; the owner's level alone never does.
    private func dispatchActivity(_ events: [CallEvent]) {
        for event in events {
            if event == .outputStarted { applyGreeting(greeting.waveSpoke(), trigger: "audio") }
            dispatch(event)
            switch event {
            case .speechStarted, .speechStopped:
                // The microphone hears the music: while it plays, only the transcript says the owner talks.
                if !waitMusicPlayer.wanted { waitMusic.ownerSpoke(at: Date()) }
            case .outputStarted, .outputStopped:
                waitMusic.wave(speaking: event == .outputStarted, at: Date())
            default: break
            }
            switch event {
            case .speechStarted: CallLaunchDiagnostics.record("live.userSpeech")
            case .outputStarted:
                CallLaunchDiagnostics.record("live.aiAudio")
                thinkingTimeout?.cancel(); thinkingTimeout = nil
            case .speechStopped:
                thinkingTimeout?.cancel()
                thinkingTimeout = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(4))
                    guard let self, !Task.isCancelled, self.phase == .thinking else { return }
                    self.dispatch(.outputStopped)
                }
            default: break
            }
        }
    }

    private func startPendingShortcutCall() {
        guard let pending = pendingShortcutCall, UIApplication.shared.applicationState == .active else { return }
        pendingShortcutCall = nil
        guard Date().timeIntervalSince(pending.requestedAt) < 15 else { return }
        Task { @MainActor in
            do { try await self.start(source: pending.source) }
            catch { if self.phase != .failed { self.finish(error: error.localizedDescription) } }
        }
    }

    private func beginConnection(id: UUID) {
        guard callID == id else { return }
        CallLaunchDiagnostics.record("realtime.connecting")
        networkTask = Task { [weak self] in
            guard let self else { return }
            do { try await self.transport.connect(settings: ConnectionSettings(), deviceTools: self.tools.availableNames(), callbackTask: self.callbackTask) }
            catch is CancellationError { }
            catch { if self.callID == id { self.finish(error: error.localizedDescription) } }
        }
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(35)) } catch { return }
            guard let self, self.callID == id, self.phase == .connecting else { return }
            self.finish(error: CallCopy.connectTimeout)
        }
    }

    /// `session.started`: the link is up, but the call stays «connecting» until Volna's first word (`didAnswer`).
    /// The 35-second deadline keeps running until then; the greeting gate answers on its own well before it.
    private func didStartSession() {
        guard phase == .connecting, !state.linkReady, let id = callID else { return }
        dispatch(.sessionReady(at: Date()))
        let route = audio.current
        dispatch(.routeChanged(isSpeaker: route.isSpeaker, name: route.name))
        CallLaunchDiagnostics.record("realtime.ready state=\(UIApplication.shared.applicationState.rawValue) protectedData=\(UIApplication.shared.isProtectedDataAvailable)")
        startDeviceToolRelay(id: id)
        activity = SpeechActivity()
        applyGreeting(greeting.sessionDidStart())
    }

    /// The call is answered: the in-app timer and CallKit's «connected» (lock screen, Dynamic Island, Recents) start now.
    private func didAnswer(trigger: String) {
        guard phase == .connecting, state.linkReady, let id = callID else { return }
        ringback.stop(fade: true)
        deadline?.cancel(); deadline = nil
        greetingTask?.cancel(); greetingTask = nil
        dispatch(.answered(at: Date()))
        CallLaunchDiagnostics.record("call.answered \(trigger) \(String(format: "%.1f", state.connectionTime ?? 0))s")
        system.reportConnected(id: id)
    }

    /// Long poll for phone tools relayed by the core. Stops for good when the core has no relay.
    private func startDeviceToolRelay(id: UUID) {
        relayTask?.cancel()
        guard !state.isDemo else { return }
        waitMusic = WaitMusic(enabled: ConnectionSettings().waitMusic)
        let relay = relay
        relayTask = Task { @MainActor [weak self] in
            // The first answer comes at once: work running before this call is the baseline of `WaitMusic`.
            var first = true
            while !Task.isCancelled {
                guard let current = self, current.callID == id, current.state.live else { return }
                do {
                    let poll = try await relay.next(immediate: first)
                    first = false
                    guard let self, self.callID == id else { return }
                    if let working = poll.working { self.waitMusic.workChanged(working); self.updateWaitMusic() }
                    for call in poll.calls { self.runRelayed(call, id: id) }
                } catch DeviceToolRelay.Failure.unavailable {
                    return
                } catch {
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
    }

    /// Starts or fades the wait music; asked every level tick and when the running work changes.
    private func updateWaitMusic() {
        guard state.live, !state.isDemo else { return }
        if waitMusic.shouldPlay(at: Date()) { waitMusicPlayer.play() } else { waitMusicPlayer.pause() }
    }

    /// Runs one relayed call like a data-channel one and answers the core; dropped if the call ended meanwhile.
    private func runRelayed(_ relayed: DeviceToolRelay.Relayed, id: UUID) {
        CallLaunchDiagnostics.record("tool.relay \(relayed.name)")
        let relay = relay
        Task { @MainActor [weak self] in
            guard let self else { return }
            let output = if let call = DeviceToolRelay.toolCall(relayed) { await self.tools.run(call) } else { #"{"error":"unknown_tool"}"# }
            guard self.callID == id else { return }
            try? await relay.answer(id: relayed.id, output: output)
        }
    }

    /// Sends the greeting request `GreetingGate.delay` after the gate opens and repeats it once if Volna stays silent
    /// for `GreetingGate.silenceTimeout`; after the last one the call is answered without a greeting.
    /// Greeting rules and the memory thread live in the core's session instructions.
    private func applyGreeting(_ action: GreetingGate.Action, trigger: String = "silence") {
        guard state.live, !state.isDemo else { return }
        switch action {
        case .none: return
        case .answer: didAnswer(trigger: trigger)
        case .request:
            let id = callID
            greetingTask?.cancel()
            greetingTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: GreetingGate.delay)
                // Live carries out the request only while the microphone flows; a ringback ping mutes it for 1.5 s,
                // and the 4 s repeat fell into the next ping too: two calls on 26.09.2026 had no greeting at all.
                while self?.ringback.toneOn == true, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) }
                guard let self, !Task.isCancelled, self.callID == id, self.state.live else { return }
                CallLaunchDiagnostics.record("greeting.request \(self.greeting.requests)")
                self.transport.requestGreeting()
                try? await Task.sleep(for: GreetingGate.silenceTimeout)
                guard !Task.isCancelled, self.callID == id, self.state.live else { return }
                self.applyGreeting(self.greeting.silenceTimedOut())
            }
        }
    }

    private func applyMute(_ muted: Bool) {
        dispatch(.muteChanged(muted))
        transport.setMuted(muted)
    }

    private func finish(error message: String) {
        CallLaunchDiagnostics.record("call.failed")
        let id = callID
        cleanup()
        dispatch(.failed(message))
        if let id { system.reportFailed(id: id) }
    }

    private func cleanup() {
        CallLaunchDiagnostics.record("call.cleanup")
        callID = nil
        networkTask?.cancel(); networkTask = nil
        deadline?.cancel(); deadline = nil
        thinkingTimeout?.cancel(); thinkingTimeout = nil
        demoTask?.cancel(); demoTask = nil
        greetingTask?.cancel(); greetingTask = nil
        relayTask?.cancel(); relayTask = nil
        ringDeadline?.cancel(); ringDeadline = nil
        callbackTask = nil
        greeting = GreetingGate()
        ringback.stop()
        waitMusicPlayer.stop()
        waitMusic = WaitMusic(enabled: false)
        transport.close()
        audio.end()
        voiceLevel = nil
    }
}

extension CallCoordinator: SystemCallDelegate {
    func systemCallShouldStart(id: UUID) -> Bool {
        guard callID == id else { return false }
        ringDeadline?.cancel(); ringDeadline = nil
        do { try audio.configureSession() }
        catch { finish(error: error.localizedDescription); return false }
        audio.begin()
        beginConnection(id: id)
        return true
    }
    func systemCallDidEnd(id: UUID) {
        // Ignore a late end action belonging to a previous call.
        guard callID == id else { return }
        cleanup()
        dispatch(.ended)
    }
    func systemCallDidSetMuted(id: UUID, muted: Bool) {
        guard callID == id else { return }
        applyMute(muted)
    }
    func systemCallDidActivateAudio(_ session: AVAudioSession) {
        guard active else { return }
        audio.sessionDidActivate(session)
        if Ringback.shouldRing(phase: phase, isDemo: state.isDemo, isCallback: callbackTask != nil) { ringback.start() }
        applyGreeting(greeting.audioDidActivate())
    }
    func systemCallDidDeactivateAudio(_ session: AVAudioSession) {
        ringback.stop()
        waitMusicPlayer.stop()
        audio.sessionDidDeactivate(session)
    }
    func systemCallDidReset() {
        cleanup()
        dispatch(.ended)
    }
    func systemCallTimedOut() {
        if active { finish(error: CallCopy.callKitFailed) }
    }
}
