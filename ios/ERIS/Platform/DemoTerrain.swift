import ERISKit
import Foundation
import UIKit

/// The demo form's offline terrain, built on the device: a slope falling to a
/// creek below the road, with hillshade and the road centerline, packaged as
/// the server would (an eristerrain ZIP) so the app checks and unpacks it the
/// same way.
enum DemoTerrain {
    static let site = (lat: 37.7312, lon: -122.1975)
    static let rows = 81, cols = 81
    static let bounds = (minLat: 37.7298, minLon: -122.1993, maxLat: 37.7326, maxLon: -122.1957)

    static let package: [UInt8] = build()
    static let sha256 = SHA256.hex(Data(package))

    static func descriptor(_ submissionId: Int) -> [String: Any] {
        ["submission_id": submissionId, "available": true, "reason": NSNull(), "content_signature": "demo-terrain-1",
         "area": ["center": ["lat": site.lat, "lon": site.lon], "radius_m": 150,
                  "bounds": ["min_lat": bounds.minLat, "min_lon": bounds.minLon, "max_lat": bounds.maxLat, "max_lon": bounds.maxLon]],
         "package": ["format": "eristerrain", "version": "2", "size_bytes": package.count, "sha256": sha256,
                     "elevation_source": "USGS_3DEP",
                     "elevation": ["dataset": "USGS 3DEP", "version": "1/3 arc-second", "resolution": "10 m"]]]
    }

    static func grant(_ submissionId: Int) -> [String: Any] {
        ["submission_id": submissionId, "url": "data:application/zip;base64,\(Data(package).base64EncodedString())",
         "expires_in_seconds": 300, "object_key": "demo/\(submissionId).eristerrain", "sha256": sha256,
         "size_bytes": package.count, "package_version": "2", "package_format": "eristerrain",
         "content_signature": "demo-terrain-1"]
    }

    /// Elevation in meters at a grid cell: the hillside rises to the north-east,
    /// the road bench cuts across it and a creek runs below.
    private static func elevation(_ c: Int, _ r: Int) -> Float {
        let x = Double(c) / Double(cols - 1) - 0.5, y = 0.5 - Double(r) / Double(rows - 1)
        let slope = 140 + 55 * (x * 0.6 + y)
        let creek = -14 * exp(-pow((y + 0.28 - 0.15 * x) / 0.06, 2))
        let bench = -4 * exp(-pow((y - 0.05 * x) / 0.03, 2))
        let knoll = 12 * exp(-(pow(x - 0.25, 2) + pow(y - 0.3, 2)) / 0.02)
        return Float(slope + creek + bench + knoll)
    }

    private static func build() -> [UInt8] {
        var heights: [Float] = []
        for r in 0..<rows { for c in 0..<cols { heights.append(elevation(c, r)) } }
        var grid: [UInt8] = []
        for h in heights { withUnsafeBytes(of: h.bitPattern.littleEndian) { grid += $0 } }
        let hillshade = shade(heights)
        let road: [String: Any] = ["type": "FeatureCollection", "features": [[
            "type": "Feature", "properties": ["route": "580"],
            "geometry": ["type": "LineString", "coordinates": [[-122.1993, 37.73104], [-122.1975, 37.7312], [-122.1957, 37.73136]]]]]]
        let roads = [UInt8]((try? JSONSerialization.data(withJSONObject: road)) ?? Data())
        let manifest: [String: Any] = [
            "format": "eristerrain", "format_version": 2,
            "elevation": ["source": "USGS_3DEP", "dataset": "USGS 3DEP", "version": "1/3 arc-second", "resolution": "10 m"],
            "terrain": [
                "file": "elevation-grid.bin", "rows": rows, "columns": cols, "encoding": "float32", "byte_order": "little",
                "no_data_value": -9999, "min_elevation_m": Double(heights.min() ?? 0), "max_elevation_m": Double(heights.max() ?? 0),
                "vertical_units": "meters", "sha256": SHA256.hex(Data(grid)),
                "bounds": ["min_lat": bounds.minLat, "min_lon": bounds.minLon, "max_lat": bounds.maxLat, "max_lon": bounds.maxLon],
                "local_transform": ["origin_lon": bounds.minLon, "origin_lat": bounds.maxLat,
                                    "lon_per_col": (bounds.maxLon - bounds.minLon) / Double(cols - 1),
                                    "lat_per_row": -(bounds.maxLat - bounds.minLat) / Double(rows - 1)]],
            "context_layers": ["roads": ["available": true, "file": "roads.geojson", "bytes": roads.count, "feature_count": 1]]]
        let manifestBytes = [UInt8]((try? JSONSerialization.data(withJSONObject: manifest)) ?? Data())
        var files: [(String, [UInt8])] = [("manifest.json", manifestBytes), ("elevation-grid.bin", grid), ("roads.geojson", roads)]
        if let hillshade { files.append(("hillshade.png", hillshade)) }
        return TerrainBundle.makeStoredZip(files)
    }

    /// A grey hillshade of the grid, lit from the north-west, as a PNG.
    private static func shade(_ heights: [Float]) -> [UInt8]? {
        let cellM: Float = 4
        var pixels = [UInt8](repeating: 0, count: rows * cols)
        for r in 0..<rows {
            for c in 0..<cols {
                func h(_ cc: Int, _ rr: Int) -> Float { heights[min(max(rr, 0), rows - 1) * cols + min(max(cc, 0), cols - 1)] }
                let dx = (h(c + 1, r) - h(c - 1, r)) / (2 * cellM), dy = (h(c, r + 1) - h(c, r - 1)) / (2 * cellM)
                let length = (dx * dx + dy * dy + 1).squareRoot()
                let light = (-dx * -0.5 + -dy * -0.5 + 0.707) / length
                pixels[r * cols + c] = UInt8(max(40, min(255, 70 + light * 200)))
            }
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let image = CGImage(width: cols, height: rows, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: cols,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
                                  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        return UIImage(cgImage: image).pngData().map { [UInt8]($0) }
    }
}
