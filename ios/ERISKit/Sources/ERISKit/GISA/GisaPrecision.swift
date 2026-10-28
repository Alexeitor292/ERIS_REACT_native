import Foundation

/// JavaScript's `Number(text)` and `String(value)`, which the Expo GISA editor
/// relies on throughout. Kept exact so a form loads and saves the same values.
enum JS {
    /// `Number(text)`, or nil where JavaScript gives NaN. Empty text is nil here;
    /// callers decide what an empty field means.
    static func number(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = Double(trimmed), !value.isNaN else { return nil }
        // Swift also reads "inf" and "nan"; JavaScript reads only "Infinity".
        if value.isInfinite && !["Infinity", "+Infinity", "-Infinity"].contains(trimmed) { return nil }
        return value
    }

    /// `String(value)` for a JSON scalar; "" for null.
    static func string(_ value: JSONValue?) -> String {
        switch value {
        case .none, .null?: return ""
        case .string(let text)?: return text
        case .bool(let flag)?: return flag ? "true" : "false"
        case .number(let number)?: return numberText(number)
        case .array(let items)?: return items.map { string($0) }.joined(separator: ",")
        case .object?: return "[object Object]"
        }
    }

    /// 12 -> "12", 12.5 -> "12.5", as JavaScript prints numbers.
    static func numberText(_ number: Double) -> String {
        if number.rounded() == number && abs(number) < 1e15 { return String(Int(number)) }
        return "\(number)"
    }

    /// `Math.round(value * 10^decimals) / 10^decimals` (half rounds up, as Math.round does).
    static func round(_ value: Double, decimals: Int) -> Double {
        let factor = pow(10, Double(decimals))
        return ((value * factor + 0.5).rounded(.down) / factor) + 0.0
    }
}

/// Post mile, route and coordinate rules. Ported from mobile/src/utils/precision.ts.
public enum GisaPrecision {
    public static let postMileDecimals = 2
    public static let coordinateDecimals = 6

    /// "12.3" -> "12.30"; text that is not a number is kept as typed.
    public static func postMileValue(_ value: String) -> String? {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        guard let number = JS.number(raw), number.isFinite else { return raw }
        return String(format: "%.2f", JS.round(number, decimals: postMileDecimals))
    }

    public static func postMileInput(_ value: String) -> String { postMileValue(value) ?? "" }

    /// "80" -> "080", "I-5" -> "005"; text with no digits is kept as typed.
    public static func routeValue(_ value: String) -> String? {
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let digits = raw.filter { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty else { return raw }
        let first = String(digits.prefix(3))
        return String(repeating: "0", count: 3 - first.count) + first
    }

    public static func routeInput(_ value: String) -> String { routeValue(value) ?? "" }

    /// A coordinate rounded to six decimals, or nil.
    public static func coordinateValue(_ value: String) -> Double? {
        guard let number = JS.number(value), number.isFinite else { return nil }
        return JS.round(number, decimals: coordinateDecimals)
    }

    /// "37.73" -> "37.730000"; "" when not a number.
    public static func formatCoordinate(_ value: String) -> String {
        coordinateValue(value).map { String(format: "%.6f", $0) } ?? ""
    }
}
