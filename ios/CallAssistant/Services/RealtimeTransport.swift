import Foundation

/// What the coordinator hears from the Realtime connection.
enum RealtimeEvent {
    /// `session.started` arrived: audio and events are flowing.
    case ready
    /// Fatal transport error with a user-facing message.
    case failure(String)
    /// Any GPT-Live server event by type with its raw payload.
    case message(type: String, payload: [String: Any])
    /// Smoothed audio levels 0…1 for the microphone and for Volna's voice.
    case level(input: Double, output: Double)
}

/// Transport to GPT-Live. `RealtimeClient` is the WebRTC implementation; tests can stub it.
/// There is no interrupt: the model is full duplex. The greeting is requested by the coordinator through `requestGreeting()`
/// once `session.started` arrived and the audio session is active (`GreetingGate`); the greeting rules live in the core's
/// session instructions.
@MainActor
protocol RealtimeTransport: AnyObject {
    var handler: ((RealtimeEvent) -> Void)? { get set }
    /// `deviceTools`: names of phone tools with granted permissions, announced to the core in `X-Device-Tools`.
    /// `callbackTask`: Volna called back about this background task (`X-Callback-Task`); the core opens with its result.
    func connect(settings: ConnectionSettings, deviceTools: [String], callbackTask: String?) async throws
    func setMuted(_ muted: Bool)
    /// Asks the model to greet now (`session.instructions.append`); the rules of the greeting are in the session instructions.
    func requestGreeting()
    func close()
}
