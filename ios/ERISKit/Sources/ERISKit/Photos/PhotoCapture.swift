import Foundation

/// Where and which way a field photo was taken, as the server stores it
/// (`capture_metadata_json` on upload). Ported from
/// mobile/src/photos/captureMetadata.ts.
public struct PhotoCaptureMetadata: Codable, Equatable, Sendable {
    public struct Provenance: Codable, Equatable, Sendable {
        public var assetId: String?
        public var exifTagsPresent: [String]?

        enum CodingKeys: String, CodingKey {
            case assetId = "asset_id", exifTagsPresent = "exif_tags_present"
        }
    }

    public var capturedAt: String?
    public var latitude: Double?
    public var longitude: Double?
    public var horizontalAccuracyM: Double?
    public var altitudeM: Double?
    public var cameraHeadingDeg: Double?
    /// 0 (uncalibrated) to 3 (high), from the compass calibration.
    public var cameraHeadingAccuracyCode: Int?
    /// TRUE_NORTH, MAGNETIC_NORTH or UNKNOWN.
    public var headingReference: String?
    /// DEVICE_AT_CAPTURE, EXIF_GPS, MANUAL or UNKNOWN.
    public var locationSource: String?
    /// DEVICE_TRUE_HEADING, DEVICE_MAGNETIC_HEADING, EXIF_GPS_IMG_DIRECTION, MANUAL or UNKNOWN.
    public var headingSource: String?
    public var provenance: Provenance?

    enum CodingKeys: String, CodingKey {
        case capturedAt = "captured_at", latitude, longitude, horizontalAccuracyM = "horizontal_accuracy_m"
        case altitudeM = "altitude_m", cameraHeadingDeg = "camera_heading_deg"
        case cameraHeadingAccuracyCode = "camera_heading_accuracy_code", headingReference = "heading_reference"
        case locationSource = "location_source", headingSource = "heading_source", provenance
    }

    public init(capturedAt: String? = nil, latitude: Double? = nil, longitude: Double? = nil,
                horizontalAccuracyM: Double? = nil, altitudeM: Double? = nil, cameraHeadingDeg: Double? = nil,
                cameraHeadingAccuracyCode: Int? = nil, headingReference: String? = nil, locationSource: String? = nil,
                headingSource: String? = nil, provenance: Provenance? = nil) {
        self.capturedAt = capturedAt
        self.latitude = latitude
        self.longitude = longitude
        self.horizontalAccuracyM = horizontalAccuracyM
        self.altitudeM = altitudeM
        self.cameraHeadingDeg = cameraHeadingDeg
        self.cameraHeadingAccuracyCode = cameraHeadingAccuracyCode
        self.headingReference = headingReference
        self.locationSource = locationSource
        self.headingSource = headingSource
        self.provenance = provenance
    }
}

/// One location fix, with when it arrived (milliseconds).
public struct PositionSample: Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    /// Horizontal accuracy in metres; nil or negative when unknown.
    public let accuracy: Double?
    public let altitude: Double?
    public let observedAtMs: Double

    public init(latitude: Double, longitude: Double, accuracy: Double?, altitude: Double?, observedAtMs: Double) {
        self.latitude = latitude
        self.longitude = longitude
        self.accuracy = accuracy
        self.altitude = altitude
        self.observedAtMs = observedAtMs
    }
}

/// The rear camera's direction from one Core Motion sample.
public struct CameraDirectionSample: Equatable, Sendable {
    /// Degrees clockwise from true north, 0 ≤ heading < 360.
    public let heading: Double
    public let accuracyCode: Int
    public let sampleAgeMs: Double
    public let elevationDeg: Double
    public let horizontalProjection: Double
}

public enum PhotoCapture {
    /// A fix worse than this is still recorded, but labelled weak.
    public static let maxMappedAccuracyM = 20.0
    /// Below "medium" compass calibration, the direction is not recorded.
    public static let minHeadingAccuracyCode = 2
    static let positionWindowMs = 3000.0
    static let positionHistoryMs = 5000.0

    // MARK: Camera direction (ErisCameraDirectionModule.m)

    /// The rear camera's compass direction from Core Motion's attitude in the
    /// true-north frame (`xTrueNorthZVertical`: +X north, +Y west, +Z up).
    /// `m31…m33` are the attitude rotation matrix's third row: the device Z axis
    /// in that frame. The rear camera looks along −Z. Nil (with why) when the
    /// sample is older than half a second or the camera points nearly straight
    /// up or down, where a compass direction means nothing.
    public static func cameraDirection(m31: Double, m32: Double, m33: Double, ageSeconds: Double,
                                       accuracyCode: Int) -> Result<CameraDirectionSample, DirectionProblem> {
        guard ageSeconds.isFinite, ageSeconds >= 0, ageSeconds <= 0.5 else { return .failure(.stale) }
        let north = -m31, west = -m32, up = -m33
        let east = -west
        let horizontal = (north * north + east * east).squareRoot()
        guard horizontal.isFinite, horizontal >= 0.15 else { return .failure(.nearVertical) }
        var heading = atan2(east, north) * 180 / .pi
        if heading < 0 { heading += 360 }
        if heading >= 360 { heading = heading.truncatingRemainder(dividingBy: 360) }
        let elevation = asin(max(-1, min(1, up))) * 180 / .pi
        return .success(CameraDirectionSample(heading: heading, accuracyCode: accuracyCode,
                                              sampleAgeMs: ageSeconds * 1000, elevationDeg: elevation,
                                              horizontalProjection: horizontal))
    }

    public enum DirectionProblem: Error, Equatable, Sendable {
        case stale, nearVertical
    }

    /// A direction good enough to record: medium calibration or better, from a
    /// sample at most 500 ms old.
    public static func recordable(_ sample: CameraDirectionSample?) -> CameraDirectionSample? {
        guard let sample, sample.heading.isFinite, sample.heading >= 0, sample.heading < 360,
              sample.accuracyCode >= minHeadingAccuracyCode, sample.sampleAgeMs <= 500 else { return nil }
        return sample
    }

    // MARK: Position

    /// The most accurate fix within 3 s of the shutter, the newest on a tie.
    public static func bestPosition(_ samples: [PositionSample], atMs shutter: Double) -> PositionSample? {
        func accuracy(_ sample: PositionSample) -> Double {
            guard let value = sample.accuracy, value.isFinite, value >= 0 else { return .infinity }
            return value
        }
        return samples.filter { abs(shutter - $0.observedAtMs) <= positionWindowMs }
            .sorted { accuracy($0) != accuracy($1) ? accuracy($0) < accuracy($1) : $0.observedAtMs > $1.observedAtMs }
            .first
    }

    /// Keeps the last 5 s of fixes, at most 20.
    public static func recording(_ sample: PositionSample, into samples: [PositionSample]) -> [PositionSample] {
        Array((samples.filter { sample.observedAtMs - $0.observedAtMs <= positionHistoryMs } + [sample]).suffix(20))
    }

    // MARK: Camera status lines

    public static func locationLabel(_ best: PositionSample?) -> String {
        guard let best else { return "GPS acquiring…" }
        guard let accuracy = best.accuracy, accuracy.isFinite else { return "GPS fix acquired • accuracy unknown" }
        let metres = Int((accuracy + 0.5).rounded(.down))
        return accuracy <= maxMappedAccuracyM ? "GPS best recent ±\(metres) m"
                                              : "GPS weak ±\(metres) m • mapped with uncertainty"
    }

    public static func directionLabel(_ sample: CameraDirectionSample?) -> String {
        guard let sample else { return "Camera direction calibrating… move phone in a figure eight" }
        let degrees = Int((sample.heading + 0.5).rounded(.down))
        if sample.accuracyCode >= 3 { return "Rear camera \(degrees)° true • high calibration" }
        if sample.accuracyCode >= minHeadingAccuracyCode { return "Rear camera \(degrees)° true • medium calibration" }
        return "Rear camera \(degrees)° • calibration weak"
    }

    // MARK: Metadata

    /// Headings normalised to 0 ≤ h < 360.
    public static func normalizedHeading(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return (value.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    }

    /// What the phone measured at the shutter, or nil when it has neither a
    /// position nor a recordable direction.
    public static func metadata(capturedAt: String, position: PositionSample?,
                                direction: CameraDirectionSample?) -> PhotoCaptureMetadata? {
        let measured = position.flatMap { p in
            p.latitude.isFinite && p.longitude.isFinite && (-90...90).contains(p.latitude)
                && (-180...180).contains(p.longitude) ? p : nil
        }
        let heading = recordableHeading(direction)
        guard measured != nil || heading != nil else { return nil }
        let accuracy = measured?.accuracy.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        return PhotoCaptureMetadata(
            capturedAt: capturedAt, latitude: measured?.latitude, longitude: measured?.longitude,
            horizontalAccuracyM: accuracy, altitudeM: measured?.altitude, cameraHeadingDeg: heading,
            cameraHeadingAccuracyCode: heading != nil ? direction.map { max(0, min(3, $0.accuracyCode)) } : nil,
            headingReference: heading != nil ? "TRUE_NORTH" : nil,
            locationSource: measured != nil ? "DEVICE_AT_CAPTURE" : nil,
            headingSource: heading != nil ? "DEVICE_TRUE_HEADING" : nil)
    }

    /// `photoCaptureMetadataFromDeviceSnapshot` takes the direction only at
    /// medium calibration or better and true north (the frame guarantees it).
    static func recordableHeading(_ direction: CameraDirectionSample?) -> Double? {
        guard let direction, direction.accuracyCode >= minHeadingAccuracyCode else { return nil }
        return normalizedHeading(direction.heading)
    }

    /// Location, direction and time from a photo's EXIF (flattened keys as the
    /// Expo camera reports them: GPSLatitude, GPSLatitudeRef, GPSImgDirection,
    /// DateTimeOriginal…). Nil when the EXIF says nothing useful.
    public static func metadata(exif: [String: JSONValue]?, assetId: String?) -> PhotoCaptureMetadata? {
        guard let exif else { return nil }
        let latitude = coordinate(exif["GPSLatitude"], ref: exif["GPSLatitudeRef"])
        let longitude = coordinate(exif["GPSLongitude"], ref: exif["GPSLongitudeRef"])
        let rawAccuracy = number(exif["GPSHPositioningError"])
        let validLocation = latitude.map { (-90...90).contains($0) } == true
            && longitude.map { (-180...180).contains($0) } == true
        let heading = normalizedHeading(number(exif["GPSImgDirection"]))
        let tags = ["GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef", "GPSHPositioningError",
                    "GPSAltitude", "GPSImgDirection", "GPSImgDirectionRef", "DateTimeOriginal"]
            .filter { exif[$0] != nil && exif[$0] != .null }
        let out = PhotoCaptureMetadata(
            capturedAt: exifDate(exif["DateTimeOriginal"] ?? exif["DateTime"]),
            latitude: validLocation ? latitude : nil, longitude: validLocation ? longitude : nil,
            // Unknown or weak accuracy is evidence about uncertainty, not a reason
            // to erase an otherwise valid measured coordinate.
            horizontalAccuracyM: validLocation ? rawAccuracy.flatMap { $0 >= 0 ? $0 : nil } : nil,
            altitudeM: validLocation ? number(exif["GPSAltitude"]) : nil,
            cameraHeadingDeg: heading, cameraHeadingAccuracyCode: nil,
            headingReference: heading != nil ? (headingReference(exif["GPSImgDirectionRef"]) ?? "UNKNOWN") : nil,
            locationSource: validLocation ? "EXIF_GPS" : nil,
            headingSource: heading != nil ? "EXIF_GPS_IMG_DIRECTION" : nil,
            provenance: .init(assetId: assetId, exifTagsPresent: tags))
        return out.capturedAt != nil || out.latitude != nil || out.cameraHeadingDeg != nil || !tags.isEmpty ? out : nil
    }

    /// The device's measurement first, the EXIF's for anything it lacks; the
    /// EXIF's provenance when it has one.
    public static func merge(_ primary: PhotoCaptureMetadata?, _ fallback: PhotoCaptureMetadata?) -> PhotoCaptureMetadata? {
        guard let primary else { return fallback }
        guard let fallback else { return primary }
        return PhotoCaptureMetadata(
            capturedAt: primary.capturedAt ?? fallback.capturedAt, latitude: primary.latitude ?? fallback.latitude,
            longitude: primary.longitude ?? fallback.longitude,
            horizontalAccuracyM: primary.horizontalAccuracyM ?? fallback.horizontalAccuracyM,
            altitudeM: primary.altitudeM ?? fallback.altitudeM,
            cameraHeadingDeg: primary.cameraHeadingDeg ?? fallback.cameraHeadingDeg,
            cameraHeadingAccuracyCode: primary.cameraHeadingAccuracyCode ?? fallback.cameraHeadingAccuracyCode,
            headingReference: primary.headingReference ?? fallback.headingReference,
            locationSource: primary.locationSource ?? fallback.locationSource,
            headingSource: primary.headingSource ?? fallback.headingSource,
            provenance: fallback.provenance ?? primary.provenance)
    }

    static func number(_ value: JSONValue?) -> Double? {
        switch value {
        case .number(let number)?: return number.isFinite ? number : nil
        case .string(let text)?: return JS.number(text).flatMap { $0.isFinite ? $0 : nil }
        case .bool(let flag)?: return flag ? 1 : 0
        default: return nil
        }
    }

    /// A signed decimal coordinate, or degrees/minutes/seconds, with N/S/E/W.
    static func coordinate(_ value: JSONValue?, ref: JSONValue?) -> Double? {
        let reference = JS.string(ref).trimmingCharacters(in: .whitespaces).uppercased()
        if let direct = number(value) {
            if ["S", "W"].contains(reference) { return -abs(direct) }
            if ["N", "E"].contains(reference) { return abs(direct) }
            // iOS often reports an already-signed decimal without a reference.
            return direct
        }
        guard case .array(let parts)? = value, parts.count >= 3, let d = number(parts[0]), let m = number(parts[1]),
              let s = number(parts[2]) else { return nil }
        let magnitude = abs(d) + abs(m) / 60 + abs(s) / 3600
        if ["S", "W"].contains(reference) { return -magnitude }
        if ["N", "E"].contains(reference) { return magnitude }
        return d < 0 ? -magnitude : magnitude
    }

    /// "2026:10:28 09:15:00" -> "2026-10-28T09:15:00".
    static func exifDate(_ value: JSONValue?) -> String? {
        guard case .string(let raw)? = value else { return nil }
        let text = raw.trimmingCharacters(in: .whitespaces)
        let chars = Array(text)
        guard chars.count >= 19 else { return nil }
        let digitsAt = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
        guard digitsAt.allSatisfy({ chars[$0].isASCII && chars[$0].isNumber }), chars[4] == ":", chars[7] == ":",
              chars[10] == " " || chars[10] == "T", chars[13] == ":", chars[16] == ":" else { return nil }
        let s = String(chars[0..<19])
        return "\(s.prefix(4))-\(s.dropFirst(5).prefix(2))-\(s.dropFirst(8).prefix(2))T\(s.dropFirst(11))"
    }

    static func headingReference(_ value: JSONValue?) -> String? {
        guard let value, value != .null else { return nil }
        let text = JS.string(value).trimmingCharacters(in: .whitespaces).uppercased()
        if text.isEmpty { return nil }
        if ["T", "TRUE", "TRUE_NORTH"].contains(text) { return "TRUE_NORTH" }
        if ["M", "MAGNETIC", "MAGNETIC_NORTH"].contains(text) { return "MAGNETIC_NORTH" }
        return "UNKNOWN"
    }

    /// "N", "NE", "E"…: a heading as a compass point.
    public static func compassPoint(_ heading: Double) -> String {
        let points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        let normalized = normalizedHeading(heading) ?? 0
        return points[Int((normalized / 45 + 0.5).rounded(.down)) % 8]
    }
}
