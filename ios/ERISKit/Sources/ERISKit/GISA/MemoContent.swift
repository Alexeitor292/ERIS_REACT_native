import Foundation

/// The form's formatted memos, ported from the web app's memoContentModel.ts
/// and memoFigureModel.ts. Each is stored twice (backend services/rich_text.py):
/// `<key>_html`, the document, and `<key>`, a plain-text mirror the server
/// derives from it. The iPhone edits the document, as the web app does.
public enum MemoContent {
    /// The four memos edited as documents, in the order their figures are numbered.
    public static let keys = ["observations_notes", "geotechnical_assessment_notes", "recommendations_notes", "sketchpad_notes"]

    public static func label(_ key: String) -> String {
        switch key {
        case "observations_notes": return "Observations"
        case "geotechnical_assessment_notes": return "Geotechnical assessment"
        case "recommendations_notes": return "Recommendations"
        case "sketchpad_notes": return "Sketch notes"
        default: return Presence.fieldLabel(key)
        }
    }

    /// What each memo is for, as the web form says it.
    public static func purpose(_ key: String) -> String {
        switch key {
        case "observations_notes": return "What you saw at the site: conditions, extent, anything unusual."
        case "geotechnical_assessment_notes":
            return "Your judgement of the failure, its cause and the risk. Required before the form can be submitted."
        case "recommendations_notes": return "What should be done, by whom, and how urgently."
        case "sketchpad_notes": return "Notes that go with the site sketch."
        default: return ""
        }
    }

    /// The photo section a memo's pictures are filed under (the web's NOTES_SECTION_KEYS).
    public static func photoSection(_ key: String) -> String {
        switch key {
        case "observations_notes": return "observation"
        case "geotechnical_assessment_notes": return "geotechnical_assessment"
        case "recommendations_notes": return "recommendations"
        default: return "sketchpad"
        }
    }

    /// A memo's opening words for a list row: blocks and line breaks become spaces.
    public static func preview(_ html: String, limit: Int = 140) -> String {
        let spaced = html.replacingOccurrences(of: #"<(br|/p|/li|/h\d|/td|/th|/figcaption)\b[^>]*>"#, with: " ",
                                               options: [.regularExpression, .caseInsensitive])
        let words = text(ofHTML: spaced).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return words.count > limit ? String(words.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…" : words
    }

    /// Plain text as a document: blank lines split paragraphs, single newlines stay line breaks.
    public static func html(fromPlain text: String?) -> String {
        let source = (text ?? "").replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty else { return "" }
        func escape(_ line: Substring) -> String {
            line.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
        }
        return source.components(separatedBy: try! NSRegularExpression(pattern: "\n{2,}")).map { paragraph in
            "<p>" + paragraph.split(separator: "\n", omittingEmptySubsequences: false).map(escape).joined(separator: "<br>") + "</p>"
        }.joined()
    }

    /// The words of a memo, ignoring layout: list bullets and numbers,
    /// punctuation, spacing and case. Two versions with the same signature say the same thing.
    public static func signature(_ text: String?) -> String {
        let lines = (text ?? "").components(separatedBy: "\n").map {
            $0.replacingOccurrences(of: #"^\s*(?:[•\-*]|\d+\.)\s+"#, with: "", options: .regularExpression)
        }
        return lines.joined(separator: " ").lowercased().unicodeScalars
            .filter { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) }
            .map(String.init).joined()
    }

    /// The text of a document, as a browser's `textContent` gives it (enough to compare signatures).
    public static func text(ofHTML html: String) -> String {
        let stripped = html.replacingOccurrences(of: #"<[^>]*>"#, with: "", options: .regularExpression)
        var out = stripped
        for (entity, character) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", " "), ("&amp;", "&")] {
            out = out.replacingOccurrences(of: entity, with: character)
        }
        return out
    }

    /// What the editor opens with. The document wins while it still says what
    /// the plain mirror says; if the mirror was edited elsewhere since (the old
    /// mobile app edited plain text), start from the mirror instead.
    public static func choose(html: String?, plain: String?) -> String {
        if let html, !html.isEmpty, signature(text(ofHTML: html)) == signature(plain) { return html }
        if let plain, !plain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return Self.html(fromPlain: plain) }
        return html ?? ""
    }
}

private extension String {
    func components(separatedBy regex: NSRegularExpression) -> [String] {
        var parts: [String] = []
        var start = startIndex
        for match in regex.matches(in: self, range: NSRange(startIndex..., in: self)) {
            guard let range = Range(match.range, in: self) else { continue }
            parts.append(String(self[start..<range.lowerBound]))
            start = range.upperBound
        }
        parts.append(String(self[start...]))
        return parts
    }
}
