import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A drone survey on a form, as the website uploaded it.
public struct DroneSurvey: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let label: String?
    public let dsmFilename: String?
    public let capturedOn: String?
    public let source: String?
    public let verticalOffsetM: Double
    /// What it is compared with, chosen by whoever measured it on the website.
    public let compareWithSurveyId: Int?

    public init(id: Int, label: String?, dsmFilename: String?, capturedOn: String?, source: String?, verticalOffsetM: Double, compareWithSurveyId: Int?) {
        self.id = id
        self.label = label
        self.dsmFilename = dsmFilename
        self.capturedOn = capturedOn
        self.source = source
        self.verticalOffsetM = verticalOffsetM
        self.compareWithSurveyId = compareWithSurveyId
    }

    private var name: String {
        if let label = label?.trimmingCharacters(in: .whitespaces), !label.isEmpty { return label }
        return dsmFilename ?? "Survey \(id)"
    }

    /// Its name and flight date: "After the storm, 2017-05-27".
    public var title: String { capturedOn.map { "\(name), \($0)" } ?? name }

    /// True when `before` was flown after `now`, so lost and gained read reversed.
    public static func flownOutOfOrder(before: DroneSurvey, now: DroneSurvey) -> Bool {
        guard let a = before.capturedOn, let b = now.capturedOn else { return false }
        return a > b
    }
}

/// A survey's heights on a regular grid, north row first: NaN where the drone saw nothing.
public struct DroneGrid: Equatable, Sendable {
    public var west: Double, south: Double, east: Double, north: Double
    public var cols: Int, rows: Int
    public var values: [Float]

    public init(west: Double, south: Double, east: Double, north: Double, cols: Int, rows: Int, values: [Float]) {
        self.west = west
        self.south = south
        self.east = east
        self.north = north
        self.cols = cols
        self.rows = rows
        self.values = values
    }

    public struct Damaged: Error, Equatable {}
    private static let magic = Data("ERISDSM1".utf8)
    private struct Header: Codable { let west, south, east, north: Double; let cols, rows: Int }

    /// The website's elevation patch: magic, header length, JSON header, then little-endian Float32s.
    public init(patch data: Data) throws {
        let bytes = [UInt8](data)
        guard bytes.count >= 12, Data(bytes[0..<8]) == Self.magic else { throw Damaged() }
        let headerLength = Int(UInt32(bytes[8]) | UInt32(bytes[9]) << 8 | UInt32(bytes[10]) << 16 | UInt32(bytes[11]) << 24)
        guard bytes.count >= 12 + headerLength,
              let header = try? JSONDecoder().decode(Header.self, from: Data(bytes[12..<(12 + headerLength)])) else { throw Damaged() }
        let base = 12 + headerLength
        guard header.cols > 0, header.rows > 0, bytes.count == base + header.cols * header.rows * 4 else { throw Damaged() }
        var values = [Float](repeating: .nan, count: header.cols * header.rows)
        for i in values.indices {
            let at = base + i * 4
            let raw = UInt32(bytes[at]) | UInt32(bytes[at + 1]) << 8 | UInt32(bytes[at + 2]) << 16 | UInt32(bytes[at + 3]) << 24
            values[i] = Float(bitPattern: raw)
        }
        self.init(west: header.west, south: header.south, east: header.east, north: header.north, cols: header.cols, rows: header.rows, values: values)
    }

    /// The same format, for tests and the demo.
    public func patch() -> Data {
        var header = (try? JSONEncoder().encode(Header(west: west, south: south, east: east, north: north, cols: cols, rows: rows))) ?? Data()
        while (12 + header.count) % 4 != 0 { header.append(0x20) }
        var out = Self.magic
        withUnsafeBytes(of: UInt32(header.count).littleEndian) { out.append(contentsOf: $0) }
        out.append(header)
        for value in values { withUnsafeBytes(of: value.bitPattern.littleEndian) { out.append(contentsOf: $0) } }
        return out
    }

    func covers(_ spot: SiteTerrain.Spot) -> Bool {
        spot.lon >= west && spot.lon <= east && spot.lat >= south && spot.lat <= north
    }

    /// The height at a point: bilinear between the four nearest cell centres, using those
    /// with data when they carry at least half the weight, or nil outside or over a hole.
    public func height(at spot: SiteTerrain.Spot) -> Double? {
        guard covers(spot) else { return nil }
        let fx = (spot.lon - west) / (east - west) * Double(cols) - 0.5
        let fy = (north - spot.lat) / (north - south) * Double(rows) - 0.5
        let x0 = max(0, min(cols - 1, Int(fx.rounded(.down))))
        let y0 = max(0, min(rows - 1, Int(fy.rounded(.down))))
        let x1 = min(cols - 1, x0 + 1), y1 = min(rows - 1, y0 + 1)
        let tx = max(0, min(1, fx - Double(x0))), ty = max(0, min(1, fy - Double(y0)))
        let corners: [(Float, Double)] = [
            (values[y0 * cols + x0], (1 - tx) * (1 - ty)),
            (values[y0 * cols + x1], tx * (1 - ty)),
            (values[y1 * cols + x0], (1 - tx) * ty),
            (values[y1 * cols + x1], tx * ty),
        ]
        var (sum, weight) = (0.0, 0.0)
        for (value, w) in corners where value.isFinite && w > 0 {
            sum += Double(value) * w
            weight += w
        }
        return weight >= 0.5 ? sum / weight : nil
    }

    public static let seaLevelM = 0.0

    /// Where the drone saw nothing and the nearest ground it did see is at the shore, the
    /// gap is the sea it could not map: those cells are set to sea level. Inland holes stay.
    public func seaFilled(offsetM: Double, shoreM: Double = 5) -> DroneGrid {
        let n = cols * rows
        var nearest = [Float](repeating: .nan, count: n)
        var queue = [Int]()
        queue.reserveCapacity(n)
        for i in 0..<n where values[i].isFinite {
            nearest[i] = values[i]
            queue.append(i)
        }
        // Breadth-first from every cell with data: each gap takes the height that reaches it first.
        var head = 0
        while head < queue.count {
            let k = queue[head]
            head += 1
            let (r, c) = (k / cols, k % cols)
            for dr in -1...1 {
                for dc in -1...1 where !(dr == 0 && dc == 0) {
                    let (rr, cc) = (r + dr, c + dc)
                    guard rr >= 0, cc >= 0, rr < rows, cc < cols else { continue }
                    let j = rr * cols + cc
                    guard nearest[j].isNaN else { continue }
                    nearest[j] = nearest[k]
                    queue.append(j)
                }
            }
        }
        var out = self
        for i in 0..<n where !values[i].isFinite && nearest[i].isFinite && Double(nearest[i]) + offsetM <= shoreM {
            out.values[i] = Float(Self.seaLevelM - offsetM)
        }
        return out
    }
}

/// Reading surveys, kept on the iPhone once read so they can be measured with no signal.
public struct DroneSurveysAPI: Sendable {
    let api: APIClient
    let store: OfflineStore

    public init(api: APIClient, store: OfflineStore) {
        self.api = api
        self.store = store
    }

    private struct Items: Decodable { let items: [DroneSurvey] }

    /// The answer, kept; without a connection, the copy kept last time.
    private func kept(_ path: String, as name: String) async throws -> Data {
        do {
            let data = try await api.bytes("GET", path)
            store.keep(data, as: name)
            return data
        } catch let error as APIError where error.isUnreachable {
            guard let copy = store.copy(named: name) else { throw error }
            return copy.data
        }
    }

    public func list(_ submissionId: Int) async throws -> [DroneSurvey] {
        let data = try await kept("/submissions/\(submissionId)/drone-surveys", as: "drone-surveys-\(submissionId)")
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Items.self, from: data).items
    }

    public func grid(_ submissionId: Int, survey: Int) async throws -> DroneGrid {
        try DroneGrid(patch: try await kept("/submissions/\(submissionId)/drone-surveys/\(survey)/patch", as: "drone-patch-\(survey)"))
    }
}
