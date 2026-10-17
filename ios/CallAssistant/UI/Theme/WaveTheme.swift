import SwiftUI

/// Design tokens from docs/design/volna-design-system.html («Бакелит и лампа»).
enum Wave {
    /// Light: «Бакелит и лампа». Dark: «чёрный бакелит» per the design spec; ether, lamps and signal stay the same.
    enum Palette {
        static let ivory = Color(light: 0xE7E0D2, dark: 0x2A2522)
        static let bakelite = Color(light: 0x26211D, dark: 0xEFE7D6)
        static let ink2 = Color(light: 0x5E554B, dark: 0xB7AA93)
        static let signal = Color(hex: 0xB8321F)
        static let signalDeep = Color(hex: 0x8E2415)
        static let lamp = Color(hex: 0xE8A33D)
        static let lampHot = Color(hex: 0xF2B550)
        static let lampDim = Color(hex: 0x9C7A45)
        static let lampOff = Color(light: 0xCFC6B6, dark: 0x4A423B)
        static let ether = Color(hex: 0x1F1B18)
        static let etherText = Color(hex: 0xEFE7D6)
        static let etherMuted = Color(hex: 0xCDBFA6)
        static let etherLine = Color(hex: 0xE8A33D).opacity(0.22)
        static let shade = Color(light: 0xBFB6A6, dark: 0x1C1815)
        static let light = Color(light: 0xFBF6EC, dark: 0x38312C)
        static let placeholder = Color(light: 0x6E655A, dark: 0x8B8073)
        static let hairline = Color(light: 0x26211D, dark: 0xEFE7D6).opacity(0.08)
    }

    enum Fonts {
        enum Weight { case regular, medium, semibold, extrabold }
        static func display(_ size: CGFloat, _ weight: Weight = .semibold, relativeTo style: Font.TextStyle = .body) -> Font {
            .custom(weight == .extrabold ? "Unbounded-ExtraBold" : "Unbounded-SemiBold", size: size, relativeTo: style)
        }
        static func body(_ size: CGFloat, _ weight: Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
            let name: String
            switch weight {
            case .regular: name = "IBMPlexSans-Regular"
            case .medium: name = "IBMPlexSans-Medium"
            default: name = "IBMPlexSans-SemiBold"
            }
            return .custom(name, size: size, relativeTo: style)
        }
        static func mono(_ size: CGFloat, _ weight: Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
            .custom(weight == .regular ? "IBMPlexMono-Regular" : "IBMPlexMono-Medium", size: size, relativeTo: style)
        }
        // Roles
        static let title = display(28, relativeTo: .title)
        static let titleSm = display(22, relativeTo: .title2)
        static let brand = display(15, relativeTo: .headline)
        static let cta = display(15, relativeTo: .headline)
        static let timer = mono(22, .medium, relativeTo: .title2)
        static let text = body(15)
        static let label = body(15, .semibold)
        static let rowLabel = body(15, .semibold)
        static let caption = body(13, relativeTo: .footnote)
        static let small = body(12, .medium, relativeTo: .caption)
        static let status = mono(11, .medium, relativeTo: .caption2)
        static let foot = mono(9.5, relativeTo: .caption2)
    }

    enum Radius {
        static let sm: CGFloat = 14
        static let md: CGFloat = 24
        static let lg: CGFloat = 32
    }

    /// Neomorphic shadow sizes: offset and blur radius.
    enum Shadow {
        case flat, sm, md, lg
        var offset: CGFloat { switch self { case .flat: 3; case .sm: 5; case .md: 7; case .lg: 12 } }
        var blur: CGFloat { switch self { case .flat: 4; case .sm: 6; case .md: 8; case .lg: 14 } }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
    /// Resolves per appearance so the whole palette switches with the system setting.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }
}

extension View {
    /// Two shadows on the same background; light source is top-left.
    func raised(_ size: Wave.Shadow = .md) -> some View {
        shadow(color: Wave.Palette.shade, radius: size.blur, x: size.offset, y: size.offset)
            .shadow(color: Wave.Palette.light, radius: size.blur, x: -size.offset, y: -size.offset)
    }
    /// Inset shadows: dark along top-left inner edges, light along bottom-right.
    func pressed<S: Shape>(in shape: S, _ size: Wave.Shadow = .md) -> some View {
        background(Wave.Palette.ivory, in: shape)
            .overlay { InnerShadow(shape: shape, size: size) }
    }
}

struct InnerShadow<S: Shape>: View {
    var shape: S
    var size: Wave.Shadow
    var body: some View {
        let width = size.offset * 1.8
        let shift = size.offset * 0.7
        ZStack {
            shape.stroke(Wave.Palette.shade, lineWidth: width).blur(radius: size.blur * 0.7).offset(x: shift, y: shift)
            shape.stroke(Wave.Palette.light, lineWidth: width).blur(radius: size.blur * 0.7).offset(x: -shift, y: -shift)
        }
        .clipShape(shape)
        .allowsHitTesting(false)
    }
}
