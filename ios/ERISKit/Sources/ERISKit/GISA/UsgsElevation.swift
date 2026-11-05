import Foundation

/// One tile of USGS 3DEP elevation, as ERIS sends it (LERC 1, "CntZImage"):
/// a grid of heights running corner to corner of the tile, NaN where it has no data.
public struct ElevationTile: Equatable, Sendable {
    public let width: Int
    public let height: Int
    public let values: [Float]

    public struct Damaged: Error, Equatable {}

    private struct Reader {
        let bytes: [UInt8]
        var at = 0

        mutating func raw(_ count: Int) throws -> ArraySlice<UInt8> {
            guard count >= 0, at + count <= bytes.count else { throw Damaged() }
            defer { at += count }
            return bytes[at..<(at + count)]
        }
        mutating func u8() throws -> UInt8 { try raw(1).first! }
        mutating func littleEndian(_ count: Int) throws -> UInt64 {
            var out: UInt64 = 0
            for (i, byte) in try raw(count).enumerated() { out |= UInt64(byte) << (8 * UInt64(i)) }
            return out
        }
        mutating func i16() throws -> Int { Int(Int16(truncatingIfNeeded: try littleEndian(2))) }
        mutating func i32() throws -> Int { Int(Int32(truncatingIfNeeded: try littleEndian(4))) }
        mutating func f32() throws -> Float { Float(bitPattern: UInt32(truncatingIfNeeded: try littleEndian(4))) }
        mutating func f64() throws -> Double { Double(bitPattern: try littleEndian(8)) }
    }

    public init(data: Data) throws {
        var r = Reader(bytes: [UInt8](data))
        guard Array(try r.raw(10)) == Array("CntZImage ".utf8) else { throw Damaged() }
        _ = try r.i32() // version
        _ = try r.i32() // type
        let height = try r.i32(), width = try r.i32()
        let maxError = try r.f64()
        guard width > 0, height > 0, width * height <= 4_194_304 else { throw Damaged() }
        let count = width * height

        // Which cells hold data: all, none, or a run-length coded bitmask.
        _ = try r.i32()
        _ = try r.i32()
        let maskBytes = try r.i32()
        let maskMax = try r.f32()
        var valid: [Bool]
        if maskBytes == 0 {
            valid = [Bool](repeating: maskMax > 0, count: count)
        } else {
            let end = r.at + maskBytes
            var bits = [UInt8]()
            while r.at < end {
                let run = try r.i16()
                if run == -32768 { break }
                if run > 0 {
                    bits.append(contentsOf: try r.raw(run))
                } else {
                    bits.append(contentsOf: repeatElement(try r.u8(), count: -run))
                }
            }
            guard bits.count >= (count + 7) / 8 else { throw Damaged() }
            valid = (0..<count).map { bits[$0 >> 3] & (128 >> UInt8($0 & 7)) != 0 }
            r.at = end
        }
        var values = [Float](repeating: .nan, count: count)
        guard valid.contains(true) else {
            self.init(width: width, height: height, values: values)
            return
        }

        // The heights, in blocks.
        let blocksY = max(1, try r.i32()), blocksX = max(1, try r.i32())
        let heightBytes = try r.i32()
        let maxZ = try r.f32()
        if heightBytes == 0 {
            for i in 0..<count where valid[i] { values[i] = maxZ }
            self.init(width: width, height: height, values: values)
            return
        }
        let blockH = height / blocksY, blockW = width / blocksX
        let rows = blocksY + (height % blocksY > 0 ? 1 : 0), cols = blocksX + (width % blocksX > 0 ? 1 : 0)
        for by in 0..<rows {
            let thisH = by < blocksY ? blockH : height % blocksY
            for bx in 0..<cols {
                let thisW = bx < blocksX ? blockW : width % blocksX
                var cells = [Int]()
                cells.reserveCapacity(thisH * thisW)
                for y in 0..<thisH {
                    for x in 0..<thisW {
                        let i = (by * blockH + y) * width + bx * blockW + x
                        if valid[i] { cells.append(i) }
                    }
                }
                let header = try r.u8()
                switch header & 63 {
                case 0: // Heights as they are.
                    for i in cells { values[i] = try r.f32() }
                case 2: // All zero.
                    for i in cells { values[i] = 0 }
                case 1, 3:
                    let offset: Double
                    switch header >> 6 {
                    case 0: offset = Double(try r.f32())
                    case 1: offset = Double(try r.i16())
                    default: offset = Double(Int8(bitPattern: try r.u8()))
                    }
                    if header & 63 == 3 { // All the same.
                        for i in cells { values[i] = Float(offset) }
                    } else {
                        try Self.unstuff(&r, into: &values, cells: cells, offset: offset, scale: 2 * maxError, maxZ: maxZ)
                    }
                default:
                    throw Damaged()
                }
            }
        }
        self.init(width: width, height: height, values: values)
    }

    /// Heights as small whole numbers packed into 32-bit words, top bits first.
    private static func unstuff(_ r: inout Reader, into values: inout [Float], cells: [Int], offset: Double, scale: Double, maxZ: Float) throws {
        let header = try r.u8()
        let bits = Int(header & 63)
        let stored: Int
        switch header >> 6 {
        case 0: stored = Int(try r.littleEndian(4))
        case 1: stored = Int(try r.littleEndian(2))
        default: stored = Int(try r.u8())
        }
        let byteCount = (stored * bits + 7) / 8
        let raw = Array(try r.raw(byteCount))
        let wordCount = (byteCount + 3) / 4
        var words = [UInt32](repeating: 0, count: wordCount)
        for (i, byte) in raw.enumerated() { words[i / 4] |= UInt32(byte) << UInt32(8 * (i % 4)) }
        let tail = wordCount * 4 - byteCount
        if tail > 0, wordCount > 0 { words[wordCount - 1] <<= UInt32(8 * tail) }
        guard stored >= cells.count else { throw Damaged() }

        let mask: UInt32 = bits >= 32 ? .max : (UInt32(1) << UInt32(bits)) - 1
        var (word, left, buffer) = (0, 0, UInt32(0))
        for i in cells {
            var n: UInt32 = 0
            if bits > 0 {
                if left == 0 {
                    guard word < wordCount else { throw Damaged() }
                    buffer = words[word]
                    word += 1
                    left = 32
                }
                if left >= bits {
                    n = (buffer >> UInt32(left - bits)) & mask
                    left -= bits
                } else {
                    let missing = bits - left
                    n = ((buffer & mask) << UInt32(missing)) & mask
                    guard word < wordCount else { throw Damaged() }
                    buffer = words[word]
                    word += 1
                    left = 32 - missing
                    n += buffer >> UInt32(left)
                }
            }
            values[i] = min(Float(offset + Double(n) * scale), maxZ)
        }
    }

    public init(width: Int, height: Int, values: [Float]) {
        self.width = width
        self.height = height
        self.values = values
    }

    /// Bilinear between the four posts around a spot given as fractions across the tile.
    func height(atX x: Double, y: Double) -> Double? {
        let fx = x * Double(width - 1), fy = y * Double(height - 1)
        let x0 = max(0, min(width - 2, Int(fx.rounded(.down))))
        let y0 = max(0, min(height - 2, Int(fy.rounded(.down))))
        let tx = fx - Double(x0), ty = fy - Double(y0)
        let a = values[y0 * width + x0], b = values[y0 * width + x0 + 1]
        let c = values[(y0 + 1) * width + x0], d = values[(y0 + 1) * width + x0 + 1]
        guard a.isFinite, b.isFinite, c.isFinite, d.isFinite else { return nil }
        return Double(a) * (1 - tx) * (1 - ty) + Double(b) * tx * (1 - ty) + Double(c) * (1 - tx) * ty + Double(d) * tx * ty
    }
}

/// USGS 3DEP elevation, read tile by tile from ERIS, with the website reading the same tiles
/// the same way (`elevationTile.ts`), so the iPhone and the website get the same heights.
/// USGS data is public domain, so the tiles may be kept on the iPhone for use with no signal.
/// Heights run about every metre, and USGS puts the finest source it has at each place on top.
public struct UsgsElevation: ElevationSampling {
    /// A tile's bytes, or nil if ERIS has none there.
    public typealias FetchTile = @Sendable (_ row: Int, _ col: Int) async throws -> Data?

    public static let name = "USGS 3DEP"
    static let level = 17
    static let originX = -20037508.342787, originY = 20037508.342787
    static let resolutionAtLevelZero = 156543.03392800014
    static let earthRadius = 6378137.0
    static let cellsPerTile = 256.0
    static var tileSizeM: Double { resolutionAtLevelZero / pow(2, Double(level)) * cellsPerTile }

    let fetch: FetchTile
    public var sourceName: String { Self.name }

    public init(fetch: @escaping FetchTile) { self.fetch = fetch }

    private struct Tile: Hashable { let row: Int, col: Int }
    private struct Place { let tile: Tile; let x: Double; let y: Double }

    static func mercator(_ spot: SiteTerrain.Spot) -> (x: Double, y: Double) {
        (spot.lon * .pi / 180 * earthRadius, earthRadius * log(tan(.pi / 4 + spot.lat * .pi / 360)))
    }

    private func place(_ spot: SiteTerrain.Spot) -> Place {
        let m = Self.mercator(spot)
        let size = Self.tileSizeM
        let col = ((m.x - Self.originX) / size).rounded(.down)
        let row = ((Self.originY - m.y) / size).rounded(.down)
        return Place(tile: Tile(row: Int(row), col: Int(col)),
                     x: (m.x - Self.originX) / size - col,
                     y: (Self.originY - m.y) / size - row)
    }

    public func heights(at spots: [SiteTerrain.Spot]) async throws -> [Double?] {
        guard !spots.isEmpty else { return [] }
        let places = spots.map(place)
        let fetch = self.fetch
        let tiles = try await withThrowingTaskGroup(of: (Tile, ElevationTile?).self) { group in
            var out: [Tile: ElevationTile] = [:]
            var running = 0
            for tile in Set(places.map(\.tile)) {
                // A few at a time: over a weak signal, more only makes them all time out.
                if running == Self.atOnce, let (done, read) = try await group.next() {
                    out[done] = read
                    running -= 1
                }
                group.addTask {
                    let data = try await fetch(tile.row, tile.col)
                    return (tile, try data.map { try ElevationTile(data: $0) })
                }
                running += 1
            }
            for try await (done, read) in group { out[done] = read }
            return out
        }
        return places.map { tiles[$0.tile]?.height(atX: $0.x, y: $0.y) }
    }

    static let atOnce = 6
}

extension SiteTerrain {
    /// The spots whose tiles to keep on the iPhone so an area measures the same with no signal:
    /// the area, its band, and far enough past them for the section down the slope.
    public static func spotsToKeep(_ rings: [[Spot]]) -> [Spot] {
        let plan = samplePlan(rings)
        let frame = Frame(centroid(rings[0]))
        let outline = rings[0].map(frame.xy)
        let margin = plan.bufferM + 20
        let (minX, maxX) = (outline.map(\.x).min()! - margin, outline.map(\.x).max()! + margin)
        let (minY, maxY) = (outline.map(\.y).min()! - margin, outline.map(\.y).max()! + margin)
        return plan.inside + plan.around + [frame.spot(minX, minY), frame.spot(minX, maxY), frame.spot(maxX, minY), frame.spot(maxX, maxY)]
    }

    /// The spots whose tiles to keep around a site, so an area drawn there with no signal can
    /// be measured too: within about `radiusM` of it, closer together than a tile is wide (at
    /// least 225 m in California) so that none is skipped. About 10 MB for a site.
    public static func spotsAround(latitude: Double, longitude: Double, radiusM: Double = 750) -> [Spot] {
        let frame = Frame(Spot(lon: longitude, lat: latitude))
        let gaps = Int((2 * radiusM / 200).rounded(.up))
        let steps = (0...gaps).map { -radiusM + 2 * radiusM * Double($0) / Double(gaps) }
        return steps.flatMap { y in steps.map { x in frame.spot(x, y) } }
    }
}
