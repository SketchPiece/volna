import SwiftUI
import CoreText

/// «Бакелит и лампа» tokens, copied from docs/design/volna-design-system.html.
enum Theme {
    static let ivory = Color(red: 0xE7 / 255, green: 0xE0 / 255, blue: 0xD2 / 255)
    static let bakelite = Color(red: 0x26 / 255, green: 0x21 / 255, blue: 0x1D / 255)
    static let ink2 = Color(red: 0x5E / 255, green: 0x55 / 255, blue: 0x4B / 255)
    static let signal = Color(red: 0xB8 / 255, green: 0x32 / 255, blue: 0x1F / 255)
    static let lamp = Color(red: 0xE8 / 255, green: 0xA3 / 255, blue: 0x3D / 255)
    static let lampHot = Color(red: 0xF2 / 255, green: 0xB5 / 255, blue: 0x50 / 255)
    static let lampDim = Color(red: 0x9C / 255, green: 0x7A / 255, blue: 0x45 / 255)
    static let lampOff = Color(red: 0xCF / 255, green: 0xC6 / 255, blue: 0xB6 / 255)
    static let shade = Color(red: 0xBF / 255, green: 0xB6 / 255, blue: 0xA6 / 255)
    static let light = Color(red: 0xFB / 255, green: 0xF6 / 255, blue: 0xEC / 255)
    /// Green «magic eye» of a tube radio: only the panel's "session is working" lamp; settings keep the amber accent.
    static let eye = Color(red: 0x3F / 255, green: 0xA6 / 255, blue: 0x5E / 255)
    static let eyeHot = Color(red: 0x6F / 255, green: 0xD4 / 255, blue: 0x8C / 255)
    static let line = Color(red: 0x26 / 255, green: 0x21 / 255, blue: 0x1D / 255).opacity(0.14)

    static func display(_ size: CGFloat) -> Font { .custom("Unbounded", size: size).weight(.semibold) }
    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font { .custom("IBM Plex Sans", size: size).weight(weight) }
    static func mono(_ size: CGFloat) -> Font { .custom("IBM Plex Mono", size: size).weight(.medium) }

    /// Registers the bundled fonts; falls back to system faces silently when the bundle has none.
    static func registerFonts() {
        guard let folder = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
              let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "ttf" {
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }
}

struct Lamp: View {
    enum Kind { case live, hot, on, dim, off }
    var kind: Kind
    var size: CGFloat = 10
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if kind == .live {
            // Breathing is computed from the clock, not withAnimation(.repeatForever): a repeating animation started
            // in onAppear captured the MenuBarExtra window's own layout and kept the whole panel swaying.
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                let phase = reduceMotion ? 1 : (sin(context.date.timeIntervalSinceReferenceDate * .pi / 0.9) + 1) / 2
                Circle()
                    .fill(Theme.eye)
                    .frame(width: size, height: size)
                    .shadow(color: Theme.eyeHot.opacity(0.45 + 0.5 * phase), radius: 1.5 + 4 * phase)
            }
            .frame(width: size, height: size)
        } else {
            Circle()
                .fill(color)
                .frame(width: size, height: size)
                .shadow(color: kind == .hot ? Theme.lampHot.opacity(0.9) : kind == .on ? Theme.lamp.opacity(0.8) : .clear, radius: kind == .off || kind == .dim ? 0 : 5)
                .overlay(Circle().stroke(kind == .off ? Theme.shade : .clear, lineWidth: 1))
        }
    }

    private var color: Color {
        switch kind {
        case .live: return Theme.eye
        case .hot: return Theme.lampHot
        case .on: return Theme.lamp
        case .dim: return Theme.lampDim
        case .off: return Theme.lampOff
        }
    }
}

struct StatusPill: View {
    var text: String
    var lamp: Lamp.Kind
    var body: some View {
        HStack(spacing: 7) {
            Lamp(kind: lamp, size: 8)
            Text(text).font(Theme.mono(10)).tracking(1.2)
        }
        .padding(.horizontal, 11).padding(.vertical, 6)
        .background(Capsule().fill(Theme.ivory).shadow(color: Theme.shade, radius: 3, x: 2, y: 2).shadow(color: Theme.light, radius: 3, x: -2, y: -2))
        .foregroundStyle(Theme.ink2)
    }
}

struct RaisedButtonStyle: ButtonStyle {
    var signal = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(signal ? Theme.display(11) : Theme.body(12.5, weight: .semibold))
            .foregroundStyle(signal ? Theme.light : (configuration.isPressed ? Theme.signal : Theme.bakelite))
            .padding(.horizontal, 14).frame(height: 30)
            .background(
                Capsule().fill(signal ? Theme.signal : Theme.ivory)
                    .shadow(color: configuration.isPressed ? .clear : Theme.shade, radius: 4, x: 3, y: 3)
                    .shadow(color: configuration.isPressed ? .clear : Theme.light, radius: 4, x: -3, y: -3)
            )
            .opacity(configuration.isPressed && !signal ? 0.85 : 1)
    }
}

/// A small round raised key for a single icon (the «+» in the panel header, the day stepper in settings).
struct RoundKeyStyle: ButtonStyle {
    var size: CGFloat = 28
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(configuration.isPressed ? Theme.signal : Theme.bakelite)
            .frame(width: size, height: size)
            .background(
                Circle().fill(configuration.isPressed ? Theme.shade.opacity(0.35) : Theme.ivory)
                    .shadow(color: configuration.isPressed ? .clear : Theme.shade, radius: 3, x: 2, y: 2)
                    .shadow(color: configuration.isPressed ? .clear : Theme.light, radius: 3, x: -2, y: -2)
            )
            .contentShape(Circle())
    }
}

/// A secondary action that looks like a button only on hover or press: flat text, then an inset capsule.
struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { QuietButton(configuration: configuration) }

    private struct QuietButton: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(Theme.body(12.5, weight: .semibold))
                .foregroundStyle(configuration.isPressed ? Theme.signal : Theme.ink2)
                .padding(.horizontal, 12).frame(height: 30)
                .background(Capsule().fill(hovering || configuration.isPressed ? Theme.shade.opacity(0.35) : .clear))
                .contentShape(Capsule())
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
        }
    }
}
