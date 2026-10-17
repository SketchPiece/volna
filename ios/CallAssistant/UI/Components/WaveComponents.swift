import SwiftUI

// MARK: - Lamps and status

struct Lamp: View {
    var state: LampState
    var blinking = false
    var size: CGFloat = 12
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: !blinking || reduceMotion)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Circle()
                .fill(color)
                .overlay { if state == .off { Circle().stroke(Color(hex: 0xA89F90).opacity(0.5), lineWidth: 0.5) } }
                .shadow(color: state == .off ? .clear : color.opacity(0.9), radius: state == .hot ? 5 : 4)
                .frame(width: size, height: size)
                .opacity(blinking && !reduceMotion ? 0.25 + 0.75 * (0.5 + 0.5 * sin(t * 2 * .pi / 1.1)) : 1)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
    private var color: Color {
        switch state {
        case .off: return Wave.Palette.lampOff
        case .on: return Wave.Palette.lamp
        case .hot: return Wave.Palette.lampHot
        }
    }
}

struct StatusPill: View {
    var text: String
    var lamp: LampState
    var blinking = false
    var body: some View {
        HStack(spacing: 8) {
            Lamp(state: lamp, blinking: blinking, size: 9)
            Text(text).font(Wave.Fonts.status).tracking(1.3).lineLimit(1)
        }
        .foregroundStyle(Wave.Palette.bakelite)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .pressed(in: Capsule(), .sm)
    }
}

// MARK: - Buttons

/// Raised capsule that sinks while pressed. `compact` is the small in-row variant (settings rows): smaller type and shadow,
/// so a column of them does not outweigh the card they sit on.
struct RaisedButtonStyle: ButtonStyle {
    var height: CGFloat = 48
    var horizontalPadding: CGFloat = 24
    var expands = false
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        let shadow: Wave.Shadow = compact ? .flat : .md
        configuration.label
            .font(compact ? Wave.Fonts.body(13, .semibold) : Wave.Fonts.label)
            .foregroundStyle(configuration.isPressed ? Wave.Palette.signal : Wave.Palette.bakelite)
            .padding(.horizontal, compact ? 14 : horizontalPadding)
            .frame(maxWidth: expands ? .infinity : nil)
            .frame(height: compact ? 32 : height)
            .background {
                if configuration.isPressed {
                    Color.clear.pressed(in: Capsule(), compact ? .flat : .md)
                } else {
                    Capsule().fill(Wave.Palette.ivory).raised(shadow)
                }
            }
            .contentShape(Capsule())
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
            .modifier(PressMotion(pressed: configuration.isPressed, scale: 0.95))
            .sensoryFeedback(.impact(weight: .light), trigger: configuration.isPressed) { _, isDown in isDown }
    }
}

/// A tappable settings row: sinks into the card while pressed, like the rows of the Mac panel.
struct PressableRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                if configuration.isPressed {
                    Color.clear.pressed(in: RoundedRectangle(cornerRadius: Wave.Radius.sm, style: .continuous), .flat)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                }
            }
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .modifier(PressMotion(pressed: configuration.isPressed, scale: 0.985))
            .sensoryFeedback(.selection, trigger: configuration.isPressed) { _, isDown in isDown }
    }
}

/// On/off as a pressed groove with a raised knob; the knob lights up amber when on (the accent, never a status colour).
/// While held the knob stretches toward the far end, like a lever about to flip; a click when it lands.
struct WaveToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: { EmptyView() }
            .buttonStyle(ToggleSwitchStyle(isOn: configuration.isOn))
            .sensoryFeedback(.impact(weight: .light), trigger: configuration.isOn)
            .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label } }
    }
}

private struct ToggleSwitchStyle: ButtonStyle {
    var isOn: Bool
    func makeBody(configuration: Configuration) -> some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            Color.clear.pressed(in: Capsule(), .flat)
                .overlay(Capsule().fill(Wave.Palette.lamp.opacity(isOn ? 0.22 : 0)))
            Capsule()
                .fill(isOn ? Wave.Palette.lamp : Wave.Palette.ivory)
                .frame(width: configuration.isPressed ? 28 : 22, height: 22)
                .raised(.flat)
                .shadow(color: isOn ? Wave.Palette.lamp.opacity(0.6) : .clear, radius: 5)
                .padding(4)
        }
        .frame(width: 52, height: 30)
        .contentShape(Capsule())
        .animation(.spring(response: 0.25, dampingFraction: 0.8), value: isOn)
        .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// The single red action on a screen.
struct SignalButtonStyle: ButtonStyle {
    var height: CGFloat = 64
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Wave.Fonts.cta)
            .foregroundStyle(Wave.Palette.light)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            // Shadow belongs to the capsule only; applying it to the whole label blurs the letters.
            .background { Capsule().fill(configuration.isPressed ? Wave.Palette.signalDeep : Wave.Palette.signal).raised() }
            .modifier(PressMotion(pressed: configuration.isPressed, scale: 0.97))
            .sensoryFeedback(.impact(weight: .medium), trigger: configuration.isPressed) { _, isDown in isDown }
    }
}

/// Text-only secondary action during a call.
struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Wave.Fonts.small)
            .foregroundStyle(configuration.isPressed ? Wave.Palette.signal : Wave.Palette.ink2)
            .padding(.horizontal, 12)
            .frame(height: 40)
            .contentShape(Rectangle())
            .modifier(PressMotion(pressed: configuration.isPressed, scale: 0.96))
    }
}

/// Round call control (mute, speaker, audio route). Pressed look means "on".
struct RoundControl: View {
    var symbol: String
    var label: String
    var selected: Bool
    /// 64 is the design-system default; the call screen uses 52 beside the end-call key.
    var diameter: CGFloat = 64
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: diameter < 60 ? 20 : 22, weight: .regular))
                    .foregroundStyle(selected ? Wave.Palette.signal : Wave.Palette.bakelite)
                    .frame(width: diameter, height: diameter)
                    .background {
                        if selected { Color.clear.pressed(in: Circle()) } else { Circle().fill(Wave.Palette.ivory).raised(diameter < 60 ? .sm : .md) }
                    }
                Text(label).font(Wave.Fonts.small).foregroundStyle(Wave.Palette.ink2).lineLimit(1).minimumScaleFactor(0.75)
            }
        }
        .buttonStyle(KeyPressStyle(scale: 0.92, feedback: .impact(flexibility: .rigid)))
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct EndCallButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "phone.down.fill")
                .font(.system(size: 26))
                .foregroundStyle(Wave.Palette.light)
                .frame(width: 72, height: 72)
                .background { Circle().fill(Wave.Palette.signal).raised() }
        }
        .buttonStyle(KeyPressStyle(shape: AnyShape(Circle()), scale: 0.92, darkens: true, feedback: .impact(weight: .medium)))
    }
}

/// The red key of the call screen: the wide «Позвонить Волне» capsule at rest, the round hang-up key in a call.
/// One view for both, so the capsule shrinks into the key and widens back (docs/design/canvas/home-idle, board «В»);
/// a capsule 72 × 72 is the circle of `EndCallButton`.
struct CallKey: View {
    var round: Bool
    /// Idle, folded to a 64 pt round key while the conversations scroll (docs/design/canvas/home-scroll, board «В»).
    var folded = false
    var title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "phone.fill")
                    .font(.system(size: round ? 26 : 17))
                    .rotationEffect(.degrees(round ? 135 : 0))
                if !round && !folded {
                    // Gone at once as the key starts to fold; back only once it has mostly widened.
                    Text(title).font(Wave.Fonts.cta).lineLimit(1).fixedSize()
                        .transition(.asymmetric(insertion: .opacity.animation(.easeOut(duration: 0.15).delay(0.18)),
                                                removal: .opacity.animation(.easeOut(duration: 0.06))))
                }
            }
            .foregroundStyle(Wave.Palette.light)
            .frame(maxWidth: round ? 72 : folded ? 64 : .infinity)
            .frame(width: folded && !round ? 64 : nil)
            .frame(height: round ? 72 : 64)
            // The fading title stays inside the key while it shrinks; the shadow below is not clipped.
            .clipShape(Capsule())
            .background { Capsule().fill(Wave.Palette.signal).raised() }
            .contentShape(Capsule())
        }
        .buttonStyle(KeyPressStyle(shape: AnyShape(Capsule()), scale: round ? 0.92 : 0.97, darkens: true, feedback: .impact(weight: .medium)))
    }
}

struct IconButton: View {
    var symbol: String
    var label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(Wave.Palette.bakelite)
                .frame(width: 44, height: 44)
                .background(Circle().fill(Wave.Palette.ivory).raised(.sm))
        }
        .buttonStyle(KeyPressStyle(shape: AnyShape(Circle()), scale: 0.9))
        .accessibilityLabel(label)
    }
}

// MARK: - Cards

struct ErrorCard: View {
    var title = "ЧТО СЛУЧИЛОСЬ"
    var text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Lamp(state: .off, size: 10)
                Text(title).font(Wave.Fonts.status).tracking(1.3).foregroundStyle(Wave.Palette.bakelite)
            }
            Text(text).font(Wave.Fonts.body(14)).foregroundStyle(Wave.Palette.bakelite).multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20).padding(.vertical, 18)
        .pressed(in: RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous))
    }
}

/// Everything Volna says lives on dark glass.
/// One line of the in-call transcript. Volna's lines sit in a barely sunken ivory card, the user's on the bare body.
struct TranscriptRow: View {
    var who: String
    var time: String
    var text: String
    var isWave: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(who)
                Spacer()
                Text(time)
            }
            .font(Wave.Fonts.mono(10.5, .medium)).tracking(1.5)
            .foregroundStyle(isWave ? Wave.Palette.lampDim : Wave.Palette.ink2)
            Text(text).font(Wave.Fonts.text).foregroundStyle(Wave.Palette.bakelite).lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, isWave ? 16 : 0).padding(.vertical, isWave ? 14 : 0)
        .background {
            if isWave {
                RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Wave.Palette.ivory)
                    .overlay { InnerShadow(shape: RoundedRectangle(cornerRadius: 20, style: .continuous), size: .flat) }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct AnswerCard: View {
    var title: String
    var text: String
    var footerLeading: String
    var footerTrailing: String
    /// Приглушённый текст: заводской характер вместо личных слов Волны.
    var muted = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(Wave.Fonts.status).tracking(1.5).foregroundStyle(Wave.Palette.lamp)
            Text(text).font(Wave.Fonts.text).foregroundStyle(muted ? Wave.Palette.etherMuted : Wave.Palette.etherText).lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                Text(footerLeading)
                Spacer()
                Text(footerTrailing)
            }
            .font(Wave.Fonts.mono(10)).tracking(1).foregroundStyle(Wave.Palette.etherMuted)
            .padding(.top, 10)
            .overlay(alignment: .top) { Rectangle().fill(Wave.Palette.etherLine).frame(height: 1) }
        }
        .padding(.horizontal, 20).padding(.vertical, 18)
        .background {
            RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous)
                .fill(Wave.Palette.ether)
                .overlay {
                    RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous)
                        .fill(RadialGradient(colors: [Wave.Palette.lamp.opacity(0.08), .clear], center: .center, startRadius: 0, endRadius: 220))
                }
        }
        .raised()
    }
}

struct SiriCard: View {
    var phrase: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "waveform").font(.system(size: 18)).foregroundStyle(Wave.Palette.bakelite)
                (Text("Siri, ") + Text(phrase).fontWeight(.semibold))
                    .font(Wave.Fonts.body(14)).foregroundStyle(Wave.Palette.bakelite)
                    .lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right").font(.system(size: 12)).foregroundStyle(Wave.Palette.ink2)
            }
            .padding(.horizontal, 18).padding(.vertical, 16)
            .background(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous).fill(Wave.Palette.ivory).raised())
        }
        .buttonStyle(KeyPressStyle(shape: AnyShape(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous)), scale: 0.97))
        .accessibilityLabel("Как настроить Siri")
    }
}

// MARK: - Rows, fields, groups

/// Selectable row (voice, audio route). Pressed look means selected.
struct SelectableRow: View {
    var title: String
    var detail: String? = nil
    var selected: Bool
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Text(title).font(Wave.Fonts.rowLabel).foregroundStyle(selected ? Wave.Palette.signal : Wave.Palette.bakelite)
                Spacer()
                if let detail { Text(detail).font(Wave.Fonts.body(12)).foregroundStyle(Wave.Palette.ink2) }
                Lamp(state: selected ? .on : .off)
            }
            .padding(.horizontal, 18)
            .frame(height: 56)
            .contentShape(RoundedRectangle(cornerRadius: Wave.Radius.sm, style: .continuous))
            .background {
                let shape = RoundedRectangle(cornerRadius: Wave.Radius.sm, style: .continuous)
                if selected { Color.clear.pressed(in: shape) } else { shape.fill(Wave.Palette.ivory).raised(.sm) }
            }
        }
        .buttonStyle(KeyPressStyle(shape: AnyShape(RoundedRectangle(cornerRadius: Wave.Radius.sm, style: .continuous)), scale: 0.97, feedback: .selection))
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Pressed capsule around a text field.
struct PressedField<Content: View>: View {
    var height: CGFloat = 48
    @ViewBuilder var content: Content
    var body: some View {
        content
            .font(Wave.Fonts.body(14))
            .foregroundStyle(Wave.Palette.bakelite)
            .padding(.horizontal, 18)
            .frame(height: height)
            .frame(maxWidth: .infinity, alignment: .leading)
            .pressed(in: Capsule(), .sm)
    }
}

/// Raised group of rows with a mono header.
struct SettingsGroup<Content: View>: View {
    var header: String
    /// Settings passes `.sm`: many small controls on one card read better with a softer lift.
    var shadow: Wave.Shadow = .md
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(header.uppercased()).font(Wave.Fonts.status).tracking(1.3).foregroundStyle(Wave.Palette.ink2).padding(.leading, 20)
            VStack(spacing: 0) { content }
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous).fill(Wave.Palette.ivory).raised(shadow))
        }
    }
}

struct RowDivider: View {
    var body: some View { Rectangle().fill(Wave.Palette.hairline).frame(height: 1).padding(.horizontal, 20) }
}

/// Standard row: label on the left, value on the right.
struct SettingsRow<Trailing: View>: View {
    var title: String
    /// Optional second line under the title, instead of a separate note row.
    var subtitle: String? = nil
    /// A small mark under the title, e.g. «эксперимент».
    var tag: String? = nil
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Wave.Fonts.text).foregroundStyle(Wave.Palette.bakelite)
                if let tag { TagLabel(text: tag).padding(.top, 2) }
                if let subtitle { Text(subtitle).font(Wave.Fonts.small).foregroundStyle(Wave.Palette.ink2) }
            }
            Spacer(minLength: 12)
            trailing
        }
        .padding(.horizontal, 20).padding(.vertical, 6)
        .frame(minHeight: 50)
        .contentShape(Rectangle())
    }
}

/// A small sunken mono label under a title.
struct TagLabel: View {
    var text: String
    var body: some View {
        Text(text.uppercased())
            .font(Wave.Fonts.mono(9, .medium)).tracking(0.6).foregroundStyle(Wave.Palette.ink2)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .pressed(in: Capsule(), .flat)
            .fixedSize()
    }
}

struct SettingsNote: View {
    var text: String
    var body: some View {
        Text(text).font(Wave.Fonts.caption).foregroundStyle(Wave.Palette.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 10)
    }
}

struct LampValue: View {
    var text: String
    var lamp: LampState
    /// Signal red only for a refusal the app cannot lift itself (permission denied in iOS Settings).
    var tint: Color? = nil
    var body: some View {
        HStack(spacing: 8) {
            Lamp(state: lamp, size: 10)
            Text(text.uppercased()).font(Wave.Fonts.mono(12, .medium)).tracking(0.8).foregroundStyle(tint ?? Wave.Palette.ink2)
        }
    }
}
