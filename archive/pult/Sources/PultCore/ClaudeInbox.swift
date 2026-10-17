import Foundation

/// Posts one frame into a Claude Code session's inbox socket (`/tmp/cc-socks/<pid>.sock`).
/// The socket is documented for scripts and hooks; the frame shape is recorded in docs/mac-agent-hub.md.
public enum ClaudeInbox {
    /// The frame a session accepts on its inbox: the same `user` message shape as stream-json input.
    /// Verified 22.09.2026 on Claude Code 2.1.278; the session's own --debug log prints this recipe.
    public static func userFrame(text: String, from sender: String? = nil) -> JSONValue {
        var frame: [String: JSONValue] = ["type": "user", "message": ["role": "user", "content": .string(text)]]
        if let sender { frame["from"] = .string(sender) }
        return .object(frame)
    }

    /// Posts one message into the session behind `socketPath`. The session starts a turn with it when idle,
    /// or reads it between tool calls; `crossSessionInbound` on the receiving side may hold or refuse it.
    public static func post(text: String, from sender: String? = nil, to socketPath: String, token: String? = nil) throws {
        var lines: [String] = []
        if let token { lines.append(try JSONValue.object(["type": "auth", "token": .string(token)]).serialized()) }
        lines.append(try userFrame(text: text, from: sender).serialized())
        _ = try send(lines: lines, to: socketPath, timeout: 1)
    }

    /// Sends raw lines and returns whatever the session answers within `timeout` seconds.
    public static func send(lines: [String], to socketPath: String, timeout: TimeInterval = 3) throws -> [String] {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ClaudeError.socket("socket() failed: \(errno)") }
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw ClaudeError.socket("path too long") }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: pathBytes)
            buffer[pathBytes.count] = 0
        }
        let length = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1 + 1)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, length) }
        }
        guard connected == 0 else { throw ClaudeError.socket("connect failed: \(String(cString: strerror(errno)))") }
        let payload = lines.map { $0 + "\n" }.joined()
        var bytes = Array(payload.utf8)
        while !bytes.isEmpty {
            let written = bytes.withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
            guard written > 0 else { throw ClaudeError.socket("write failed: \(String(cString: strerror(errno)))") }
            bytes.removeFirst(written)
        }
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - Double(Int(timeout))) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var received = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count <= 0 { break }
            received.append(contentsOf: buffer[0..<count])
        }
        return String(decoding: received, as: UTF8.self).split(separator: "\n").map(String.init)
    }
}
