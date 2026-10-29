import ERISKit
import SwiftUI
import UIKit

/// The cross-section diagram under Measurements, from the Expo app's
/// MeasurementDiagramRenderer: template, failure side and terrain selectors,
/// the drawing, and a full-screen view that turns the phone to landscape.
/// The geometry is MeasurementDiagramScene in ERISKit; this only paints it.
struct MeasurementDiagramSection: View {
    let form: GisaForm
    let snapshot: [String: JSONValue]?
    let profile: ElevationProfile?
    @State private var template: DiagramTemplate?
    @State private var side = FailureSide.lt
    @State private var terrain: TerrainShape?
    @State private var fullScreen = false

    private var data: MeasurementDiagramData {
        MeasurementDiagramData(form: form, snapshot: snapshot, template: template, failureSide: side,
                               terrainShape: terrain, profile: profile)
    }

    private var note: String {
        MeasurementDiagramData.note(source: data.crossSection.source, template: template, terrain: terrain, profile: profile)
    }

    var body: some View {
        Section {
            DiagramControls(template: $template, side: $side, terrain: $terrain)
            DiagramCanvas(data: data)
                .listRowInsets(EdgeInsets())
            Button("Full Screen", systemImage: "arrow.up.left.and.arrow.down.right") { fullScreen = true }
                .accessibilityIdentifier("diagram-full-screen")
                // On the row, not the Section: a List section does not present covers.
                .fullScreenCover(isPresented: $fullScreen) {
                    DiagramFullScreen(data: data, note: note, template: $template, side: $side, terrain: $terrain)
                }
        } header: {
            Text("Cross-section · upstation →")
        } footer: {
            Text(note)
        }
    }
}

/// Template, failure side (only for a slide above or below the road) and terrain.
struct DiagramControls: View {
    @Binding var template: DiagramTemplate?
    @Binding var side: FailureSide
    @Binding var terrain: TerrainShape?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            DiagramTemplatePicker(template: $template)
            if (template ?? .throughRoad) != .throughRoad {
                Text("Failure side").font(.caption).foregroundStyle(.secondary)
                DiagramSidePicker(side: $side)
            }
            Text("Terrain").font(.caption).foregroundStyle(.secondary)
            DiagramTerrainPicker(terrain: $terrain)
        }
        .padding(.vertical, 4)
    }
}

struct DiagramTemplatePicker: View {
    @Binding var template: DiagramTemplate?

    var body: some View {
        Picker("Template", selection: $template) {
            Text("Auto").tag(DiagramTemplate?.none)
            ForEach(DiagramTemplate.allCases) { Text($0.buttonLabel).tag(Optional($0)) }
        }
        .pickerStyle(.segmented)
    }
}

struct DiagramSidePicker: View {
    @Binding var side: FailureSide

    var body: some View {
        Picker("Failure side", selection: $side) {
            ForEach(FailureSide.allCases) { Text($0.buttonLabel).tag($0) }
        }
        .pickerStyle(.segmented)
    }
}

struct DiagramTerrainPicker: View {
    @Binding var terrain: TerrainShape?

    var body: some View {
        Picker("Terrain", selection: $terrain) {
            Text("Auto").tag(TerrainShape?.none)
            ForEach(TerrainShape.allCases) { Text($0.buttonLabel).tag(Optional($0)) }
        }
        .pickerStyle(.segmented)
    }
}

/// The drawing, as wide as it is given and 270 points tall.
struct DiagramCanvas: View {
    let data: MeasurementDiagramData

    var body: some View {
        let header = MeasurementDiagramScene.header(data.crossSection)
        Canvas { context, size in
            DiagramPainter.paint(MeasurementDiagramScene(data, width: size.width), in: &context)
        }
        .frame(height: MeasurementDiagramScene.height)
        .accessibilityElement()
        .accessibilityLabel("Cross-section diagram, \(data.template.label), \(header)")
        .accessibilityIdentifier("measurement-diagram")
    }
}

/// The diagram across a landscape screen.
struct DiagramFullScreen: View {
    @Environment(\.dismiss) private var dismiss
    let data: MeasurementDiagramData
    let note: String
    @Binding var template: DiagramTemplate?
    @Binding var side: FailureSide
    @Binding var terrain: TerrainShape?

    var body: some View {
        // Compact, as in the Expo app, so the drawing fits a landscape phone.
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                DiagramTemplatePicker(template: $template)
                if (template ?? .throughRoad) != .throughRoad { DiagramSidePicker(side: $side) }
                Button("Done") { dismiss() }.bold()
            }
            DiagramTerrainPicker(terrain: $terrain)
            Spacer(minLength: 0)
            DiagramCanvas(data: data)
            Spacer(minLength: 0)
            Text(note).font(.caption2).italic().foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7)
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .task {
            // While the cover is still sliding in, UIKit allows portrait only and
            // refuses the turn, so ask again until the screen is landscape.
            for _ in 0..<10 {
                try? await Task.sleep(for: .milliseconds(250))
                guard let scene = Self.scene, !scene.effectiveGeometry.interfaceOrientation.isLandscape else { return }
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscape)) { _ in }
            }
        }
        .onDisappear { Self.scene?.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) { _ in } }
    }

    private static var scene: UIWindowScene? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    }
}

/// Paints a MeasurementDiagramScene, SVG-style: fills, strokes, gradients
/// across each shape's bounds, and patterns tiled from the diagram's origin.
enum DiagramPainter {
    static func paint(_ scene: MeasurementDiagramScene, in context: inout GraphicsContext) {
        for item in scene.items { draw(item, palette: scene.palette, in: context) }
    }

    private static func color(_ hex: String) -> Color { Color(hex: hex) ?? .clear }

    private static func point(_ p: MeasurementDiagramScene.Point) -> CGPoint { CGPoint(x: p.x, y: p.y) }

    private static func draw(_ item: MeasurementDiagramScene.Item, palette: TerrainPalette, in context: GraphicsContext) {
        var context = context
        switch item {
        case let .polygon(points, paint, opacity):
            var path = Path()
            path.addLines(points.map(point))
            path.closeSubpath()
            context.opacity = opacity
            fill(path, paint, palette: palette, in: context)
        case let .rect(x, y, width, height, paint, opacity, radius):
            context.opacity = opacity
            fill(Path(roundedRect: CGRect(x: x, y: y, width: width, height: height), cornerRadius: radius), paint,
                 palette: palette, in: context)
        case let .line(from, to, hex, width, dash, opacity):
            context.opacity = opacity
            var path = Path()
            path.move(to: point(from))
            path.addLine(to: point(to))
            context.stroke(path, with: .color(color(hex)), style: StrokeStyle(lineWidth: width, dash: dash.map { CGFloat($0) }))
        case let .circle(centre, radius, fill, stroke, strokeWidth, opacity):
            context.opacity = opacity
            let path = Path(ellipseIn: CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2))
            context.fill(path, with: .color(color(fill)))
            if let stroke { context.stroke(path, with: .color(color(stroke)), lineWidth: strokeWidth) }
        case let .text(words, at, size, hex, anchor, bold):
            let text = Text(words).font(.system(size: size, weight: bold ? .semibold : .regular)).foregroundColor(color(hex))
            let x: CGFloat = anchor == .start ? 0 : anchor == .middle ? 0.5 : 1
            // SVG places text at its baseline, about four-fifths down the line.
            context.draw(text, at: point(at), anchor: UnitPoint(x: x, y: 0.8))
        }
    }

    private static func fill(_ path: Path, _ paint: MeasurementDiagramScene.Paint, palette: TerrainPalette,
                             in context: GraphicsContext) {
        switch paint {
        case .color(let hex):
            context.fill(path, with: .color(color(hex)))
        case .gradient(let stops):
            let box = path.boundingRect
            let gradient = Gradient(stops: stops.map { Gradient.Stop(color: color($0.color).opacity($0.opacity), location: $0.offset) })
            context.fill(path, with: .linearGradient(gradient, startPoint: CGPoint(x: box.midX, y: box.minY),
                                                     endPoint: CGPoint(x: box.midX, y: box.maxY)))
        case .pattern(let pattern):
            var clipped = context
            clipped.clip(to: path)
            tile(pattern, over: path.boundingRect, palette: palette, in: clipped)
        }
    }

    /// The SVG <pattern> tiles. Content at a tile's edge is cut by the tile,
    /// so a line on x = 0 shows only its inner half, as it does in the SVG.
    private static func tile(_ pattern: MeasurementDiagramScene.Pattern, over box: CGRect, palette: TerrainPalette,
                             in context: GraphicsContext) {
        let (size, degrees): (CGFloat, Double) = switch pattern {
        case .hatch: (8, 45)
        case .soil: (9, 0)
        case .rock: (11, 20)
        case .mixed: (12, 0)
        }
        var context = context
        context.rotate(by: .degrees(degrees))
        // The box's corners in the turned pattern's coordinates.
        let turn = CGAffineTransform(rotationAngle: -degrees * .pi / 180)
        let corners = [CGPoint(x: box.minX, y: box.minY), CGPoint(x: box.maxX, y: box.minY),
                       CGPoint(x: box.minX, y: box.maxY), CGPoint(x: box.maxX, y: box.maxY)].map { $0.applying(turn) }
        let xs = corners.map(\.x), ys = corners.map(\.y)
        let columns = Int((xs.min()! / size).rounded(.down))...Int((xs.max()! / size).rounded(.up))
        let rows = Int((ys.min()! / size).rounded(.down))...Int((ys.max()! / size).rounded(.up))
        let top = CGFloat(rows.lowerBound) * size, bottom = CGFloat(rows.upperBound + 1) * size

        func lines(at offset: CGFloat, width: CGFloat) -> Path {
            var path = Path()
            for column in columns {
                let x = CGFloat(column) * size + offset
                path.move(to: CGPoint(x: x, y: top))
                path.addLine(to: CGPoint(x: x, y: bottom))
            }
            return path.strokedPath(StrokeStyle(lineWidth: width))
        }
        func dots(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> Path {
            var path = Path()
            for column in columns {
                for row in rows {
                    let x = CGFloat(column) * size + cx, y = CGFloat(row) * size + cy
                    path.addEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
                }
            }
            return path
        }
        func layer(_ path: Path, _ hex: String, _ opacity: Double) {
            var layer = context
            layer.opacity *= opacity
            layer.fill(path, with: .color(color(hex)))
        }

        switch pattern {
        case .hatch:
            layer(lines(at: 0.625, width: 1.25), "#c2410c", 1)
        case .soil:
            layer(dots(1.6, 2.2, 0.8), palette.texture, 0.5)
            layer(dots(6.2, 5.4, 0.6), palette.texture, 0.4)
            layer(dots(3.6, 7.6, 0.5), palette.texture, 0.35)
        case .rock:
            layer(lines(at: 0.225, width: 0.45), palette.crack, 0.55)
            layer(lines(at: 5.5, width: 0.6), palette.texture, 0.4)
        case .mixed:
            layer(dots(3, 3.4, 0.7), palette.texture, 0.45)
            var seams = Path()
            for column in columns {
                for row in rows {
                    let x = CGFloat(column) * size, y = CGFloat(row) * size
                    seams.move(to: CGPoint(x: x + 7, y: y + 2))
                    seams.addLine(to: CGPoint(x: x + 10.5, y: y + 9.5))
                }
            }
            layer(seams.strokedPath(StrokeStyle(lineWidth: 0.7)), palette.crack, 0.4)
        }
    }
}
