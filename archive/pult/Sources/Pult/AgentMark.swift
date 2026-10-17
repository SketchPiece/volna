import SwiftUI
import AppKit

/// The agents' brand marks (Simple Icons: Claude in its terracotta, OpenAI in bakelite), bundled as PNG by scripts/make-pult-icons.swift.
struct AgentMark: View {
    enum Vendor { case claude, openAI }
    var vendor: Vendor
    var size: CGFloat = 16

    private static let claude = load("claude-logo")
    private static let openAI = load("openai-logo")

    private static func load(_ name: String) -> NSImage? {
        guard let resources = Bundle.main.resourceURL, let image = NSImage(contentsOf: resources.appendingPathComponent(name + ".png")) else { return nil }
        if let retina = NSImage(contentsOf: resources.appendingPathComponent(name + "@2x.png"))?.representations.first { image.addRepresentation(retina) }
        image.size = NSSize(width: 18, height: 18)
        return image
    }

    var body: some View {
        Group {
            if let image = vendor == .claude ? Self.claude : Self.openAI {
                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: vendor == .claude ? "asterisk" : "circle.hexagongrid").font(.system(size: size * 0.7)).foregroundStyle(Theme.ink2)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(vendor == .claude ? "Claude" : "OpenAI")
    }
}
