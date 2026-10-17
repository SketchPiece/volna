import Foundation

/// Phone tools (docs/core.md 4h): the core runs the delegation and queues the calls, the phone takes them with a long
/// poll to `/device-tools` and answers with POST. A core without delegation has no such route (404) and the poll stops.
/// Arguments and results are never logged.
struct DeviceToolRelay {
    var settings = ConnectionSettings()
    var session: URLSession = .shared
    /// How long one poll waits on the core for a call.
    static let wait: TimeInterval = 25

    struct Relayed: Decodable, Equatable {
        var id: String
        var name: String
        var arguments: String
    }

    enum Failure: Error, Equatable {
        /// The core does not relay phone tools (no OpenRouter key or an older core).
        case unavailable
        case failed
    }

    /// One poll's answer: calls to run and, from a core with tasks, ids of the running work (for `WaitMusic`).
    struct Poll: Decodable, Equatable {
        var calls: [Relayed]
        var working: [String]?
    }

    /// `immediate`: answer at once without waiting for calls; the first poll of a call reads the work already running.
    func next(immediate: Bool = false) async throws -> Poll {
        let wait = immediate ? 0 : Int(Self.wait * 1000)
        return try Self.poll(from: try await request("GET", path: nil, query: "wait=\(wait)", body: nil, timeout: Self.wait + 10))
    }

    func answer(id: String, output: String) async throws {
        _ = try await request("POST", path: id, query: nil, body: ["output": output], timeout: 10)
    }

    static func poll(from data: Data) throws -> Poll {
        try JSONDecoder().decode(Poll.self, from: data)
    }

    /// The runner's call for a relayed one; nil for names the phone does not own.
    static func toolCall(_ relayed: Relayed) -> DeviceToolCall? {
        guard let name = DeviceToolName(rawValue: relayed.name) else { return nil }
        return DeviceToolCall(callID: relayed.id, name: name, arguments: Data(relayed.arguments.utf8))
    }

    private func request(_ method: String, path: String?, query: String?, body: [String: String]?, timeout: TimeInterval) async throws -> Data {
        var url = try settings.sessionURL().deletingLastPathComponent().appendingPathComponent("device-tools")
        if let path { url.appendPathComponent(path) }
        if let query, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.query = query
            url = components.url ?? url
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        let token = settings.token
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404, method == "GET" { throw Failure.unavailable }
        guard status == 200 else { throw Failure.failed }
        return data
    }
}
