import Foundation
#if canImport(Compression)
import Compression
#endif

/// `GET /road-inventory/manifest`: the published road inventory and its mobile package.
public struct RoadInventoryManifest: Decodable, Equatable, Sendable {
    public struct Package: Decodable, Equatable, Sendable {
        public let available: Bool
        public let sizeBytes: Int?
        public let sha256: String?
        public let generatedAt: String?

        enum CodingKeys: String, CodingKey {
            case available, sha256
            case sizeBytes = "size_bytes", generatedAt = "generated_at"
        }
    }

    public let versionId: Int
    public let versionTag: String
    public let extractDate: String?
    public let package: Package

    enum CodingKeys: String, CodingKey {
        case package
        case versionId = "version_id", versionTag = "version_tag", extractDate = "extract_date"
    }
}

/// What the package on this iPhone is.
public struct RoadInventoryMeta: Codable, Equatable, Sendable {
    public let versionId: Int
    public let versionTag: String
    public let extractDate: String?
    public let sha256: String
    public let segmentCount: Int
    public let pointCount: Int
    public let syncedAt: Date
    /// When the server was last asked whether a newer one exists.
    public var checkedAt: Date
}

public enum RoadInventoryError: LocalizedError, Equatable {
    case notGenerated
    case integrity(expected: String, got: String)
    case unreadable(String)
    case unsupported(Int)

    public var errorDescription: String? {
        switch self {
        case .notGenerated:
            return "No mobile road data package has been generated yet. An administrator generates it from the web."
        case .integrity(let expected, let got):
            return "The road data download was damaged (expected \(expected.prefix(12))…, got \(got.prefix(12))…). Try again."
        case .unreadable(let why): return "The road data could not be read: \(why)"
        case .unsupported(let version): return "This road data package (version \(version)) needs a newer app."
        }
    }
}

/// The road inventory package (`/road-inventory/mobile-package/download`):
/// gzip JSON, schema 1 (segments) or 2 (segments and postmile reference
/// points). Checked against the manifest's SHA-256 before anything is kept.
public enum RoadInventoryPackage {
    public static func read(_ compressed: Data, expectedSHA256: String) throws -> (segments: [RoadSegment], points: [PostmilePoint]) {
        let got = SHA256.hex(compressed)
        guard got == expectedSHA256.lowercased() else { throw RoadInventoryError.integrity(expected: expectedSHA256, got: got) }
        return try parse(try Gzip.inflate(compressed))
    }

    static func parse(_ json: Data) throws -> (segments: [RoadSegment], points: [PostmilePoint]) {
        struct Body: Decodable {
            let schemaVersion: Int
            let segments: [RoadSegment]?
            let postmilePoints: [PostmilePoint]?
            enum CodingKeys: String, CodingKey {
                case segments, schemaVersion = "schema_version", postmilePoints = "postmile_points"
            }
        }
        let body: Body
        do {
            body = try JSONDecoder().decode(Body.self, from: json)
        } catch {
            throw RoadInventoryError.unreadable(String(describing: error))
        }
        guard body.schemaVersion == 1 || body.schemaVersion == 2 else { throw RoadInventoryError.unsupported(body.schemaVersion) }
        guard let segments = body.segments else { throw RoadInventoryError.unreadable("the segments are missing") }
        if body.schemaVersion == 2, body.postmilePoints == nil { throw RoadInventoryError.unreadable("the postmile points are missing") }
        return (segments, body.postmilePoints ?? [])
    }
}

/// The package kept on this iPhone: its files, what it is, and when to look for a newer one.
public final class RoadInventoryStore: @unchecked Sendable {
    public let directory: URL
    private let lock = NSLock()
    private var reference: RoadReference?

    public init(directory: URL) {
        self.directory = directory
    }

    private var metaURL: URL { directory.appendingPathComponent("meta.json") }
    private var dataURL: URL { directory.appendingPathComponent("reference.json") }

    public var meta: RoadInventoryMeta? {
        guard let data = try? Data(contentsOf: metaURL) else { return nil }
        return try? OfflineStore.decoder.decode(RoadInventoryMeta.self, from: data)
    }

    /// The lookups, loaded once.
    public func loaded() -> RoadReference? {
        lock.lock()
        defer { lock.unlock() }
        if let reference { return reference }
        struct Stored: Decodable { let segments: [RoadSegment]; let points: [PostmilePoint] }
        guard let data = try? Data(contentsOf: dataURL), let stored = try? JSONDecoder().decode(Stored.self, from: data) else { return nil }
        reference = RoadReference(segments: stored.segments, points: stored.points)
        return reference
    }

    /// A day after the last look, or never looked.
    public func due(now: Date = Date()) -> Bool {
        guard let meta else { return true }
        return now.timeIntervalSince(meta.checkedAt) > 24 * 3600
    }

    /// Asks ERIS for the published package and keeps it if it is newer than
    /// this iPhone's; the package now kept.
    @discardableResult
    public func update(api: APIClient, now: Date = Date()) async throws -> RoadInventoryMeta {
        let manifest = try await api.get("/road-inventory/manifest", preservingKeys: true, as: RoadInventoryManifest.self)
        guard manifest.package.available, let sha = manifest.package.sha256 else { throw RoadInventoryError.notGenerated }
        if var current = meta, current.sha256 == sha.lowercased() {
            current.checkedAt = now
            try write(current)
            return current
        }
        let compressed = try await api.bytes("GET", "/road-inventory/mobile-package/download")
        let (segments, points) = try RoadInventoryPackage.read(compressed, expectedSHA256: sha)
        struct Stored: Encodable { let segments: [RoadSegment]; let points: [PostmilePoint] }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(Stored(segments: segments, points: points)).write(to: dataURL, options: .atomic)
        let next = RoadInventoryMeta(versionId: manifest.versionId, versionTag: manifest.versionTag, extractDate: manifest.extractDate,
                                     sha256: sha.lowercased(), segmentCount: segments.count, pointCount: points.count,
                                     syncedAt: now, checkedAt: now)
        try write(next)
        keep(RoadReference(segments: segments, points: points))
        return next
    }

    private func keep(_ next: RoadReference?) {
        lock.lock()
        reference = next
        lock.unlock()
    }

    private func write(_ meta: RoadInventoryMeta) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try OfflineStore.encoder.encode(meta).write(to: metaURL, options: .atomic)
    }

    public func clear() {
        keep(nil)
        try? FileManager.default.removeItem(at: directory)
    }
}

/// gzip, as the server writes the package.
public enum Gzip {
    public static func inflate(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 18, bytes[0] == 0x1f, bytes[1] == 0x8b, bytes[2] == 8 else {
            throw RoadInventoryError.unreadable("not a gzip file")
        }
        let flags = bytes[3]
        var start = 10
        if flags & 0x04 != 0 { start += 2 + Int(bytes[start]) + Int(bytes[start + 1]) << 8 }  // FEXTRA
        if flags & 0x08 != 0 { while start < bytes.count, bytes[start] != 0 { start += 1 }; start += 1 }  // FNAME
        if flags & 0x10 != 0 { while start < bytes.count, bytes[start] != 0 { start += 1 }; start += 1 }  // FCOMMENT
        if flags & 0x02 != 0 { start += 2 }  // FHCRC
        let end = bytes.count - 8
        guard start < end else { throw RoadInventoryError.unreadable("the gzip file is cut short") }
        let size = Int(bytes[end + 4]) | Int(bytes[end + 5]) << 8 | Int(bytes[end + 6]) << 16 | Int(bytes[end + 7]) << 24
        #if canImport(Compression)
        // The size is stored modulo 4 GiB; a package is far smaller.
        var output = [UInt8](repeating: 0, count: max(size, 1))
        let written = bytes[start..<end].withUnsafeBufferPointer { source in
            compression_decode_buffer(&output, output.count, source.baseAddress!, source.count, nil, COMPRESSION_ZLIB)
        }
        guard written == size else { throw RoadInventoryError.unreadable("the gzip data did not expand as recorded") }
        return Data(output.prefix(written))
        #else
        throw RoadInventoryError.unreadable("gzip is not available on this platform")
        #endif
    }
}

/// SHA-256 in Swift (FIPS 180-4), so the package is checked the same way on
/// every platform ERISKit builds for.
public enum SHA256 {
    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    public static func hex(_ data: Data) -> String {
        digest(data).map { String(format: "%02x", $0) }.joined()
    }

    public static func digest(_ data: Data) -> [UInt8] {
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var message = [UInt8](data)
        let bitLength = UInt64(message.count) * 8
        message.append(0x80)
        while message.count % 64 != 56 { message.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) { message.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift))) }
        var w = [UInt32](repeating: 0, count: 64)
        for chunk in stride(from: 0, to: message.count, by: 64) {
            for i in 0..<16 {
                let j = chunk + i * 4
                w[i] = UInt32(message[j]) << 24 | UInt32(message[j + 1]) << 16 | UInt32(message[j + 2]) << 8 | UInt32(message[j + 3])
            }
            for i in 16..<64 {
                let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
            for i in 0..<64 {
                let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let t1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
                let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let t2 = s0 &+ maj
                hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
            }
            h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
            h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
        }
        return h.flatMap { value in (0..<4).map { UInt8(truncatingIfNeeded: value >> UInt32(24 - $0 * 8)) } }
    }

    private static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
}
