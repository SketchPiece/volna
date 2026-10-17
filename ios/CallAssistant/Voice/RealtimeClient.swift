import Foundation
import AVFAudio
import WebRTC

/// WebRTC transport: microphone track, data channel `oai-events`, SDP exchange through the core,
/// plus audio-level polling from connection statistics for the wave mark.
@MainActor
final class RealtimeClient: NSObject, RealtimeTransport {
    var handler: ((RealtimeEvent) -> Void)?
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var audioTrack: RTCAudioTrack?
    private var generation = UUID()
    private var announcedReady = false
    /// Триггер приветствия. Правила приветствия (фраза, нить из памяти) лежат в инструкциях сессии в ядре;
    /// здесь только просьба применить их. GPT-Live исполняет её, только если входной звук уже идёт, поэтому
    /// момент отправки выбирает координатор (`GreetingGate`): после `session.started` и активации аудиосессии,
    /// а не из ядра при открытии sideband (проверено 22.09.2026: из ядра приветствие откладывалось до первой реплики).
    static let greetingInstruction = "Поздоровайся сейчас по-русски, как сказано в правиле приветствия в инструкциях, и дальше слушай."
    /// Перезвон Волны: вместо приветствия ядро кладёт в инструкции правило начала звонка с итогами заданий. Итогов может
    /// не оказаться (задание не найдено): тогда ядро ведёт звонок как обычный, с правилом приветствия.
    static let callbackOpeningInstruction = "Начни звонок сейчас по-русски, как сказано в правиле начала звонка в инструкциях: сразу расскажи, что сделано и какой результат; если такого правила нет, поздоровайся по правилу приветствия. Дальше слушай."
    private var isCallback = false
    private var levelTask: Task<Void, Never>?
    private var smoothedInput = 0.0
    private var smoothedOutput = 0.0
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    func connect(settings: ConnectionSettings, deviceTools: [String], callbackTask: String?) async throws {
        close()
        isCallback = callbackTask != nil
        let current = generation
        let url = try settings.sessionURL()
        let voice = settings.voice.rawValue
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw VoiceError.message("Не удалось создать аудиосоединение.")
        }
        peer = pc
        let source = Self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil,
            optionalConstraints: ["googEchoCancellation": "true", "googNoiseSuppression": "true", "googAutoGainControl": "true"]))
        let track = Self.factory.audioTrack(with: source, trackId: "microphone")
        audioTrack = track
        pc.add(track, streamIds: ["voice"])
        let dc = RTCDataChannelConfiguration()
        dc.isOrdered = true
        channel = pc.dataChannel(forLabel: "oai-events", configuration: dc)
        channel?.delegate = self
        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            pc.offer(for: RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)) { sdp, error in
                if let error { continuation.resume(throwing: error) }
                else if let sdp { continuation.resume(returning: sdp) }
                else { continuation.resume(throwing: VoiceError.message("Пустое SDP-предложение.")) }
            }
        }
        try check(current)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(offer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        // Include candidates when available; never wait indefinitely for ICE gathering.
        for _ in 0..<30 {
            try check(current)
            if pc.iceGatheringState == .complete { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        try check(current)
        var request = URLRequest(url: url, timeoutInterval: 25)
        request.httpMethod = "POST"
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.setValue(voice, forHTTPHeaderField: "X-Realtime-Voice")
        if !deviceTools.isEmpty { request.setValue(deviceTools.joined(separator: ","), forHTTPHeaderField: "X-Device-Tools") }
        if let callbackTask { request.setValue(callbackTask, forHTTPHeaderField: "X-Callback-Task") }
        if settings.waitMusic { request.setValue("on", forHTTPHeaderField: "X-Wait-Music") }
        if !settings.token.isEmpty { request.setValue("Bearer \(settings.token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = Data((pc.localDescription?.sdp ?? offer.sdp).utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(current)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw VoiceError.message(body?["error"] as? String ?? "Ядро не смогло подключить звонок.")
        }
        let answer = String(decoding: data, as: UTF8.self)
        guard answer.hasPrefix("v=0") else { throw VoiceError.message("Ядро вернуло неверный ответ.") }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        try check(current)
        startLevelPolling(pc, generation: current)
    }

    func setMuted(_ muted: Bool) { audioTrack?.isEnabled = !muted }
    func requestGreeting() {
        send(["type": "session.instructions.append", "delegation_id": NSNull(), "content": isCallback ? Self.callbackOpeningInstruction : Self.greetingInstruction])
    }
    func close() {
        generation = UUID()
        levelTask?.cancel(); levelTask = nil
        smoothedInput = 0; smoothedOutput = 0
        audioTrack?.isEnabled = false
        channel?.delegate = nil
        channel?.close()
        peer?.delegate = nil
        peer?.close()
        channel = nil; peer = nil; audioTrack = nil; announcedReady = false
    }
    private func check(_ value: UUID) throws {
        try Task.checkCancellation()
        if value != generation { throw CancellationError() }
    }
    private func send(_ event: [String: Any]) {
        guard channel?.readyState == .open, let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        channel?.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    // MARK: - Audio levels

    /// Polls `media-source` (microphone) and `inbound-rtp` (Volna) audio levels ten times per second.
    private func startLevelPolling(_ pc: RTCPeerConnection, generation current: UUID) {
        levelTask?.cancel()
        levelTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.generation == current else { return }
                let raw = await Self.audioLevels(pc)
                guard self.generation == current else { return }
                // 80 ms smoothing: fast attack, slower release.
                self.smoothedInput = raw.input > self.smoothedInput ? raw.input : self.smoothedInput * 0.6 + raw.input * 0.4
                self.smoothedOutput = raw.output > self.smoothedOutput ? raw.output : self.smoothedOutput * 0.6 + raw.output * 0.4
                self.handler?(.level(input: min(1, self.smoothedInput * 3), output: min(1, self.smoothedOutput * 3)))
            }
        }
    }

    private static func audioLevels(_ pc: RTCPeerConnection) async -> (input: Double, output: Double) {
        await withCheckedContinuation { continuation in
            pc.statistics { report in
                var input = 0.0, output = 0.0
                for stat in report.statistics.values {
                    guard (stat.values["kind"] as? String) == "audio", let level = stat.values["audioLevel"] as? NSNumber else { continue }
                    if stat.type == "media-source" { input = max(input, level.doubleValue) }
                    if stat.type == "inbound-rtp" { output = max(output, level.doubleValue) }
                }
                continuation.resume(returning: (input, output))
            }
        }
    }
}

extension RealtimeClient: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        Task { @MainActor [weak self] in
            guard let self, self.channel === dataChannel,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { return }
            if type == "session.started", !self.announcedReady {
                self.announcedReady = true
                self.handler?(.ready)
            }
            if type == "error" {
                let error = json["error"] as? [String: Any]
                let code = error?["code"] as? String ?? ""
                self.handler?(.failure("Ошибка GPT-Live: \(error?["message"] as? String ?? code)"))
            }
            self.handler?(.message(type: type, payload: json))
        }
    }
}
extension RealtimeClient: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor [weak self] in
            guard let self, self.peer === peerConnection else { return }
            if newState == .failed || newState == .disconnected { self.handler?(.failure(CallCopy.linkLost)) }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
