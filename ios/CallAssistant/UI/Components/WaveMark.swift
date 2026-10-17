import SwiftUI

/// The Volna mark as the centre of the call screen: flat ivory disc, red procedural wave,
/// dotted ring of lamps. At rest the wave matches the logo. In a call the mark answers the voices
/// (docs/design/canvas/call-wave, board «Г»): the owner's voice fills the lamps from the bottom,
/// while Volna thinks calm ripples leave the disc, while she speaks the running wave leaves echoes.
struct WaveMark: View {
    enum Size {
        case xl, lg, md, sm
        var diameter: CGFloat { switch self { case .xl: 272; case .lg: 236; case .md: 150; case .sm: 96 } }
    }
    enum State: Equatable { case idle, connecting, listening, thinking, speaking, muted, failed, ended }

    var size: Size
    var state: State
    /// Measured voice level 0…1: the owner's while listening, Volna's while speaking.
    /// Nil falls back to a synthetic envelope.
    var level: Double? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.State private var seed = Double.random(in: 0..<10)
    /// Last thinking phase: the running arc starts with it and fades out after it ends.
    @SwiftUI.State private var thinkingSpan: (since: Date, until: Date?)?
    @SwiftUI.State private var motion = WaveMotion()
    /// When «connecting» began: the ring lights lamp by lamp over `RingLamps.warmup` (board «В» of home-idle).
    @SwiftUI.State private var connectingSince: Date?
    /// The mark is always drawn at this diameter and scaled as a whole, so the disc and ring
    /// resize together when the call screen switches sizes (the ring used to snap ahead of the disc).
    private static let baseDiameter = Size.xl.diameter

    private var animates: Bool {
        !reduceMotion && [.connecting, .listening, .thinking, .speaking, .failed].contains(state)
    }

    var body: some View {
        let d = size.diameter
        let base = Self.baseDiameter
        let inner = base * 0.82
        let unit = inner / 120
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !animates)) { timeline in
            let now = timeline.date
            let t = animates ? now.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000) + seed : 0
            let dt = motion.advance(to: now, running: animates)
            let smoothed = level.map { motion.level(toward: $0, dt: dt) }
            let voice = animates ? voiceLevel(t, measured: smoothed) : 0
            let amp = animates ? motion.amplitude(toward: amplitude(t, level: smoothed), dt: dt) : amplitude(t, level: nil)
            let phase = motion.phase(travel: travel, dt: dt)
            let _ = motion.record(at: now, amplitude: amp, phase: phase, voice: state == .speaking ? voice : 0)
            let halo = state == .speaking ? 0.35 + 0.65 * voice : 0
            ZStack {
                Circle().fill(Wave.Palette.ivory)
                Canvas { context, canvasSize in
                    drawRing(in: &context, center: CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2), unit: unit, time: t, voice: voice,
                             warmth: warmth(at: now), date: now)
                }
                ForEach(WaveMotion.echoes.indices, id: \.self) { index in
                    let echo = WaveMotion.echoes[index]
                    if let sample = motion.sample(lag: echo.lag, at: now), sample.voice >= 0.02 {
                        WaveShape(time: t, amplitude: sample.amplitude, phase: sample.phase, jitter: 0)
                            .stroke(Wave.Palette.signal, style: StrokeStyle(lineWidth: echo.width * unit, lineCap: .round, lineJoin: .round))
                            .frame(width: inner, height: inner)
                            .opacity(echo.opacity * min(1, sample.voice * 3))
                    }
                }
                WaveShape(time: t, amplitude: amp, phase: phase, jitter: state == .failed ? 1.5 : 0)
                    .stroke(Wave.Palette.signal, style: StrokeStyle(lineWidth: inner * 5.5 / 120, lineCap: .round, lineJoin: .round))
                    .frame(width: inner, height: inner)
                    .shadow(color: Wave.Palette.signalDeep.opacity(0.28), radius: 1.2, x: 0.8, y: 1.2)
                    .opacity(state == .muted ? 0.45 : state == .failed ? 0.7 : 1)
            }
            .frame(width: base, height: base)
            .scaleEffect(d / base)
            .frame(width: d, height: d)
            .background { DiscSurface(halo: halo) }
        }
        .frame(width: d, height: d)
        .animation(.easeInOut(duration: 0.3), value: state)
        .onAppear { if state == .connecting { connectingSince = Date() } }
        .onChange(of: state) { old, new in
            if new == .connecting { connectingSince = Date() }
            if new == .thinking {
                thinkingSpan = animates ? (Date(), nil) : nil
            } else if old == .thinking, thinkingSpan != nil {
                thinkingSpan?.until = Date()
            }
        }
        .accessibilityHidden(true)
    }

    /// Share of the ring already lit while connecting; the whole ring otherwise and with Reduce Motion.
    private func warmth(at date: Date) -> Double {
        guard state == .connecting, animates, let since = connectingSince else { return 1 }
        return min(1, date.timeIntervalSince(since) / RingLamps.warmup)
    }


    private var travel: Double {
        switch state {
        case .connecting: return 1.2
        case .speaking: return 3.2
        default: return 0
        }
    }
    private func amplitude(_ t: Double, level: Double?) -> Double {
        switch state {
        case .idle, .ended: return 1
        case .connecting: return 0.35
        case .listening:
            if let level { return 0.4 + 0.5 * level }
            return 0.6 + 0.15 * sin(t * 1.6)
        case .thinking: return 0.4
        case .speaking:
            return 0.55 + 0.6 * (level ?? Self.syntheticSpeech(t))
        case .muted: return 0.08
        case .failed: return 0.15
        }
    }
    /// Level that drives the lamps: measured when there is one; a synthetic voice for Volna otherwise
    /// (previews, the voice picker), none for the owner.
    private func voiceLevel(_ t: Double, measured: Double?) -> Double {
        switch state {
        case .listening: return measured ?? 0
        case .speaking: return measured ?? Self.syntheticSpeech(t)
        default: return 0
        }
    }
    private static func syntheticSpeech(_ t: Double) -> Double {
        min(1, abs(sin(t * 5.1) * sin(t * 2.3) + 0.35 * sin(t * 7.7)))
    }

    private func color(_ tone: RingLamp.Tone) -> Color {
        switch tone {
        case .off: return Wave.Palette.lampOff
        case .lamp: return Wave.Palette.lamp
        case .hot: return Wave.Palette.lampHot
        }
    }
    private var glows: Bool { [.connecting, .listening, .thinking, .speaking].contains(state) }

    /// Radius 57 of the 120 box: the ring sits near the disc edge, well clear of the wave tails (x 16…104).
    private func drawRing(in context: inout GraphicsContext, center: CGPoint, unit: CGFloat, time t: Double, voice: Double, warmth: Double, date: Date) {
        // While Volna thinks a short arc of the ring runs around (docs/design/canvas/call-orb, board «Б′»).
        let arc = thinkingSpan.map { ThinkingArc.glow(since: $0.since, until: $0.until, now: date) } ?? 0
        let head = thinkingSpan.map { ThinkingArc.head(since: $0.since, now: date) } ?? 0
        let radius = 57 * unit
        let count = RingLamps.count(for: state)
        let spin = state == .connecting ? t * .pi / 3 : 0
        let lamps = (0..<count).map { index -> (Path, RingLamp) in
            let angle = Double(index) / Double(count) * 2 * .pi + spin
            let base = Double(index) < warmth * Double(count)
                ? RingLamps.lamp(at: angle, state: state, level: voice)
                : RingLamps.lamp(at: angle, state: .idle, level: 0)
            let lamp = animates && arc > 0 ? ThinkingArc.lamp(over: base, at: angle, head: head, glow: arc) : base
            let half = Double(lamp.length * unit / radius) / 2
            var path = Path()
            path.addArc(center: center, radius: radius, startAngle: .radians(angle - .pi / 2 - half), endAngle: .radians(angle - .pi / 2 + half), clockwise: false)
            return (path, lamp)
        }
        context.drawLayer { layer in
            if glows { layer.addFilter(.shadow(color: Wave.Palette.lamp.opacity(0.6), radius: 2)) }
            for (path, lamp) in lamps {
                layer.opacity = lamp.opacity
                layer.stroke(path, with: .color(color(lamp.tone)), lineWidth: lamp.width * unit)
            }
        }
        // Lit lamps get a wider glow on top.
        guard lamps.contains(where: { $0.1.lit > 0.05 }) else { return }
        context.drawLayer { layer in
            layer.addFilter(.shadow(color: Wave.Palette.lamp, radius: 6))
            for (path, lamp) in lamps where lamp.lit > 0.05 {
                layer.opacity = lamp.lit
                layer.stroke(path, with: .color(color(lamp.tone)), lineWidth: lamp.width * unit)
            }
        }
    }

}

/// The disc's neumorphic body: shallow but layered. A tight contact shadow and a soft ambient one on
/// the bottom-right, the same pair of highlights on the top-left, a thin bevel along the rim, and the
/// lamp halo while Volna speaks. Drawn behind the mark so the wave and ring cast no blurry shadow.
private struct DiscSurface: View {
    var halo: Double

    var body: some View {
        Circle()
            .fill(Wave.Palette.ivory)
            .overlay {
                Circle().strokeBorder(
                    LinearGradient(colors: [Wave.Palette.light, Wave.Palette.ivory.opacity(0), Wave.Palette.shade.opacity(0.55)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    lineWidth: 1.2)
            }
            .shadow(color: Wave.Palette.shade.opacity(0.9), radius: 1.5, x: 1.2, y: 1.2)
            .shadow(color: Wave.Palette.shade.opacity(0.5), radius: 9, x: 5, y: 5)
            .shadow(color: Wave.Palette.light, radius: 1.5, x: -1.2, y: -1.2)
            .shadow(color: Wave.Palette.light.opacity(0.85), radius: 9, x: -5, y: -5)
            .shadow(color: Wave.Palette.lamp.opacity(0.38 * halo), radius: 15 + 12 * halo)
    }
}

/// Look of one lamp of the dotted ring; sizes in units of the 120 box.
struct RingLamp: Equatable {
    enum Tone: Equatable { case off, lamp, hot }
    var tone: Tone
    var opacity: Double
    var length: Double
    var width: Double = 1.6
    /// 0…1, how strongly the lamp is lit by a voice: adds a wider glow.
    var lit: Double = 0
}

enum RingLamps {
    static func count(for state: WaveMark.State) -> Int { state == .failed ? 36 : 51 }
    /// Seconds for the ring to light up, lamp by lamp, when a call starts connecting.
    static let warmup: Double = 1.3

    /// `angle` in radians clockwise from the top. The owner's voice fills the ring from the bottom,
    /// where the microphone is; Volna's voice brightens every lamp at once.
    static func lamp(at angle: Double, state: WaveMark.State, level: Double) -> RingLamp {
        switch state {
        case .listening:
            let fromBottom = distance(angle, .pi) / .pi
            let lit = smoothstep(0, 0.1, level * 0.95 - fromBottom)
            return RingLamp(tone: .lamp, opacity: 0.38 + 0.62 * lit, length: 2 + 1.8 * lit, width: 1.6 + 0.8 * lit, lit: lit)
        case .speaking:
            let lit = level * 0.7
            return RingLamp(tone: lit > 0.2 ? .hot : .lamp, opacity: 0.55 + 0.45 * min(1, lit + 0.4), length: 2 + 1.6 * lit, lit: lit)
        case .thinking: return RingLamp(tone: .lamp, opacity: 0.73, length: 2)
        case .connecting: return RingLamp(tone: .lamp, opacity: 1, length: 2)
        case .failed: return RingLamp(tone: .off, opacity: 1, length: 1)
        case .idle, .muted, .ended: return RingLamp(tone: .off, opacity: 1, length: 2)
        }
    }

    /// Angular distance 0…π between two angles.
    static func distance(_ a: Double, _ b: Double) -> Double {
        let d = (a - b).truncatingRemainder(dividingBy: 2 * .pi)
        let wrapped = d < 0 ? d + 2 * .pi : d
        return min(wrapped, 2 * .pi - wrapped)
    }

    private static func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
        let t = min(1, max(0, (x - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    }
}

/// While Volna thinks a short lit arc of the ring runs around once per `period`; it fades in when thinking starts
/// and out after it ends, still running. Replaced the lone orb and the ripples on 26.09.2026.
enum ThinkingArc {
    static let period: Double = 4
    static let fadeIn: Double = 0.35
    static let fadeOut: Double = 0.6
    /// Half-width of the arc in radians (a Gaussian): about seven lamps are noticeably lit.
    static let spread: Double = 0.3

    /// Angle of the arc's centre, radians clockwise from the top.
    static func head(since: Date, now: Date) -> Double {
        max(0, now.timeIntervalSince(since)) / period * 2 * .pi
    }

    /// 0…1: how strongly the arc shows.
    static func glow(since: Date, until: Date?, now: Date) -> Double {
        let rise = min(1, max(0, now.timeIntervalSince(since)) / fadeIn)
        guard let until else { return rise }
        return rise * max(0, 1 - now.timeIntervalSince(until) / fadeOut)
    }

    /// The lamp at `angle` with the arc laid over it: hot, longer and wider near the head.
    static func lamp(over base: RingLamp, at angle: Double, head: Double, glow: Double) -> RingLamp {
        let lit = glow * exp(-pow(RingLamps.distance(angle, head) / spread, 2))
        guard lit > 0.04 else { return base }
        return RingLamp(tone: .hot, opacity: min(1, 0.55 + 0.6 * lit), length: 2 + 3 * lit, width: 1.6 + 1.4 * lit, lit: max(base.lit, lit))
    }
}

/// Frame-to-frame motion of the wave. The 10 Hz voice level and the per-state amplitude are eased
/// instead of stepping, and the travel phase is accumulated, so switching between listening and
/// speaking changes the speed of the wave without jumping it to another position.
/// A reference type: the timeline advances it every frame without invalidating the view.
final class WaveMotion {
    private var level = 0.0
    private var amplitude: Double?
    private var phase = 0.0
    private var last: Date?
    private var history: [Sample] = []

    struct Sample { var date: Date; var amplitude: Double; var phase: Double; var voice: Double }
    /// Echoes behind Volna's wave: how far back, stroke width in units of the 120 box, opacity.
    static let echoes: [(lag: Double, width: Double, opacity: Double)] = [(0.23, 3.6, 0.30), (0.47, 2.4, 0.14)]

    /// Seconds since the previous frame, capped so a paused timeline resumes without a jump.
    /// A still mark resets to the logo shape.
    func advance(to date: Date, running: Bool) -> Double {
        guard running else {
            level = 0; amplitude = nil; phase = 0; last = nil; history.removeAll()
            return 0
        }
        let dt = last.map { min(max(date.timeIntervalSince($0), 0), 0.1) } ?? 0
        last = date
        return dt
    }

    /// Faster rise than fall, like the smoothing in RealtimeClient, but continuous.
    func level(toward target: Double, dt: Double) -> Double {
        level += (target - level) * (1 - exp(-(target > level ? 18 : 6) * dt))
        return level
    }

    func amplitude(toward target: Double, dt: Double) -> Double {
        guard let current = amplitude else { amplitude = target; return target }
        let next = current + (target - current) * (1 - exp(-10 * dt))
        amplitude = next
        return next
    }

    /// Keeps the last half second of the wave for the echoes.
    func record(at date: Date, amplitude: Double, phase: Double, voice: Double) {
        if let newest = history.last, newest.date >= date { return }
        history.append(Sample(date: date, amplitude: amplitude, phase: phase, voice: voice))
        let horizon = date.addingTimeInterval(-0.6)
        if let keep = history.firstIndex(where: { $0.date >= horizon }), keep > 0 { history.removeFirst(keep) }
    }

    /// The newest recorded frame at least `lag` seconds old.
    func sample(lag: Double, at date: Date) -> Sample? {
        let cutoff = date.addingTimeInterval(-lag)
        return history.last(where: { $0.date <= cutoff })
    }

    /// A running wave advances; a still one (listening, thinking) glides back the short way to phase 0,
    /// the logo shape, instead of freezing wherever Volna stopped speaking.
    func phase(travel: Double, dt: Double) -> Double {
        if travel == 0 {
            var offset = phase.truncatingRemainder(dividingBy: 2 * .pi)
            if offset > .pi { offset -= 2 * .pi } else if offset < -.pi { offset += 2 * .pi }
            phase = offset * exp(-2.5 * dt)
        } else {
            phase = (phase + travel * dt).truncatingRemainder(dividingBy: 2 * .pi)
        }
        return phase
    }
}

extension WaveMark.State {
    init(phase: CallPhase, isMuted: Bool) {
        switch phase {
        case .idle: self = .idle
        case .connecting: self = .connecting
        case .listening: self = isMuted ? .muted : .listening
        case .thinking: self = .thinking
        case .speaking: self = .speaking
        case .ended: self = .ended
        case .failed: self = .failed
        }
    }
}

/// Procedural wave in a 120 × 120 box: y = 60 − 26·amp·exp(−2.8u²)·sin(k(x − 62) + phase).
/// Sampled every 0.5 units and joined with quadratic curves so the stroke has no visible corners.
struct WaveShape: Shape {
    var time: Double
    var amplitude: Double
    var phase: Double
    var jitter: Double

    func path(in rect: CGRect) -> Path {
        let s = rect.width / 120
        let k = 2 * Double.pi / 36
        var points: [CGPoint] = []
        for x in stride(from: 16.0, through: 104.0, by: 0.5) {
            let u = (x - 60) / 44
            let envelope = exp(-2.8 * u * u)
            var y = 60 - 26 * amplitude * envelope * sin(k * (x - 62) + phase)
            if jitter > 0 { y += (noise(x, floor(time * 8)) - 0.5) * jitter * 2 }
            points.append(CGPoint(x: rect.minX + x * s, y: rect.minY + y * s))
        }
        var path = Path()
        guard let firstPoint = points.first else { return path }
        path.move(to: firstPoint)
        // Midpoint quadratic smoothing: each sample becomes a control point between neighbouring midpoints.
        for index in 1..<points.count - 1 {
            let mid = CGPoint(x: (points[index].x + points[index + 1].x) / 2, y: (points[index].y + points[index + 1].y) / 2)
            path.addQuadCurve(to: mid, control: points[index])
        }
        if let last = points.last { path.addLine(to: last) }
        return path
    }
    private func noise(_ x: Double, _ frame: Double) -> Double {
        let v = sin(x * 12.9898 + frame * 78.233) * 43758.5453
        return v - floor(v)
    }
}

/// Static brand mark from the draft: red disc, ivory wave. Used in the top bar.
struct BrandMark: View {
    var size: CGFloat = 26
    var body: some View {
        ZStack {
            Circle().fill(Wave.Palette.signal)
            LogoWave().stroke(Wave.Palette.ivory, style: StrokeStyle(lineWidth: size * 8 / 120, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct LogoWave: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 120
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        path.move(to: p(16, 60))
        path.addQuadCurve(to: p(30, 60), control: p(23, 54))
        path.addQuadCurve(to: p(46, 60), control: p(38, 70))
        path.addQuadCurve(to: p(64, 60), control: p(55, 34))
        path.addQuadCurve(to: p(82, 60), control: p(73, 86))
        path.addQuadCurve(to: p(98, 60), control: p(90, 50))
        path.addQuadCurve(to: p(104, 60), control: p(101, 63))
        return path
    }
}
