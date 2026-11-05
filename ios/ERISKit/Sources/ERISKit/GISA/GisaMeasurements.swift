import Foundation

/// The form's eight measurements, grouped as the reference sketch groups them.
public struct MeasurementField: Equatable, Identifiable, Sendable {
    public enum Unit: String, Sendable { case feet = "ft", degrees = "°" }
    /// Where a suggestion can come from: the ground (terrain model or drone survey),
    /// a drone survey only, for someone to review, or nowhere: it is measured on site.
    public enum Source: Sendable { case ground, scarp, site }

    public let key: String
    public let symbol: String
    public let subscriptText: String
    public let name: String
    public let unit: Unit
    public let source: Source
    public var id: String { key }

    /// "Wd Width": the symbol as the sketch writes it, for reading aloud and for tests.
    public var label: String { "\(symbol)\(subscriptText) \(name)" }
}

public struct MeasurementGroup: Equatable, Identifiable, Sendable {
    public let title: String
    public let fields: [MeasurementField]
    public var id: String { title }
}

extension GisaEditor {
    public static let measurementGroups: [MeasurementGroup] = [
        MeasurementGroup(title: "Slope", fields: [
            MeasurementField(key: "measure_slope_height_ft", symbol: "H", subscriptText: "", name: "Slope height", unit: .feet, source: .ground),
            MeasurementField(key: "measure_original_slope_deg", symbol: "α", subscriptText: "", name: "Original slope", unit: .degrees, source: .ground),
        ]),
        MeasurementGroup(title: "Landslide", fields: [
            MeasurementField(key: "measure_landslide_width_ft", symbol: "W", subscriptText: "d", name: "Width", unit: .feet, source: .ground),
            MeasurementField(key: "measure_landslide_length_ft", symbol: "L", subscriptText: "d", name: "Length", unit: .feet, source: .ground),
            MeasurementField(key: "measure_landslide_slope_deg", symbol: "β", subscriptText: "", name: "Slope", unit: .degrees, source: .ground),
            MeasurementField(key: "measure_main_scarp_height_ft", symbol: "H", subscriptText: "s", name: "Main scarp height", unit: .feet, source: .scarp),
        ]),
        MeasurementGroup(title: "Roadway encroached", fields: [
            MeasurementField(key: "measure_roadway_length_ft", symbol: "L", subscriptText: "r", name: "Length", unit: .feet, source: .site),
            MeasurementField(key: "measure_roadway_width_ft", symbol: "W", subscriptText: "r", name: "Width", unit: .feet, source: .site),
        ]),
    ]

    public static var measurementFields: [MeasurementField] { measurementGroups.flatMap(\.fields) }

    /// The field after this one, for moving through them with the keyboard up.
    public static func measurementField(after key: String) -> String? {
        let keys = measurementFields.map(\.key)
        guard let index = keys.firstIndex(of: key), index + 1 < keys.count else { return nil }
        return keys[index + 1]
    }

    /// What the field's value means to a slider: nothing when it is empty or not a number.
    public static func measurementAngle(_ text: String) -> Double? {
        guard let value = Double(text.trimmingCharacters(in: .whitespaces)) else { return nil }
        return min(90, max(0, value))
    }

    /// How a slider's position goes on the form: "27.5", and "28" rather than "28.0".
    public static func measurementAngleText(_ degrees: Double) -> String {
        let half = (degrees * 2).rounded() / 2
        return half == half.rounded() ? String(Int(half)) : String(format: "%.1f", half)
    }
}
