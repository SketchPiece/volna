import Foundation
import AVFAudio
import UIKit
import WebRTC

/// Audio session configuration, output routing, proximity handling and session-level failures.
/// Holds no call state: it reports route changes and fatal audio events to its owner.
@MainActor
final class AudioRouting {
    struct Route: Equatable { var isSpeaker: Bool; var name: String }

    var onRouteChanged: ((Route) -> Void)?
    /// A fatal audio event (interruption began, media services reset) with a user-facing message.
    var onFatal: ((String) -> Void)?
    /// A recoverable problem worth showing to the user.
    var onWarning: ((String) -> Void)?

    private(set) var isActive = false
    private var enabled = false
    private var changing = false
    private var observations: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observations.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.applyAutomaticRoute() }
        })
        observations.append(center.addObserver(forName: UIDevice.proximityStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.applyAutomaticRoute() }
        })
        observations.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in if self?.enabled == true { self?.onFatal?(CallCopy.audioReset) } }
        })
        observations.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            Task { @MainActor in
                if raw == AVAudioSession.InterruptionType.began.rawValue, self?.enabled == true { self?.onFatal?(CallCopy.audioInterrupted) }
            }
        })
    }

    /// WebRTC in manual mode plus the voice-chat category. Called before the system starts the call.
    func configureSession() throws {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.useManualAudio = true
        rtc.isAudioEnabled = false
        let configuration = RTCAudioSessionConfiguration.webRTC()
        configuration.category = AVAudioSession.Category.playAndRecord.rawValue
        configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
        configuration.categoryOptions = [.allowBluetoothHFP]
        RTCAudioSessionConfiguration.setWebRTC(configuration)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        // iOS mutes haptics while the mic records; the call screen's taps and phase ticks need them.
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.01)
    }

    /// Automatic routing and fatal-event reporting are on only during a real call.
    func begin() {
        enabled = true
        reportRoute()
    }

    func end() {
        enabled = false
        isActive = false
        UIDevice.current.isProximityMonitoringEnabled = false
        RTCAudioSession.sharedInstance().isAudioEnabled = false
    }

    func sessionDidActivate(_ session: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidActivate(session)
        isActive = true
        applyAutomaticRoute()
        RTCAudioSession.sharedInstance().isAudioEnabled = true
    }

    func sessionDidDeactivate(_ session: AVAudioSession) {
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(session)
        isActive = false
        UIDevice.current.isProximityMonitoringEnabled = false
    }

    var current: Route {
        let output = AVAudioSession.sharedInstance().currentRoute.outputs.first
        return Route(isSpeaker: output?.portType == .builtInSpeaker, name: output?.portName ?? "Аудио")
    }

    private func reportRoute() { onRouteChanged?(current) }

    private func applyAutomaticRoute() {
        reportRoute()
        guard enabled, isActive, !changing else { return }
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs
        // Respect the system's selected headset, Bluetooth, USB or AirPlay route.
        let builtIn = !outputs.isEmpty && outputs.allSatisfy { $0.portType == .builtInSpeaker || $0.portType == .builtInReceiver }
        UIDevice.current.isProximityMonitoringEnabled = builtIn
        guard builtIn else { return }
        let near = UIDevice.current.isProximityMonitoringEnabled && UIDevice.current.proximityState
        // Loudspeaker by default; the receiver only while the phone is at the ear.
        let wantsSpeaker = !near
        guard wantsSpeaker != current.isSpeaker else { return }
        changing = true
        defer { changing = false; reportRoute() }
        do { try session.overrideOutputAudioPort(wantsSpeaker ? .speaker : .none) }
        catch { onWarning?(CallCopy.autoSpeakerFailed) }
    }
}
