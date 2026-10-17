import Foundation

/// Deep links that open a *new* session in the agent's own app with the text already typed as the user's input.
/// Found in the apps' bundles (not documented): Claude Desktop `claude://code/new?folder=…&q=…`,
/// ChatGPT/Codex `codex://threads/new?prompt=…&mode=work`.
public enum NewSessionLink {
    public static func claude(folder: String?, prompt: String) -> URL? {
        var components = URLComponents()
        components.scheme = "claude"
        components.host = "code"
        components.path = "/new"
        var items = [URLQueryItem(name: "q", value: prompt), URLQueryItem(name: "source", value: "volna_pult")]
        if let folder, !folder.isEmpty { items.insert(URLQueryItem(name: "folder", value: folder), at: 0) }
        components.queryItems = items
        return components.url
    }

    /// Codex takes no folder in the link; the project is chosen in the app.
    public static func codex(prompt: String) -> URL? {
        var components = URLComponents()
        components.scheme = "codex"
        components.host = "threads"
        components.path = "/new"
        components.queryItems = [URLQueryItem(name: "prompt", value: prompt), URLQueryItem(name: "mode", value: "work")]
        return components.url
    }
}
