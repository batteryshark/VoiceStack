import Foundation

/// Releases complete prose segments in order while retaining only the active reply.
public struct SpeechSegments {
    private var pending = ""
    private var emitted = ""
    public init() {}
    public mutating func append(_ delta: String) -> [String] {
        pending += delta; var result: [String] = []
        while let boundary = boundary() {
            let text = String(pending[..<boundary]); pending.removeSubrange(..<boundary); emitted += text
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(text) }
        }
        return result
    }
    private func boundary() -> String.Index? {
        for i in pending.indices {
            let next = pending.index(after: i)
            if pending[i] == "\n" || (".!?".contains(pending[i]) && next < pending.endIndex && pending[next].isWhitespace) { return next }
        }
        if pending.count > 2000 {
            let end = pending.index(pending.startIndex, offsetBy: 2000)
            return pending[..<end].lastIndex(where: { $0.isWhitespace }).map { pending.index(after: $0) } ?? end
        }
        return nil
    }
    public mutating func finish(_ final: String) throws -> [String] {
        guard final.hasPrefix(emitted) else { throw VoiceError.invalidResponse }
        var rest = String(final.dropFirst(emitted.count)); var result: [String] = []
        while !rest.isEmpty { let end = rest.index(rest.startIndex, offsetBy: min(2000, rest.count)); let segment = String(rest[..<end]); rest.removeSubrange(..<end); if !segment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(segment) } }
        pending = ""; emitted = ""; return result
    }
}
