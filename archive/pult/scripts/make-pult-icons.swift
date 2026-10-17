// Generates archive/pult/Resources/AppIcon.icns from the iOS icon and the menu bar template icon of the wave mark.
// Run: swift archive/pult/scripts/make-pult-icons.swift
import AppKit

let root = URL(fileURLWithPath: CommandLine.arguments.first!).deletingLastPathComponent().deletingLastPathComponent()
let source = root.appendingPathComponent("../../ios/CallAssistant/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
let output = root.appendingPathComponent("Resources")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func png(_ image: NSImage, size: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

// 1. App icon: macOS keeps a transparent margin; the artwork is a rounded square of 824/1024 of the canvas.
let ios = NSImage(contentsOf: source)!
let canvas = NSImage(size: NSSize(width: 1024, height: 1024), flipped: false) { _ in
    let box = NSRect(x: 100, y: 100, width: 824, height: 824)
    let path = NSBezierPath(roundedRect: box, xRadius: 824 * 0.2237, yRadius: 824 * 0.2237)
    path.addClip()
    ios.draw(in: box, from: .zero, operation: .sourceOver, fraction: 1)
    return true
}
let iconset = output.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for (name, size) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128),
                     ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    try png(canvas, size: size).write(to: iconset.appendingPathComponent(name + ".png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("AppIcon.icns").path]
try iconutil.run(); iconutil.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)

// 2. Menu bar icon: the wave from the design system inside a thin ring, black on transparent (template image).
func menuIcon(points: CGFloat, scale: CGFloat) -> NSImage {
    let pixels = Int(points * scale)
    let image = NSImage(size: NSSize(width: pixels, height: pixels), flipped: false) { rect in
        NSColor.black.setStroke()
        let k = rect.width / 120
        let ring = NSBezierPath(ovalIn: NSRect(x: 8 * k, y: 8 * k, width: 104 * k, height: 104 * k))
        ring.lineWidth = 8 * k
        ring.stroke()
        let wave = NSBezierPath()
        wave.lineWidth = 11 * k
        wave.lineCapStyle = .round
        wave.lineJoinStyle = .round
        // Design-system path M16 60 Q23 54 30 60 Q38 70 46 60 Q55 34 64 60 Q73 86 82 60 Q90 50 98 60 Q101 63 104 60, flipped to AppKit coordinates.
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * k, y: (120 - y) * k) }
        func q(_ cx: CGFloat, _ cy: CGFloat, _ x: CGFloat, _ y: CGFloat) {
            let start = wave.currentPoint, control = p(cx, cy), end = p(x, y)
            let c1 = NSPoint(x: start.x + 2 / 3 * (control.x - start.x), y: start.y + 2 / 3 * (control.y - start.y))
            let c2 = NSPoint(x: end.x + 2 / 3 * (control.x - end.x), y: end.y + 2 / 3 * (control.y - end.y))
            wave.curve(to: end, controlPoint1: c1, controlPoint2: c2)
        }
        wave.move(to: p(22, 60)); q(28, 54, 34, 60); q(41, 70, 48, 60); q(55, 34, 62, 60); q(69, 86, 76, 60); q(83, 50, 90, 60); q(94, 63, 98, 60)
        wave.stroke()
        return true
    }
    return image
}
for (suffix, scale) in [("", CGFloat(1)), ("@2x", 2)] {
    try png(menuIcon(points: 18, scale: scale), size: Int(18 * scale)).write(to: output.appendingPathComponent("MenuBarIcon\(suffix).png"))
}
// 3. Agent marks: Simple Icons SVGs (claude-logo.svg, openai-logo.svg in archive/pult/Resources) rasterized for the panel.
for name in ["claude-logo", "openai-logo"] {
    guard let svg = NSImage(contentsOf: output.appendingPathComponent(name + ".svg")) else { continue }
    for (suffix, scale) in [("", CGFloat(1)), ("@2x", 2)] {
        try png(svg, size: Int(18 * scale)).write(to: output.appendingPathComponent("\(name)\(suffix).png"))
    }
}
print("icons written to \(output.path)")
