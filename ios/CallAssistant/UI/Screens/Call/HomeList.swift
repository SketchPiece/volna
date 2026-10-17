import SwiftUI

/// The middle of the idle screen (docs/design/canvas/home-idle, board «Д»). Conversations are drawn by `HomeTalks`
/// inside the page's own scroll (docs/design/canvas/home-scroll, boards «Б» and «В»); here the current work, as many rows
/// as fit, up to `HomeCopy.rows`, or `EmptyHome` (board «Г» of home-empty) when there is nothing to list.
struct HomeList: View {
    var mode: HomeMode
    var records: [CallRecord]
    var work: [WorkItem]

    static let rowHeight: CGFloat = 66
    static let headerHeight: CGFloat = 30

    var body: some View {
        GeometryReader { proxy in
            let space = proxy.size.height - Self.headerHeight - 12
            let fit = max(0, min(HomeCopy.rows, Int(space / Self.rowHeight)))
            content(rows: fit)
        }
    }

    @ViewBuilder private func content(rows: Int) -> some View {
        let shownWork = Array(work.prefix(rows))
        if rows > 0, mode == .work, !shownWork.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HomeListTitle(mode: mode)
                VStack(spacing: 0) {
                    ForEach(Array(shownWork.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { RowDivider() }
                        HomeRow(key: item.key, text: item.text, lamp: item.lamp, blinking: item.blinking)
                            .accessibilityElement(children: .combine)
                    }
                }
                .homeCard()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else if mode == .work, !records.isEmpty {
            EmptyHome(title: HomeCopy.noWorkTitle, text: HomeCopy.noWorkText)
        } else {
            EmptyHome(title: HomeCopy.firstCallTitle, text: HomeCopy.firstCallText)
        }
    }
}

/// Every conversation, newest first, in one card as long as the list: the page scrolls, not the card
/// (docs/design/canvas/home-scroll). Rows are built lazily inside the page's scroll view.
struct HomeTalks: View {
    var records: [CallRecord]
    var open: (CallRecord) -> Void

    var body: some View {
        TimelineView(.everyMinute) { timeline in
            VStack(alignment: .leading, spacing: 12) {
                HomeListTitle(mode: .talks)
                LazyVStack(spacing: 0) {
                    ForEach(Array(records.enumerated()), id: \.element.id) { index, record in
                        if index > 0 { RowDivider() }
                        Button { open(record) } label: {
                            HomeRow(key: HomeCopy.callKey(record, now: timeline.date), text: record.title)
                        }
                        // The row sinks as a soft pill with the settings key's spring and tick, not a small square.
                        .buttonStyle(KeyPressStyle(shape: AnyShape(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous).inset(by: 5)), scale: 0.97))
                        .accessibilityLabel("\(record.title), \(HomeCopy.callKey(record, now: timeline.date))")
                        .accessibilityIdentifier("homeCall.\(index)")
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .homeCard()
            }
            .animation(.spring(response: 0.45, dampingFraction: 0.85), value: records.map(\.id))
        }
    }
}

private struct HomeListTitle: View {
    var mode: HomeMode
    var body: some View {
        Text(HomeCopy.modeTitle(mode).uppercased())
            .font(Wave.Fonts.status).tracking(1.3).foregroundStyle(Wave.Palette.ink2)
            .padding(.leading, 4)
            .frame(height: HomeList.headerHeight - 12, alignment: .bottom)
    }
}

private extension View {
    /// The raised ivory card of the home lists. Rows are clipped (a new one slides in from under the top edge); the shadow is not.
    func homeCard() -> some View {
        clipShape(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous))
            .background(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous).fill(Wave.Palette.ivory).raised())
            .padding(.bottom, 2)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("homeList")
    }
}

/// Nothing to list yet: a raised badge with a radio mast (not the logo: the mark belongs to the air), a line
/// inviting the call and a wavy arrow that springs toward the call key.
private struct EmptyHome: View {
    var title: String
    var text: String
    @State private var blockHeight: CGFloat = 300

    /// Board «Е2» of home-empty: the badge and text sit a little above the centre, the arrow halfway between the text
    /// and the call key. The free space is split 0.6 above the block to 1 between the block and the arrow.
    private static let arrowHeight: CGFloat = 84
    /// Clear of the call key even at the bottom of the arrow's dip.
    private static let arrowBottom: CGFloat = 44

    var body: some View {
        GeometryReader { proxy in
            let free = max(0, proxy.size.height - blockHeight - Self.arrowHeight - Self.arrowBottom)
            VStack(spacing: 0) {
                Color.clear.frame(height: free * 0.6 / 1.6)
                VStack(spacing: 0) {
                    MastBadge()
                    Text(title)
                        .font(Wave.Fonts.display(24, relativeTo: .title2)).foregroundStyle(Wave.Palette.bakelite)
                        .multilineTextAlignment(.center)
                        .padding(.top, 28)
                    Text(text)
                        .font(Wave.Fonts.text).foregroundStyle(Wave.Palette.ink2)
                        .multilineTextAlignment(.center).lineSpacing(3)
                        .frame(maxWidth: 290)
                        .padding(.top, 10)
                }
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { blockHeight = $0 }
                Color.clear.frame(height: max(16, free / 1.6))
                WavyArrow()
                Color.clear.frame(height: Self.arrowBottom)
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("homeEmpty")
    }
}

private struct MastBadge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// One signal from the lamp outward: the inner wave lights, then the outer one, then a pause.
    private static let period = 2.4

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
            let phase = reduceMotion ? 0.12 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
            Canvas { context, size in
                let s = size.width / 64
                func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
                // A tower: two legs, one cross-bar and one X below it, so it does not read as the letter «А».
                var legs = Path()
                legs.move(to: p(22, 57)); legs.addLine(to: p(32, 31)); legs.addLine(to: p(42, 57))
                context.stroke(legs, with: .color(Wave.Palette.bakelite), style: StrokeStyle(lineWidth: 2.6 * s, lineCap: .round, lineJoin: .round))
                var lattice = Path()
                for (from, to) in [((27.0, 44.0), (37.0, 44.0)), ((27.0, 44.0), (42.0, 57.0)), ((37.0, 44.0), (22.0, 57.0))] {
                    lattice.move(to: p(from.0, from.1)); lattice.addLine(to: p(to.0, to.1))
                }
                context.stroke(lattice, with: .color(Wave.Palette.bakelite), style: StrokeStyle(lineWidth: 1.8 * s, lineCap: .round))
                // Each side is its own arc, mirrored around the mast, so both are the same length.
                for (index, radius) in [10.0, 17.0].enumerated() {
                    let lit = Self.bump(phase - Double(index) * 0.18)
                    context.opacity = (index == 0 ? 0.55 : 0.25) + (index == 0 ? 0.45 : 0.5) * lit
                    for side in [180.0, 0.0] {
                        var arc = Path()
                        arc.addArc(center: p(32, 26), radius: radius * s, startAngle: .degrees(side - 45), endAngle: .degrees(side + 45), clockwise: false)
                        context.stroke(arc, with: .color(Wave.Palette.lamp), style: StrokeStyle(lineWidth: 2.4 * s, lineCap: .round))
                    }
                }
                context.opacity = 1
                context.addFilter(.shadow(color: Wave.Palette.lamp, radius: 3 + 3 * Self.bump(phase + 0.1)))
                context.fill(Path(ellipseIn: CGRect(x: 27.8 * s, y: 21.8 * s, width: 8.4 * s, height: 8.4 * s)), with: .color(Wave.Palette.lamp))
            }
        }
        .frame(width: 172, height: 172)
        .frame(width: 204, height: 204)
        .background(Circle().fill(Wave.Palette.ivory).raised())
        .accessibilityHidden(true)
    }

    /// 0…1…0 over the first 40 % of a period, then rest.
    private static func bump(_ x: Double) -> Double {
        let t = x - x.rounded(.down)
        return t < 0.4 ? sin(.pi * t / 0.4) : 0
    }
}

/// A wave in the mark's red running down to an arrowhead (board «Г» of home-empty, round three). It dips toward the call key with a springy
/// overshoot every couple of seconds; still with Reduce Motion.
private struct WavyArrow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let arrow = ArrowShape()
            .stroke(Wave.Palette.signal, style: StrokeStyle(lineWidth: 5.5, lineCap: .round, lineJoin: .round))
            .frame(width: 36, height: 84)
            .shadow(color: Wave.Palette.signalDeep.opacity(0.35), radius: 3, y: 1)
            .accessibilityHidden(true)
        if reduceMotion {
            arrow
        } else {
            arrow.keyframeAnimator(initialValue: 0.0, repeating: true) { view, dip in
                view.offset(y: dip).scaleEffect(y: 1 + dip / 90, anchor: .top)
            } keyframes: { _ in
                CubicKeyframe(0, duration: 1.1)
                SpringKeyframe(14, duration: 0.35, spring: .init(response: 0.3, dampingRatio: 0.55))
                SpringKeyframe(0, duration: 0.9, spring: .init(response: 0.45, dampingRatio: 0.35))
            }
        }
    }
}

private struct ArrowShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let midX = rect.midX, tipY = rect.maxY - 3
        let length = tipY - 8 - rect.minY
        path.move(to: CGPoint(x: midX, y: rect.minY))
        for step in 1...40 {
            let t = CGFloat(step) / 40
            // Two and a half waves that calm down toward the tip.
            let x = midX + 7 * (1 - t) * sin(t * .pi * 5)
            path.addLine(to: CGPoint(x: x, y: rect.minY + t * length))
        }
        path.addLine(to: CGPoint(x: midX, y: tipY))
        path.move(to: CGPoint(x: midX - 12, y: tipY - 13))
        path.addLine(to: CGPoint(x: midX, y: tipY))
        path.addLine(to: CGPoint(x: midX + 12, y: tipY - 13))
        return path
    }
}

/// A two-line row: mono key above, the text below; a lamp on the left in the work list.
private struct HomeRow: View {
    var key: String
    var text: String
    var lamp: LampState? = nil
    var blinking = false

    var body: some View {
        HStack(spacing: 14) {
            if let lamp { Lamp(state: lamp, blinking: blinking, size: 10) }
            VStack(alignment: .leading, spacing: 3) {
                Text(key.uppercased()).font(Wave.Fonts.status).tracking(0.9).foregroundStyle(Wave.Palette.ink2).lineLimit(1)
                Text(text).font(Wave.Fonts.body(15, .medium)).foregroundStyle(Wave.Palette.bakelite).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .frame(height: HomeList.rowHeight)
        .contentShape(Rectangle())
    }
}
