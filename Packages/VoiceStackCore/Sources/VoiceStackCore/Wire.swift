import Foundation

public enum VoiceProfile {
    public static let app = "voicestack-app/1"
    public static let speech = "voicestack-mode-a-speech/1"
}
public enum Wire {
    public static func date(_ text: String) -> Date? {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: text) { return date }
        parser.formatOptions = [.withInternetDateTime]; return parser.date(from: text)
    }
    public static var decoder: JSONDecoder { let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d }
    public static var encoder: JSONEncoder { let e = JSONEncoder(); e.keyEncodingStrategy = .convertToSnakeCase; e.outputFormatting = [.sortedKeys]; return e }
    public static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw VoiceError.invalidResponse }; return value
    }
    public static func data(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
}
public enum VoiceError: Error, LocalizedError, Equatable {
    case invalidResponse, insecureAddress, unsupportedProfile, staleCall, invalidState, operationConflict, unauthorized, server(String), uncertain
    public var errorDescription: String? {
        switch self {
        case .invalidResponse: return "The service returned an invalid response."
        case .insecureAddress: return "Use an authenticated HTTPS/WSS address on your tailnet."
        case .unsupportedProfile: return "This speech profile is not supported."
        case .staleCall: return "This call is no longer owned by this device."
        case .invalidState: return "The call is not ready for that action."
        case .operationConflict: return "This operation already has a different request."
        case .unauthorized: return "Pairing or call authorization has expired."
        case .server(let code): return "The service refused this action (\(code))."
        case .uncertain: return "The result is uncertain. Retry the same operation to reconcile it."
        }
    }
}
public struct PairResponse: Codable, Equatable {
    public let deviceId: String
    public let deviceCredential: String
    public let pairedAt: String
    public let profile: String
}
public struct CallerToken: Codable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let state: String
    public let createdAt: String?
    public let lastUsedAt: String?
    public let revokedAt: String?
}
public struct TokenCreation: Decodable { public let token: CallerToken; public let secret: String }
public struct TokenList: Decodable { public let tokens: [CallerToken] }
public struct Target: Codable, Identifiable, Equatable {
    public let id: String
    public let label: String
    public let kind: String?
    public let isDefault: Bool?
    public let available: Bool?
}
public struct TargetList: Decodable { public let targets: [Target] }
public struct Call: Codable, Identifiable, Equatable {
    public let id: String
    public let direction: String
    public var state: String
    public let ownerDeviceId: String?
    public let callerName: String?
    public let subject: String?
    public let ringExpiresAt: String?
    public let target: Target?
    public let targetBinding: String?
    public let textChannel: URL?
    public let startedAt: String?
}
public struct Backend: Codable, Equatable {
    public let mode: String
    public let profile: String
    public let transcriptionAddress: URL
    public let speechAddress: URL
    public let credential: String
    public let expiresAt: String
    public func remaining(at date: Date = Date()) -> TimeInterval { Wire.date(expiresAt)?.timeIntervalSince(date) ?? 0 }
    // Reserve time for recognition and transport after the user finishes speaking.
    public func captureSeconds(at date: Date = Date()) -> TimeInterval { max(0, min(89, remaining(at: date) - 20)) }
    public func validate(at date: Date = Date()) throws {
        guard mode == "A", profile == VoiceProfile.speech else { throw VoiceError.unsupportedProfile }
        try SecureAddress.validate(transcriptionAddress, scheme: "wss")
        try SecureAddress.validate(speechAddress, scheme: "https")
        guard let expiry = Wire.date(expiresAt), expiry > date else { throw VoiceError.unauthorized }
    }
}
public struct CallEnvelope: Decodable {
    public let call: Call
    public let backend: Backend?
    public init(call: Call, backend: Backend?) { self.call = call; self.backend = backend }
}
public struct BackendEnvelope: Decodable { public let backend: Backend }
public enum SecureAddress {
    public static func validate(_ url: URL, scheme: String) throws {
        guard url.scheme == scheme, let host = url.host, !host.isEmpty, url.user == nil, url.password == nil, url.fragment == nil else { throw VoiceError.insecureAddress }
        if let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
           query.contains(where: { $0.name != "intent" || $0.value != "transcription" }) { throw VoiceError.insecureAddress }
        // TLS is verified by URLSession. Tailnet reachability and ACLs are deployment prerequisites.
    }
}
public struct TurnSubmission: Encodable, Equatable {
    public let type = "turn.submit"
    public let operationId: UUID
    public let text: String
    public let delivery: Delivery
    public init(text: String, delivery: Delivery, operationId: UUID = UUID()) { self.text = text; self.delivery = delivery; self.operationId = operationId }
}
public enum Delivery: String, Codable, CaseIterable { case queue, steer }
public struct Availability: Equatable {
    public let allowed: Bool
    public let reason: String
    public static func evaluate(enabled: Bool, focused: Bool?, quietStart: Int?, quietEnd: Int?, minute: Int) -> Availability {
        if !enabled { return .init(allowed: false, reason: "calls_disabled") }
        // Unknown Focus status is not evidence that the phone allows calls.
        guard let focused else { return .init(allowed: false, reason: "calls_disabled") }
        if focused == true { return .init(allowed: false, reason: "focus") }
        if let start = quietStart, let end = quietEnd, start != end {
            let quiet = start < end ? (minute >= start && minute < end) : (minute >= start || minute < end)
            if quiet { return .init(allowed: false, reason: "quiet_hours") }
        }
        return .init(allowed: true, reason: "available")
    }
}
