import Foundation

/// All asynchronous work carries this generation. A callback from an old call has no authority.
public struct CallState {
    public private(set) var generation = UUID()
    public private(set) var call: Call?
    public private(set) var backend: Backend?
    public private(set) var explicitlyAccepted = false
    public private(set) var textReady = false
    public private(set) var speechReady = false
    public private(set) var audioActive = false
    public private(set) var userCaption = ""
    public private(set) var replyCaption = ""
    public private(set) var pendingTurn: TurnSubmission?
    public private(set) var effectiveDelivery: Delivery = .steer
    public var requestedDelivery: Delivery = .steer
    private var submittedItems = Set<String>()
    private var committed = false
    private var previewItem: String?
    private var responseId: String?
    private var sequence = 0
    public init() {}
    public var awaitingTranscript: Bool { committed }
    public var canCapture: Bool { call != nil && explicitlyAccepted && textReady && speechReady && audioActive && !committed && pendingTurn == nil }
    public mutating func ring(_ incoming: Call) throws {
        guard call == nil, incoming.state == "ringing" else { throw VoiceError.invalidState }
        generation = UUID(); call = incoming
    }
    /// Retain a successfully admitted call so it can be ended even if media attachment fails.
    public mutating func hold(_ admitted: Call) { reset(); call = admitted }
    public mutating func own(_ envelope: CallEnvelope, deviceId: String, explicit: Bool) throws {
        guard explicit, let backend = envelope.backend, let binding = envelope.call.targetBinding, !binding.isEmpty,
              envelope.call.ownerDeviceId == nil || envelope.call.ownerDeviceId == deviceId else { throw VoiceError.staleCall }
        try backend.validate()
        guard let channel = envelope.call.textChannel else { throw VoiceError.invalidResponse }; try SecureAddress.validate(channel, scheme: "wss")
        reset(); call = envelope.call; self.backend = backend; explicitlyAccepted = true
    }
    public mutating func readyText(callId: String, binding: String, generation: UUID) throws {
        try check(generation); guard call?.id == callId, call?.targetBinding == binding else { throw VoiceError.staleCall }; textReady = true
    }
    public mutating func readySpeech(generation: UUID) throws { try check(generation); speechReady = true }
    /// Rotate only the speech transport. The text channel, pinned binding, captions,
    /// and uncertain turn retain their identity across a credential renewal.
    public mutating func renewSpeech(_ fresh: Backend, generation: UUID) throws {
        try check(generation)
        guard explicitlyAccepted, !committed else { throw VoiceError.invalidState }
        try fresh.validate(); backend = fresh; speechReady = false
    }
    public mutating func activateAudio(_ active: Bool, generation: UUID) throws { try check(generation); audioActive = active }
    public mutating func beginUserTurn(generation: UUID) throws { try check(generation); guard canCapture else { throw VoiceError.invalidState }; userCaption = ""; previewItem = nil }
    /// Display-only text. Only a committed final transcript can become a turn.
    public mutating func preview(itemId: String, delta: String, generation: UUID) throws {
        try check(generation)
        guard (canCapture || committed), !submittedItems.contains(itemId),
              previewItem == nil || previewItem == itemId, userCaption.count + delta.count <= 16000 else { return }
        previewItem = itemId; userCaption += delta
    }
    public mutating func previewSnapshot(itemId: String, text: String, generation: UUID) throws {
        try check(generation)
        guard (canCapture || committed), !submittedItems.contains(itemId),
              previewItem == nil || previewItem == itemId, text.count <= 16000 else { return }
        previewItem = itemId; userCaption = text
    }
    /// Recognition commit is not delivery. Discard remains valid until a text
    /// submission is issued; the caller must retire the old speech transport.
    public mutating func discardUnsubmitted(generation: UUID) throws {
        try check(generation)
        guard pendingTurn == nil, canCapture || committed else { throw VoiceError.invalidState }
        committed = false; userCaption = ""; previewItem = nil; speechReady = false
    }
    public mutating func commit(generation: UUID) throws { try check(generation); guard canCapture else { throw VoiceError.invalidState }; committed = true }
    public mutating func transcript(itemId: String, text: String, generation: UUID) throws -> TurnSubmission? {
        try check(generation)
        if submittedItems.contains(itemId) { return nil }
        guard committed else { throw VoiceError.invalidState }
        committed = false; submittedItems.insert(itemId); userCaption = text
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let turn = TurnSubmission(text: text, delivery: requestedDelivery); pendingTurn = turn; return turn
    }
    public mutating func accepted(operationId: UUID, delivery: Delivery, binding: String, generation: UUID) throws {
        try check(generation); guard pendingTurn?.operationId == operationId, call?.targetBinding == binding else { throw VoiceError.staleCall }
        effectiveDelivery = delivery; pendingTurn = nil
    }
    @discardableResult public mutating func reply(response: String, sequence next: Int, delta: String, generation: UUID) throws -> Bool {
        try check(generation)
        if responseId != response { responseId = response; sequence = 0; replyCaption = "" }
        if next <= sequence { return false }
        guard next == sequence + 1 else { throw VoiceError.invalidResponse }
        sequence = next; replyCaption += delta; return true
    }
    public mutating func finishReply(response: String, text: String, generation: UUID) throws {
        try check(generation); if responseId != response { responseId = response; sequence = 0 }; replyCaption = text
    }
    public func check(_ candidate: UUID) throws { guard candidate == generation, call != nil else { throw VoiceError.staleCall } }
    public mutating func reset() { self = CallState() }
}

public struct Mutation: Codable, Equatable {
    public let operationId: UUID
    public let method: String
    public let path: String
    public let body: Data
    public init(method: String, path: String, fields: [String: Any], operationId: UUID = UUID()) throws {
        self.operationId = operationId; self.method = method; self.path = path
        var fields = fields; fields["operation_id"] = operationId.uuidString.lowercased(); body = try Wire.data(fields)
    }
}
