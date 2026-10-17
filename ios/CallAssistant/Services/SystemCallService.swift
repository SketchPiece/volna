import Foundation
import AVFAudio
import CallKit
import Intents
import UIKit

/// Callbacks the system (CallKit or the simulator stand-in) sends to the coordinator.
@MainActor
protocol SystemCallDelegate: AnyObject {
    /// The system is ready to start the call (placed by us, or an incoming callback the owner answered).
    /// Return false to reject (unknown call id or audio setup failed).
    func systemCallShouldStart(id: UUID) -> Bool
    func systemCallDidEnd(id: UUID)
    func systemCallDidSetMuted(id: UUID, muted: Bool)
    func systemCallDidActivateAudio(_ session: AVAudioSession)
    func systemCallDidDeactivateAudio(_ session: AVAudioSession)
    func systemCallDidReset()
    func systemCallTimedOut()
}

/// Owns the relationship with the phone's call system. The coordinator never touches CallKit directly.
@MainActor
protocol SystemCallService: AnyObject {
    var delegate: SystemCallDelegate? { get set }
    /// Asks the system to place the call. Returns once the request is accepted; `systemCallShouldStart` follows.
    func requestStart(id: UUID) async throws
    func requestEnd(id: UUID)
    func requestMute(id: UUID, muted: Bool)
    func reportConnected(id: UUID)
    func reportFailed(id: UUID)
    /// Volna calls the owner back (VoIP push): the system rings; `systemCallShouldStart` follows when answered.
    /// `completion` runs once the system accepted or refused the call (Do Not Disturb, blocked, another call).
    func reportIncoming(id: UUID, completion: @escaping (Error?) -> Void)
    /// The owner did not answer the ringing callback in time.
    func reportUnanswered(id: UUID)
}

// MARK: - CallKit (real devices)

@MainActor
final class CallKitCallService: NSObject, SystemCallService {
    weak var delegate: SystemCallDelegate?
    private let provider: CXProvider
    private let controller = CXCallController()
    /// Callbacks Volna placed: answered through CXAnswerCallAction, not reported as outgoing.
    private var incoming: Set<UUID> = []

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    func requestStart(id: UUID) async throws {
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: WaveContact.handle))
        action.isVideo = false
        CallLaunchDiagnostics.record("callkit.request state=\(UIApplication.shared.applicationState.rawValue) protectedData=\(UIApplication.shared.isProtectedDataAvailable)")
        do { try await controller.request(CXTransaction(action: action)) }
        catch {
            CallLaunchDiagnostics.record("callkit.failed code=\((error as NSError).code)")
            throw error
        }
        CallLaunchDiagnostics.record("callkit.accepted")
    }

    func requestEnd(id: UUID) {
        controller.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] error in
            if error != nil { Task { @MainActor in self?.provider.reportCall(with: id, endedAt: Date(), reason: .remoteEnded) } }
        }
    }

    func requestMute(id: UUID, muted: Bool) {
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { _ in }
    }

    func reportConnected(id: UUID) {
        // An answered incoming call is already connected for CallKit; Siri learns only from calls the owner places.
        if incoming.contains(id) { return }
        provider.reportOutgoingCall(with: id, connectedAt: Date())
        // Teach Siri that this app places calls to Volna.
        let interaction = INInteraction(intent: WaveContact.callIntent(), response: nil)
        interaction.identifier = "volna-\(id.uuidString)"
        interaction.groupIdentifier = "volna-calls"
        interaction.direction = .outgoing
        interaction.donate { error in
            CallLaunchDiagnostics.record("interaction.donate code=\((error as NSError?)?.code ?? 0)")
        }
    }

    func reportFailed(id: UUID) {
        incoming.remove(id)
        provider.reportCall(with: id, endedAt: Date(), reason: .failed)
    }

    func reportIncoming(id: UUID, completion: @escaping (Error?) -> Void) {
        incoming.insert(id)
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: WaveContact.handle)
        update.localizedCallerName = "Волна"
        update.hasVideo = false
        update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false; update.supportsDTMF = false
        provider.reportNewIncomingCall(with: id, update: update) { error in
            Task { @MainActor in
                CallLaunchDiagnostics.record("callkit.incoming code=\((error as NSError?)?.code ?? 0)")
                if error != nil { self.incoming.remove(id) }
                completion(error)
            }
        }
    }

    func reportUnanswered(id: UUID) {
        incoming.remove(id)
        provider.reportCall(with: id, endedAt: Date(), reason: .unanswered)
    }
}

extension CallKitCallService: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in self.delegate?.systemCallDidReset() }
    }
    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            CallLaunchDiagnostics.record("provider.start state=\(UIApplication.shared.applicationState.rawValue)")
            guard self.delegate?.systemCallShouldStart(id: action.callUUID) == true else { action.fail(); return }
            let update = CXCallUpdate()
            update.remoteHandle = CXHandle(type: .generic, value: WaveContact.handle)
            update.localizedCallerName = "Волна"
            update.hasVideo = false
            update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false
            provider.reportCall(with: action.callUUID, updated: update)
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
            action.fulfill()
            CallLaunchDiagnostics.record("provider.start.fulfilled")
        }
    }
    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            CallLaunchDiagnostics.record("provider.answer state=\(UIApplication.shared.applicationState.rawValue)")
            guard self.delegate?.systemCallShouldStart(id: action.callUUID) == true else { action.fail(); return }
            action.fulfill()
        }
    }
    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            self.incoming.remove(action.callUUID)
            self.delegate?.systemCallDidEnd(id: action.callUUID)
            action.fulfill()
            CallLaunchDiagnostics.record("call.ended")
        }
    }
    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            self.delegate?.systemCallDidSetMuted(id: action.callUUID, muted: action.isMuted)
            action.fulfill()
        }
    }
    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in
            CallLaunchDiagnostics.record("audio.activated state=\(UIApplication.shared.applicationState.rawValue) protectedData=\(UIApplication.shared.isProtectedDataAvailable)")
            self.delegate?.systemCallDidActivateAudio(audioSession)
        }
    }
    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in
            self.delegate?.systemCallDidDeactivateAudio(audioSession)
            CallLaunchDiagnostics.record("audio.deactivated")
        }
    }
    nonisolated func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        Task { @MainActor in self.delegate?.systemCallTimedOut() }
    }
}

// MARK: - Simulator

/// CallKit cannot place calls reliably in Simulator: activate the audio session directly.
@MainActor
final class SimulatorCallService: SystemCallService {
    weak var delegate: SystemCallDelegate?
    private var activated = false

    func requestStart(id: UUID) async throws {
        guard delegate?.systemCallShouldStart(id: id) == true else { throw VoiceError.message(CallCopy.callKitFailed) }
        let session = AVAudioSession.sharedInstance()
        try session.setActive(true)
        activated = true
        delegate?.systemCallDidActivateAudio(session)
    }

    func requestEnd(id: UUID) {
        guard activated else { return }
        activated = false
        let session = AVAudioSession.sharedInstance()
        delegate?.systemCallDidDeactivateAudio(session)
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }

    func requestMute(id: UUID, muted: Bool) {
        delegate?.systemCallDidSetMuted(id: id, muted: muted)
    }

    func reportConnected(id: UUID) {}
    func reportFailed(id: UUID) { requestEnd(id: id) }

    /// No ringing in Simulator: the callback is answered at once, like a tap on «Accept».
    func reportIncoming(id: UUID, completion: @escaping (Error?) -> Void) {
        completion(nil)
        Task { @MainActor in try? await self.requestStart(id: id) }
    }
    func reportUnanswered(id: UUID) { requestEnd(id: id) }
}
