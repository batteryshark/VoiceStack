import Foundation

public struct SpeechVoice: Decodable, Identifiable { public let id: String; public let label: String }
public struct SharedSpeechSettings: Decodable {
    public let backendId: String
    public let backendLabel: String
    public let voice: String
    public let defaultVoice: String
    public let voices: [SpeechVoice]
}

