import SwiftUI

// MARK: - Physical keys

/// A bakelite key: while held it shrinks a little and, when `shape` is given, sinks into the case (ivory keys take the
/// inset shadow, red keys darken). A light tick on touch-down, like a relay; the release springs back with a small overshoot.
/// Reduce Motion keeps the sink and the tick, drops the scale.
struct KeyPressStyle: ButtonStyle {
    var shape: AnyShape? = nil
    var scale: CGFloat = 0.94
    var darkens = false
    var feedback: SensoryFeedback = .impact(weight: .light)

    func makeBody(configuration: Configuration) -> some View {
        KeyPressBody(label: configuration.label, pressed: configuration.isPressed, style: self)
    }
}

private struct KeyPressBody<Label: View>: View {
    var label: Label
    var pressed: Bool
    var style: KeyPressStyle

    var body: some View {
        label
            .overlay {
                if pressed, let shape = style.shape {
                    Group {
                        if style.darkens { shape.fill(Color.black.opacity(0.18)) } else { InnerShadow(shape: shape, size: .sm) }
                    }
                    .allowsHitTesting(false)
                }
            }
            .modifier(PressMotion(pressed: pressed, scale: style.scale))
            .sensoryFeedback(style.feedback, trigger: pressed) { _, isDown in isDown }
    }
}

/// Quick sink, springy release. Shared by every pressable style so all keys feel like one set.
struct PressMotion: ViewModifier {
    var pressed: Bool
    var scale: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content
            .scaleEffect(pressed && !reduceMotion ? scale : 1)
            .animation(pressed ? .easeOut(duration: 0.08) : .spring(response: 0.32, dampingFraction: 0.55), value: pressed)
    }
}

// MARK: - Call events

/// Vibration for call phase changes. Pure, so the rules are unit-tested; the call screen only plays what this returns.
/// Speaking turns stay silent: a tick every time Volna starts talking would buzz at the ear all call long.
enum CallFeedback {
    static func phaseChange(from old: CallPhase, to new: CallPhase) -> SensoryFeedback? {
        switch (old, new) {
        case (.connecting, .listening), (.connecting, .thinking), (.connecting, .speaking): return .success
        case (_, .failed) where old != .failed: return .error
        case (.listening, .ended), (.thinking, .ended), (.speaking, .ended), (.connecting, .ended): return .impact(weight: .medium)
        default: return nil
        }
    }
}
