import Foundation

/// Wires services into the coordinator. The only place that knows about the simulator.
@MainActor
enum AppContainer {
    static func makeCoordinator() -> CallCoordinator {
        CallCoordinator(system: makeSystemCallService(), audio: AudioRouting(), transport: RealtimeClient(),
                        tools: DeviceToolRunner(store: SystemDeviceToolStore()))
    }

    private static func makeSystemCallService() -> SystemCallService {
        #if targetEnvironment(simulator)
        SimulatorCallService()
        #else
        CallKitCallService()
        #endif
    }
}
