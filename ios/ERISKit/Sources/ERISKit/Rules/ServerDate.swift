import Foundation

/// Timestamps as the ERIS API sends them. MySQL `DATETIME` columns carry no
/// zone and the database runs in America/Los_Angeles (deploy `TZ`), so a value
/// without an offset is Pacific time; one with `Z` or an offset is exact. The
/// Expo app's `new Date(text)` gets the same instant on a California phone.
public enum ServerDate {
    public static let serverTimeZone = TimeZone(identifier: "America/Los_Angeles")!

    /// "2026-10-27T15:00:00", "2026-10-27 15:00:00.123456", "…Z", "…+00:00",
    /// or a date alone ("2026-10-27", midnight Pacific). Nil if unreadable.
    public static func parse(_ text: String?) -> Date? {
        guard let text = text?.trimmingCharacters(in: .whitespaces), text.count >= 10 else { return nil }
        let chars = Array(text)
        func number(_ range: Range<Int>) -> Int? {
            guard range.upperBound <= chars.count else { return nil }
            return Int(String(chars[range]))
        }
        guard let year = number(0..<4), chars[4] == "-", let month = number(5..<7), chars[7] == "-",
              let day = number(8..<10) else { return nil }
        var parts = DateComponents(year: year, month: month, day: day, hour: 0, minute: 0, second: 0)
        var zone = serverTimeZone
        var index = 10
        if index < chars.count {
            guard chars[index] == "T" || chars[index] == " ", let hour = number(11..<13), chars.count > 13,
                  chars[13] == ":", let minute = number(14..<16) else { return nil }
            parts.hour = hour
            parts.minute = minute
            index = 16
            if index < chars.count, chars[index] == ":" {
                guard let second = number(17..<19) else { return nil }
                parts.second = second
                index = 19
            }
            if index < chars.count, chars[index] == "." {
                index += 1
                var digits = ""
                while index < chars.count, chars[index].isNumber { digits.append(chars[index]); index += 1 }
                let fraction = Double("0." + digits) ?? 0
                parts.nanosecond = Int((fraction * 1_000_000_000).rounded())
            }
            if index < chars.count {
                let rest = String(chars[index...])
                if rest == "Z" || rest == "z" {
                    zone = TimeZone(secondsFromGMT: 0)!
                } else if let sign = rest.first, sign == "+" || sign == "-" {
                    let digits = rest.dropFirst().filter(\.isNumber)
                    guard digits.count == 4, let hours = Int(digits.prefix(2)), let minutes = Int(digits.suffix(2))
                    else { return nil }
                    let seconds = (hours * 3600 + minutes * 60) * (sign == "-" ? -1 : 1)
                    guard let offset = TimeZone(secondsFromGMT: seconds) else { return nil }
                    zone = offset
                } else {
                    return nil
                }
            }
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        // Calendar rolls "2026-13-01" or "02-30" over; refuse instead.
        guard (1...12).contains(month), let date = calendar.date(from: parts),
              calendar.dateComponents([.year, .month, .day], from: date) == DateComponents(year: year, month: month, day: day)
        else { return nil }
        return date
    }

    /// The timestamp in the reader's locale and time zone, or the text as sent
    /// when it cannot be read.
    public static func display(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        guard let date = parse(text) else { return text }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
