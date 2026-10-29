import Foundation

/// The measurement diagram as plain shapes, ported from
/// mobile/src/components/RoadCrossSectionRenderer.tsx so the geometry is
/// tested here and the app only paints it. Coordinates are SVG-style: points,
/// y down, text placed at its baseline.
public struct MeasurementDiagramScene: Sendable {
    public struct Point: Equatable, Sendable {
        public let x, y: Double
        init(_ x: Double, _ y: Double) { self.x = x; self.y = y }
    }

    public struct Stop: Equatable, Sendable {
        public let offset: Double, color: String, opacity: Double
    }

    /// A fill pattern, tiled in the diagram's own coordinates.
    public enum Pattern: Sendable { case hatch, soil, rock, mixed }

    public enum Paint: Equatable, Sendable {
        case color(String)
        /// Top to bottom across the filled shape's bounds.
        case gradient([Stop])
        case pattern(Pattern)
    }

    public enum Anchor: Sendable { case start, middle, end }

    public enum Item: Equatable, Sendable {
        case polygon([Point], paint: Paint, opacity: Double)
        case rect(x: Double, y: Double, width: Double, height: Double, paint: Paint, opacity: Double, radius: Double)
        case line(Point, Point, color: String, width: Double, dash: [Double], opacity: Double)
        case circle(Point, radius: Double, fill: String, stroke: String?, strokeWidth: Double, opacity: Double)
        case text(String, at: Point, size: Double, color: String, anchor: Anchor, bold: Bool)
    }

    public static let height = 270.0
    public let width: Double
    public let palette: TerrainPalette
    public private(set) var items: [Item] = []
    /// "SR 17  |  SCL  |  PM 5–6", or "Road Cross-Section".
    public let header: String

    public init(_ data: MeasurementDiagramData, width: Double) {
        let w = max(200, width)
        self.width = w
        palette = TerrainPalette(data.appearance)
        header = Self.header(data.crossSection)
        let layout = Layout(data.crossSection, width: w)
        items.append(.rect(x: 0, y: 0, width: w, height: Self.height,
                           paint: .gradient([Stop(offset: 0, color: palette.skyTop, opacity: 1),
                                             Stop(offset: 1, color: palette.skyBottom, opacity: 1)]),
                           opacity: 1, radius: 0))
        terrain(data, layout)
        road(data.crossSection, layout)
        switch data.template {
        case .aboveRoad: for side in data.failureSide.sides { aboveRoad(data.measurements, side, layout) }
        case .belowRoad: for side in data.failureSide.sides { belowRoad(data.measurements, side, layout) }
        case .throughRoad: throughRoad(data.measurements, layout)
        }
        widthLabels(layout.elements)
        sideChipsAndStations()
        headerBar(data.crossSection.source)
    }

    // MARK: Constants and colours

    static let roadTop = 88.0, roadBottom = 148.0, margin = 32.0
    static let aboveHeight = roadTop - 8, belowHeight = height - roadBottom - 20
    static let dimY = roadBottom + 14, footerY = height - 8
    static let terrainTop = 8.0, terrainBottom = height - 16

    enum C {
        static let laneDivider = "#9ca3af", edgeLine = "#f3f4f6", centreline = "#fbbf24"
        static let medianRaised = "#1f2937", medianBarrier = "#78716c", slopeLine = "#34d399", hatch = "#c2410c"
        static let scarp = "#ef4444", dim = "#f59e0b", dimText = "#fef3c7", muted = "#64748b"
        static let ltChip = "#1d4ed8", rtChip = "#15803d", header = "#94a3b8"
    }

    /// `${n}` as JavaScript prints a number.
    static func js(_ n: Double) -> String { JS.numberText(n) }
    /// `Math.round(n)`.
    static func rounded(_ n: Double) -> String { js((n + 0.5).rounded(.down)) }
    /// A measurement as the TypeScript tests it: zero and missing are both "not given".
    static func given(_ n: Double?) -> Double? { n == 0 ? nil : n }

    // MARK: Layout

    enum Kind: Equatable { case ltShoulderOuter, ltLane, ltShoulderInner, median, rtShoulderInner, rtLane, rtShoulderOuter }

    struct Element: Equatable {
        let kind: Kind, x: Double, w: Double, ft: Double, lane: Int?
        var isShoulder: Bool { [.ltShoulderOuter, .ltShoulderInner, .rtShoulderInner, .rtShoulderOuter].contains(kind) }
    }

    struct Layout {
        var elements: [Element] = []
        let ltEdge: Double, rtEdge: Double, cx: Double, width: Double

        init(_ cs: RoadCrossSection, width: Double) {
            self.width = width
            let scale = (width - 2 * margin) / max(cs.totalWidthFt, 1)
            var x = margin
            var out: [Element] = []
            func push(_ kind: Kind, _ ft: Double, _ lane: Int? = nil) {
                let w = ft * scale
                if w > 0 { out.append(Element(kind: kind, x: x, w: w, ft: ft, lane: lane)) }
                x += w
            }
            // Upstation: LT outer shoulder, LT lanes, LT inner shoulder, median, then RT mirrored.
            push(.ltShoulderOuter, cs.ltOutsideShoulderFt)
            for i in 0..<cs.ltLaneCount { push(.ltLane, cs.ltLaneWidthFt, i) }
            push(.ltShoulderInner, cs.ltInsideShoulderFt)
            push(.median, cs.medianWidthFt)
            push(.rtShoulderInner, cs.rtInsideShoulderFt)
            for i in 0..<cs.rtLaneCount { push(.rtLane, cs.rtLaneWidthFt, i) }
            push(.rtShoulderOuter, cs.rtOutsideShoulderFt)
            elements = out
            ltEdge = margin
            rtEdge = min(x, width - margin)
            cx = margin + (cs.ltOutsideShoulderFt + Double(cs.ltLaneCount) * cs.ltLaneWidthFt + cs.ltInsideShoulderFt
                           + cs.medianWidthFt / 2) * scale
        }
    }

    // MARK: Terrain

    enum Ground { case high, low, flat }

    struct Side {
        let ground: Ground
        let outline: [Point]
        let surface: (Point, Point)
    }

    static func sides(_ shape: TerrainShape, _ layout: Layout) -> [Side] {
        let kinds: (Ground, Ground)
        switch shape {
        case .leftHigh: kinds = (.high, .low)
        case .rightHigh: kinds = (.low, .high)
        case .bowl: kinds = (.low, .low)
        case .crown: kinds = (.high, .high)
        case .flat: kinds = (.flat, .flat)
        }
        let lowY = roadBottom + (terrainBottom - roadBottom) * 0.65
        let (lt, rt, w) = (layout.ltEdge, layout.rtEdge, layout.width)
        func outerY(_ ground: Ground) -> Double { ground == .high ? terrainTop : ground == .low ? lowY : roadTop }
        func edgeY(_ ground: Ground) -> Double { ground == .low ? roadBottom : roadTop }
        let left = Side(ground: kinds.0,
                        outline: [Point(0, outerY(kinds.0)), Point(lt, edgeY(kinds.0)), Point(lt, terrainBottom),
                                  Point(0, terrainBottom)],
                        surface: (Point(0, outerY(kinds.0)), Point(lt, edgeY(kinds.0))))
        let right = Side(ground: kinds.1,
                         outline: [Point(rt, edgeY(kinds.1)), Point(w, outerY(kinds.1)), Point(w, terrainBottom),
                                   Point(rt, terrainBottom)],
                         surface: (Point(rt, edgeY(kinds.1)), Point(w, outerY(kinds.1))))
        return [left, right]
    }

    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

    private mutating func terrain(_ data: MeasurementDiagramData, _ layout: Layout) {
        let a = data.appearance
        let texture: Pattern = a.dominantMaterial == .rock ? .rock : a.dominantMaterial == .soil ? .soil : .mixed
        for side in Self.sides(data.terrainShape, layout) {
            items.append(.polygon(side.outline, paint: .gradient([Stop(offset: 0, color: palette.top, opacity: 1),
                                                                  Stop(offset: 0.5, color: palette.mid, opacity: 1),
                                                                  Stop(offset: 1, color: palette.deep, opacity: 1)]),
                                  opacity: 1))
            items.append(.polygon(side.outline, paint: .gradient([Stop(offset: 0, color: "#000000", opacity: 0),
                                                                  Stop(offset: 0.62, color: "#000000", opacity: 0),
                                                                  Stop(offset: 1, color: "#000000", opacity: 0.5)]),
                                  opacity: 0.72))
            items.append(.polygon(side.outline, paint: .pattern(texture), opacity: 0.42 + a.rockiness * 0.1))
            if a.moistureLevel > 0.18 {
                items.append(.polygon(side.outline, paint: .gradient([Stop(offset: 0, color: palette.moisture, opacity: 0),
                                                                      Stop(offset: 0.55, color: palette.moisture, opacity: 0.25),
                                                                      Stop(offset: 1, color: palette.moisture, opacity: 0.82)]),
                                      opacity: 0.28 + a.moistureLevel * 0.24))
            }
            let (s1, s2) = side.surface
            items.append(.line(s1, s2, color: a.vegetationDensity > 0.12 ? palette.vegetation : palette.texture,
                               width: 2.2, dash: [], opacity: 0.95))
            items.append(.line(Point(s1.x, s1.y + 1.1), Point(s2.x, s2.y + 1.1), color: palette.crack, width: 1.2, dash: [],
                               opacity: 0.35))
            vegetation(side, a)
            rocks(side, a)
            moisture(side, a)
        }
    }

    private mutating func vegetation(_ side: Side, _ a: TerrainAppearance) {
        guard a.vegetationDensity >= 0.12 else { return }
        let count = a.vegetationDensity > 0.58 ? 4 : a.vegetationDensity > 0.32 ? 3 : 2
        let (s1, s2) = side.surface
        for i in 0..<count {
            let t = 0.14 + 0.72 * Double(i) / Double(count - 1)
            let x = Self.lerp(s1.x, s2.x, t)
            let y = Self.lerp(s1.y, s2.y, t) - 2.6 - Double(i % 2) * 1.4
            let r = 2.5 + a.vegetationDensity * 2.2 + a.treesPct / 100 * 1.2
            items.append(.circle(Point(x, y + 1.1), radius: r * 0.9, fill: palette.vegetationDark, stroke: nil, strokeWidth: 0,
                                 opacity: 0.5))
            items.append(.circle(Point(x, y), radius: r, fill: palette.vegetation, stroke: nil, strokeWidth: 0, opacity: 1))
        }
    }

    private mutating func rocks(_ side: Side, _ a: TerrainAppearance) {
        guard a.rockiness >= 0.35 || a.boulderPct >= 8 else { return }
        let count = a.boulderPct > 26 ? 4 : a.rockiness > 0.66 ? 3 : 2
        let (s1, s2) = side.surface
        for i in 0..<count {
            let t = 0.2 + Double(i) * 0.22
            let depth = (side.ground == .high ? 0.34 : 0.46) + Double(i) * 0.08
            let x = Self.lerp(s1.x, s2.x, t)
            let y = Self.lerp(Self.lerp(s1.y, s2.y, t), Self.terrainBottom - 14, Palette.clamp01(depth))
            let r = 2.6 + a.rockiness * 1.9 + a.boulderPct / 100 * 2.6 + (i == count - 1 ? 0.8 : 0)
            items.append(.circle(Point(x, y), radius: r, fill: palette.stone, stroke: palette.stoneShade, strokeWidth: 0.9,
                                 opacity: 1))
            items.append(.line(Point(x - r * 0.5, y - r * 0.3), Point(x + r * 0.25, y - r * 0.55), color: "#ffffff",
                               width: 0.7, dash: [], opacity: 0.18))
        }
    }

    private mutating func moisture(_ side: Side, _ a: TerrainAppearance) {
        guard a.moistureLevel >= 0.52 || a.seep || a.spring else { return }
        let (s1, s2) = side.surface
        let dir: Double = s2.x >= s1.x ? 1 : -1
        for i in 0..<(a.moisture == .flowing ? 2 : 1) {
            let t = 0.32 + Double(i) * 0.26
            let start = Point(Self.lerp(s1.x, s2.x, t), Self.lerp(s1.y, s2.y, t))
            let end = Point(start.x + dir * (8 + Double(i) * 4), min(Self.terrainBottom - 12, start.y + 24 + Double(i) * 10))
            items.append(.line(Point(start.x, start.y + 1), end, color: palette.moisture, width: 1.6, dash: [], opacity: 0.7))
            items.append(.line(Point(start.x + dir * 1.2, start.y + 2.2), Point(end.x + dir * 1.2, end.y), color: "#dbeafe",
                               width: 0.65, dash: [], opacity: 0.4))
        }
    }

    // MARK: Road

    private mutating func road(_ cs: RoadCrossSection, _ layout: Layout) {
        let (top, bottom) = (Self.roadTop, Self.roadBottom)
        for el in layout.elements {
            var fill = el.isShoulder ? palette.shoulder : palette.road
            if el.kind == .median {
                fill = cs.medianCategory == .barrier ? C.medianBarrier : cs.medianCategory == .raised ? C.medianRaised : palette.road
            }
            items.append(.rect(x: el.x, y: top, width: el.w, height: bottom - top, paint: .color(fill), opacity: 1, radius: 0))
        }
        for el in layout.elements where (el.kind == .ltLane || el.kind == .rtLane) && el.lane != 0 {
            items.append(.line(Point(el.x, top), Point(el.x, bottom), color: C.laneDivider, width: 1, dash: [6, 4], opacity: 1))
        }
        let lt = layout.elements.filter { $0.kind == .ltLane }, rt = layout.elements.filter { $0.kind == .rtLane }
        let ltLeft = lt.first?.x ?? layout.cx, ltRight = lt.last.map { $0.x + $0.w } ?? layout.cx
        let rtLeft = rt.first?.x ?? layout.cx, rtRight = rt.last.map { $0.x + $0.w } ?? layout.cx
        items += [
            .line(Point(ltLeft, top), Point(ltLeft, bottom), color: C.edgeLine, width: 2, dash: [], opacity: 1),
            .line(Point(rtRight, top), Point(rtRight, bottom), color: C.edgeLine, width: 2, dash: [], opacity: 1),
            .line(Point(ltLeft, top + 2), Point(rtRight, top + 2), color: palette.roadEdge, width: 1.2, dash: [], opacity: 0.55),
            .line(Point(ltLeft, bottom - 2), Point(rtRight, bottom - 2), color: palette.roadEdge, width: 1.1, dash: [],
                  opacity: 0.35),
        ]
        if cs.medianCategory == .none || cs.medianWidthFt == 0 {
            for dx in [-2.0, 2] {
                items.append(.line(Point(layout.cx + dx, top), Point(layout.cx + dx, bottom), color: C.centreline, width: 1.5,
                                   dash: [8, 4], opacity: 1))
            }
        } else if cs.medianCategory == .painted {
            for x in [ltRight, rtLeft] {
                items.append(.line(Point(x, top), Point(x, bottom), color: C.centreline, width: 2, dash: [], opacity: 1))
            }
        }
        for y in [top, bottom] {
            items.append(.line(Point(ltLeft, y), Point(rtRight, y), color: C.edgeLine, width: 1, dash: [], opacity: 1))
        }
    }

    /// Lane groups ("LT 2×12'"), shoulders ("8'") and the median ("MDN 22'").
    static func widthGroups(_ elements: [Element]) -> [(label: String, x1: Double, x2: Double)] {
        var groups: [(String, Double, Double)] = []
        var i = 0
        while i < elements.count {
            let el = elements[i]
            if el.kind == .ltLane || el.kind == .rtLane {
                var j = i + 1
                while j < elements.count, elements[j].kind == el.kind { j += 1 }
                let count = j - i, side = el.kind == .ltLane ? "LT" : "RT"
                let last = elements[j - 1]
                groups.append((count > 1 ? "\(side) \(count)×\(rounded(el.ft))'" : "\(side) \(rounded(el.ft))'", el.x,
                               last.x + last.w))
                i = j
                continue
            }
            if el.isShoulder { groups.append(("\(rounded(el.ft))'", el.x, el.x + el.w)) }
            if el.kind == .median, el.ft > 0 { groups.append(("MDN \(rounded(el.ft))'", el.x, el.x + el.w)) }
            i += 1
        }
        return groups
    }

    private mutating func widthLabels(_ elements: [Element]) {
        let tickY = Self.dimY + 4
        for group in Self.widthGroups(elements) where group.x2 - group.x1 >= 16 {
            items += [
                .line(Point(group.x1, Self.roadBottom), Point(group.x1, tickY), color: C.muted, width: 0.8, dash: [], opacity: 1),
                .line(Point(group.x2, Self.roadBottom), Point(group.x2, tickY), color: C.muted, width: 0.8, dash: [], opacity: 1),
                .line(Point(group.x1, tickY), Point(group.x2, tickY), color: C.muted, width: 0.8, dash: [], opacity: 1),
                .text(group.label, at: Point((group.x1 + group.x2) / 2, Self.dimY + 10), size: 8.5, color: C.muted,
                      anchor: .middle, bold: false),
            ]
        }
    }

    // MARK: Landslide overlays

    /// The road edge on a side, and which way is away from the road there.
    private func edge(_ side: FailureSide, _ layout: Layout) -> (x: Double, dir: Double) {
        let x = side == .lt ? layout.ltEdge : layout.rtEdge
        return (x, x < layout.width / 2 ? -1 : 1)
    }

    private mutating func verticalDimension(x: Double, _ y1: Double, _ y2: Double, _ label: String) {
        items += [
            .line(Point(x, y1), Point(x, y2), color: C.dim, width: 1.5, dash: [], opacity: 1),
            .line(Point(x - 4, y1), Point(x + 4, y1), color: C.dim, width: 1.5, dash: [], opacity: 1),
            .line(Point(x - 4, y2), Point(x + 4, y2), color: C.dim, width: 1.5, dash: [], opacity: 1),
            .text(label, at: Point(x + 6, (y1 + y2) / 2 + 4), size: 9, color: C.dimText, anchor: .start, bold: true),
        ]
    }

    private mutating func aboveRoad(_ m: MeasurementValues, _ side: FailureSide, _ layout: Layout) {
        let (edge, dir) = edge(side, layout)
        let top = Self.roadTop
        let slope = Self.given(m.slopeHeightFt), original = Self.given(m.originalSlopeDeg)
        let scarp = Self.given(m.mainScarpHeightFt)
        let hs = slope.map { min(Self.aboveHeight - 8, $0 * 1.2) } ?? Self.aboveHeight * 0.65
        let phi = original.map { $0 * .pi / 180 } ?? atan(0.6)
        let run = hs / tan(max(0.15, phi))
        let tip = Point(edge + dir * run, top - hs)
        let scarpHeight = scarp.map { min(hs * 0.7, $0) } ?? hs * 0.5
        let scarpX = edge + dir * run * 0.4
        items += [
            .polygon([Point(edge, top), tip, Point(scarpX + dir * run * 0.15, top - scarpHeight), Point(scarpX, top)],
                     paint: .pattern(.hatch), opacity: 0.85),
            .line(Point(edge, top), tip, color: C.slopeLine, width: 2, dash: [], opacity: 1),
            .line(Point(scarpX, top), Point(scarpX, top - scarpHeight), color: C.scarp, width: 2, dash: [4, 3], opacity: 1),
        ]
        verticalDimension(x: edge + dir * (run + 14), top - hs, top, slope.map { "H-S \(Self.js($0))'" } ?? "H-S")
        items.append(.text(original.map { "Φ-OS \(Self.js($0))°" } ?? "Φ-OS", at: Point(edge + dir * 12, top - 10), size: 9,
                           color: C.dimText, anchor: .middle, bold: false))
        if let scarp {
            items.append(.text("H-HS \(Self.js(scarp))'", at: Point(scarpX + dir * 12, top - scarpHeight / 2), size: 9,
                               color: C.scarp, anchor: .start, bold: false))
        }
    }

    private mutating func belowRoad(_ m: MeasurementValues, _ side: FailureSide, _ layout: Layout) {
        let (edge, dir) = edge(side, layout)
        let bottom = Self.roadBottom
        let slope = Self.given(m.slopeHeightFt), slide = Self.given(m.landslideSlopeDeg)
        let hs = slope.map { min(Self.belowHeight - 8, $0) } ?? Self.belowHeight * 0.65
        let phi = slide.map { $0 * .pi / 180 } ?? atan(0.5)
        let run = hs / tan(max(0.1, phi))
        let tip = Point(edge + dir * run, bottom + hs)
        items += [
            .polygon([Point(edge, bottom), tip, Point(edge + dir * run * 0.6, tip.y)], paint: .pattern(.hatch), opacity: 0.85),
            .line(Point(edge, bottom), tip, color: C.slopeLine, width: 2, dash: [], opacity: 1),
        ]
        verticalDimension(x: edge + dir * (run + 14), bottom, bottom + hs, slope.map { "H-S \(Self.js($0))'" } ?? "H-S")
        items.append(.text(slide.map { "Φ-SS \(Self.js($0))°" } ?? "Φ-SS", at: Point(edge + dir * 14, bottom + 18), size: 9,
                           color: C.dimText, anchor: .middle, bold: false))
    }

    private mutating func throughRoad(_ m: MeasurementValues, _ layout: Layout) {
        let (lt, rt, cx) = (layout.ltEdge, layout.rtEdge, layout.cx)
        let (top, bottom) = (Self.roadTop, Self.roadBottom)
        let offset = (rt - lt) * 0.22
        let y = Self.dimY - 6
        let label = Self.given(m.landslideWidthFt).map { "W-M \(Self.js($0))'" } ?? "W-M"
        items += [
            .rect(x: lt, y: top, width: rt - lt, height: bottom - top, paint: .pattern(.hatch), opacity: 0.55, radius: 0),
            .line(Point(cx - offset, top), Point(cx, bottom), color: C.scarp, width: 2, dash: [5, 3], opacity: 1),
            .line(Point(cx, top), Point(cx + offset, bottom), color: C.scarp, width: 2, dash: [5, 3], opacity: 1),
            .line(Point(lt, y), Point(rt, y), color: C.dim, width: 1.5, dash: [], opacity: 1),
            .line(Point(lt, y - 5), Point(lt, y + 5), color: C.dim, width: 1.5, dash: [], opacity: 1),
            .line(Point(rt, y - 5), Point(rt, y + 5), color: C.dim, width: 1.5, dash: [], opacity: 1),
            .text(label, at: Point((lt + rt) / 2, y - 3), size: 9, color: C.dimText, anchor: .middle, bold: true),
        ]
        if let width = Self.given(m.roadwayWidthFt) {
            items.append(.text("R&S \(Self.js(width))'", at: Point(cx, y - 14), size: 9, color: C.dimText, anchor: .middle,
                               bold: false))
        }
        if let length = Self.given(m.landslideLengthFt) {
            items.append(.text("TLS: \(Self.js(length))' (along slope)", at: Point(cx, bottom + 32), size: 9, color: C.dimText,
                               anchor: .middle, bold: false))
        }
    }

    // MARK: Labels

    private mutating func sideChipsAndStations() {
        let y = Self.roadTop + (Self.roadBottom - Self.roadTop) / 2 + 4
        for (text, x, colour) in [("LT", 2.0, C.ltChip), ("RT", width - 28, C.rtChip)] {
            items.append(.rect(x: x, y: y - 11, width: 26, height: 13, paint: .color(colour), opacity: 1, radius: 3))
            items.append(.text(text, at: Point(x + 13, y), size: 10, color: "#ffffff", anchor: .middle, bold: true))
        }
        items.append(.text("UPSTATION →", at: Point(width - 4, Self.footerY - 1), size: 9, color: "#60a5fa", anchor: .end,
                           bold: true))
        items.append(.text("← DOWNSTATION", at: Point(4, Self.footerY - 1), size: 9, color: "#94a3b8", anchor: .start,
                           bold: false))
    }

    public static func header(_ cs: RoadCrossSection) -> String {
        var parts: [String] = []
        if let s = cs.segment {
            if let route = s.routeName, !route.isEmpty { parts.append("SR \(route)") }
            if let county = s.countyCode, !county.isEmpty { parts.append(county) }
            if let begin = s.beginPm, let end = s.endPm { parts.append("PM \(js(begin))–\(js(end))") }
            if let speed = given(s.designSpeed) { parts.append("\(js(speed)) mph") }
            if let terrain = s.terrainCode, !terrain.isEmpty { parts.append("Terrain: \(terrain)") }
        }
        return parts.isEmpty ? "Road Cross-Section" : parts.joined(separator: "  |  ")
    }

    private mutating func headerBar(_ source: RoadCrossSection.Source) {
        let badge = source == .roadInventory ? "ROAD INVENTORY" : source == .formFields ? "FROM FORM" : "DEFAULT"
        items += [
            .rect(x: 0, y: 0, width: width, height: 18, paint: .color("#1e293b"), opacity: 1, radius: 0),
            .text(header, at: Point(width / 2, 12), size: 9, color: C.header, anchor: .middle, bold: false),
            .rect(x: width - 72, y: 1, width: 70, height: 14, paint: .color(source == .roadInventory ? "#065f46" : "#78350f"),
                  opacity: 1, radius: 3),
            .text(badge, at: Point(width - 37, 11), size: 7.5, color: "#d1fae5", anchor: .middle, bold: true),
        ]
    }
}

extension FailureSide {
    /// The sides an overlay is drawn on.
    var sides: [FailureSide] { self == .both ? [.lt, .rt] : [self] }
}

extension MeasurementDiagramData {
    /// "Road: Road inventory  ·  Template: auto · pending GEO  ·  Terrain: …  ·  Elevation: …",
    /// what the diagram was drawn from. `template` and `terrain` nil mean AUTO.
    public static func note(source: RoadCrossSection.Source, template: DiagramTemplate?, terrain: TerrainShape?,
                            profile: ElevationProfile?) -> String {
        let road = source == .roadInventory ? "Road inventory" : source == .formFields ? "Form fields" : "Default"
        let templateNote = template.map(\.shortLabel) ?? "auto · pending GEO"
        let terrainNote: String
        if let terrain {
            terrainNote = "manual · \(terrain.shortLabel)"
        } else if let profile {
            if let shape = profile.classification, !shape.isEmpty, shape != "UNKNOWN" {
                terrainNote = "auto · USGS (\(shape))"
            } else {
                terrainNote = "auto · elevation unknown"
            }
        } else {
            terrainNote = "auto · no elevation profile"
        }
        let elevation: String
        if let profile {
            let failed = !(profile.error ?? "").isEmpty
            elevation = failed ? "error · \(profile.source ?? "USGS")" : profile.source ?? "USGS"
        } else {
            elevation = "not fetched"
        }
        return "Road: \(road)  ·  Template: \(templateNote)  ·  Terrain: \(terrainNote)  ·  Elevation: \(elevation)"
    }
}

extension DiagramTemplate {
    public var shortLabel: String {
        switch self {
        case .throughRoad: return "through road"
        case .aboveRoad: return "above road"
        case .belowRoad: return "below road"
        }
    }

    /// The selector's words.
    public var buttonLabel: String {
        switch self {
        case .throughRoad: return "Through"
        case .aboveRoad: return "Above"
        case .belowRoad: return "Below Road"
        }
    }
}

extension TerrainShape {
    public var shortLabel: String {
        switch self {
        case .leftHigh: return "left-high"
        case .rightHigh: return "right-high"
        case .bowl: return "bowl"
        case .crown: return "crown"
        case .flat: return "flat"
        }
    }

    /// The selector's words.
    public var buttonLabel: String {
        switch self {
        case .leftHigh: return "L-High"
        case .rightHigh: return "R-High"
        case .bowl: return "Bowl"
        case .crown: return "Crown"
        case .flat: return "Flat"
        }
    }
}

extension FailureSide {
    /// The selector's words.
    public var buttonLabel: String {
        switch self {
        case .lt: return "LT Side"
        case .rt: return "RT Side"
        case .both: return "Both"
        }
    }
}
