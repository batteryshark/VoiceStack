import XCTest
@testable import VoiceStackCore

final class CoreTests: XCTestCase {
    private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }
    private func fixture(_ name: String) throws -> Data { try Data(contentsOf: root.appendingPathComponent("Fixtures/Switchboard-v1/\(name).json")) }
    private func envelope() throws -> CallEnvelope {
        var object = try Wire.object(fixture("accept")); var backend = object["backend"] as! [String: Any]
        backend["expires_at"] = "2099-01-01T00:00:00Z"; object["backend"] = backend
        return try Wire.decoder.decode(CallEnvelope.self, from: Wire.data(object))
    }
    func testFrozenFixturesDecodeAndIgnoreUnknownResponseFields() throws {
        XCTAssertEqual(try Wire.decoder.decode(PairResponse.self, from: fixture("pair")).profile, VoiceProfile.app)
        XCTAssertEqual(try Wire.decoder.decode(TokenCreation.self, from: fixture("caller-token-create")).token.name, "Agent")
        XCTAssertEqual(try Wire.decoder.decode(TokenList.self, from: fixture("caller-token-list")).tokens.count, 1)
        XCTAssertEqual(try Wire.decoder.decode(TargetList.self, from: fixture("targets")).targets.first?.isDefault, true)
        XCTAssertEqual(try envelope().backend?.profile, VoiceProfile.speech)
        let list = String(data: try fixture("caller-token-list"), encoding: .utf8)!
        XCTAssertFalse(list.contains("secret"))
    }
    func testRingAndStaleCallbacksCannotAuthorizeCapture() throws {
        let incoming = try Wire.object(fixture("incoming-call"))["call"] as! [String: Any]
        var state = CallState(); try state.ring(Wire.decoder.decode(Call.self, from: Wire.data(incoming)))
        let old = state.generation; XCTAssertFalse(state.canCapture)
        XCTAssertThrowsError(try state.beginUserTurn(generation: old))
        state.reset(); try state.own(envelope(), deviceId: "dev_fixture_mac", explicit: true)
        XCTAssertThrowsError(try state.activateAudio(true, generation: old))
        XCTAssertFalse(state.canCapture)
    }
    func testThreeTurnsCommitOnlyAfterTranscriptAndQueueFallbackNeverReplays() throws {
        var state = CallState(); try state.own(envelope(), deviceId: "dev_fixture_mac", explicit: true)
        let generation = state.generation
        try state.readyText(callId: "call_fixture_incoming", binding: "binding_fixture_2", generation: generation)
        try state.readySpeech(generation: generation); XCTAssertFalse(state.canCapture)
        try state.activateAudio(true, generation: generation)
        for index in 1...3 {
            XCTAssertTrue(state.canCapture); try state.beginUserTurn(generation: generation); XCTAssertEqual(state.userCaption, "")
            try state.commit(generation: generation); XCTAssertNil(state.pendingTurn)
            let turn = try XCTUnwrap(state.transcript(itemId: "item_\(index)", text: "Synthetic turn \(index)", generation: generation))
            XCTAssertEqual(turn.delivery, .steer); XCTAssertFalse(state.canCapture)
            XCTAssertNil(try state.transcript(itemId: "item_\(index)", text: turn.text, generation: generation))
            try state.accepted(operationId: turn.operationId, delivery: .queue, binding: "binding_fixture_2", generation: generation)
            XCTAssertNil(state.pendingTurn); XCTAssertEqual(state.effectiveDelivery, .queue)
            try state.reply(response: "r_\(index)", sequence: 1, delta: "Reply ", generation: generation)
            XCTAssertEqual(state.replyCaption, "Reply ")
            try state.reply(response: "r_\(index)", sequence: 1, delta: "Duplicate", generation: generation)
            XCTAssertEqual(state.replyCaption, "Reply ")
            try state.finishReply(response: "r_\(index)", text: "Reply complete.", generation: generation)
        }
        state.reset(); XCTAssertEqual(state.userCaption, ""); XCTAssertEqual(state.replyCaption, ""); XCTAssertNil(state.backend)
    }
    func testLiveCaptionDoesNotSubmitAndDiscardCannotCommitOldPreview() throws {
        var state = CallState(); let call = try envelope()
        try state.own(call, deviceId: "dev_fixture_mac", explicit: true)
        let g = state.generation
        try state.readyText(callId: call.call.id, binding: call.call.targetBinding!, generation: g)
        try state.readySpeech(generation: g); try state.activateAudio(true, generation: g)
        try state.beginUserTurn(generation: g)
        try state.preview(itemId: "discarded", delta: "Unsent rambling ", generation: g)
        XCTAssertEqual(state.userCaption, "Unsent rambling "); XCTAssertNil(state.pendingTurn)
        XCTAssertThrowsError(try state.transcript(itemId: "discarded", text: "Never sent", generation: g))
        try state.previewSnapshot(itemId: "discarded", text: "Unsent corrected last word", generation: g)
        XCTAssertEqual(state.userCaption, "Unsent corrected last word")
        try state.commit(generation: g)
        XCTAssertTrue(state.awaitingTranscript)
        try state.discardUnsubmitted(generation: g)
        XCTAssertFalse(state.awaitingTranscript)
        XCTAssertThrowsError(try state.transcript(itemId: "discarded", text: "Late final", generation: g))
        try state.renewSpeech(call.backend!, generation: g)
        try state.preview(itemId: "discarded", delta: "late words", generation: g)
        XCTAssertEqual(state.userCaption, ""); XCTAssertNil(state.pendingTurn)
        try state.readySpeech(generation: g)
        try state.preview(itemId: "fresh", delta: "New thought ", generation: g)
        try state.commit(generation: g)
        let turn = try XCTUnwrap(state.transcript(itemId: "fresh", text: "New thought corrected.", generation: g))
        XCTAssertEqual(turn.text, "New thought corrected.")
        XCTAssertEqual(state.userCaption, turn.text)
        try state.preview(itemId: "fresh", delta: "late duplicate", generation: g)
        XCTAssertEqual(state.userCaption, turn.text)
    }
    func testPinnedBindingAndExplicitOwnershipRequired() throws {
        var state = CallState()
        XCTAssertThrowsError(try state.own(envelope(), deviceId: "dev_fixture_iphone", explicit: true))
        XCTAssertThrowsError(try state.own(envelope(), deviceId: "dev_fixture_mac", explicit: false))
        try state.own(envelope(), deviceId: "dev_fixture_mac", explicit: true)
        XCTAssertThrowsError(try state.readyText(callId: "call_fixture_incoming", binding: "changed_pointer", generation: state.generation))
    }
    func testOperationSurvivesSerializationByteForByte() throws {
        let m = try Mutation(method: "POST", path: "calls", fields: ["direction": "outgoing", "target_id": "target_main"])
        let restored = try Wire.decoder.decode(Mutation.self, from: Wire.encoder.encode(m))
        XCTAssertEqual(m, restored)
        XCTAssertEqual(try Wire.object(restored.body)["operation_id"] as? String, m.operationId.uuidString.lowercased())
    }
    func testSecureAddressesAndAvailabilityAcrossMidnight() throws {
        for bad in ["http://example.invalid", "https://secret@example.invalid", "https://example.invalid?token=secret"] { XCTAssertThrowsError(try SecureAddress.validate(URL(string: bad)!, scheme: "https")) }
        XCTAssertNoThrow(try SecureAddress.validate(URL(string: "wss://voice.fixture.invalid/v1/realtime?intent=transcription")!, scheme: "wss"))
        XCTAssertEqual(Availability.evaluate(enabled: true, focused: true, quietStart: nil, quietEnd: nil, minute: 0).reason, "focus")
        for minute in [0, 500, 1320, 1439] { XCTAssertFalse(Availability.evaluate(enabled: true, focused: false, quietStart: 1320, quietEnd: 540, minute: minute).allowed) }
        XCTAssertTrue(Availability.evaluate(enabled: true, focused: false, quietStart: 1320, quietEnd: 540, minute: 600).allowed)
        XCTAssertEqual(Availability.evaluate(enabled: false, focused: true, quietStart: nil, quietEnd: nil, minute: 0).reason, "calls_disabled")
        XCTAssertFalse(Availability.evaluate(enabled: true, focused: nil, quietStart: nil, quietEnd: nil, minute: 600).allowed)
    }
    func testSpeechSegmentsPreserveOrderAndDoNotRepeatFinalText() throws {
        var segments = SpeechSegments()
        XCTAssertEqual(segments.append("First sent"), [])
        XCTAssertEqual(segments.append("ence. Second"), ["First sentence."])
        XCTAssertEqual(segments.append(" sentence!"), [])
        XCTAssertEqual(try segments.finish("First sentence. Second sentence!"), [" Second sentence!"])
        var changed = SpeechSegments(); _ = changed.append("First. Next")
        XCTAssertThrowsError(try changed.finish("Different final."))
    }
    func testRFC3339FractionalExpiryFromLiveStub() throws {
        XCTAssertNotNil(Wire.date("2099-01-01T00:00:00.123Z"))
        XCTAssertNotNil(Wire.date("2099-01-01T00:00:00Z"))
        var object = try Wire.object(fixture("accept")); var backend = object["backend"] as! [String: Any]
        backend["expires_at"] = "2099-01-01T00:00:00.123Z"; object["backend"] = backend
        let result = try Wire.decoder.decode(CallEnvelope.self, from: Wire.data(object))
        XCTAssertNoThrow(try result.backend?.validate())
    }
    func testSpeechRenewalPreservesPinnedCallAndUncertainTurn() throws {
        let envelope = try envelope(); let backend = try XCTUnwrap(envelope.backend)
        var state = CallState(); try state.own(envelope, deviceId: "dev_fixture_mac", explicit: true)
        let generation = state.generation
        try state.readyText(callId: envelope.call.id, binding: envelope.call.targetBinding!, generation: generation)
        try state.readySpeech(generation: generation); try state.activateAudio(true, generation: generation)
        try state.beginUserTurn(generation: generation); try state.commit(generation: generation)
        XCTAssertThrowsError(try state.renewSpeech(backend, generation: generation))
        let turn = try state.transcript(itemId: "committed", text: "Keep this operation", generation: generation)
        try state.reply(response: "reply", sequence: 1, delta: "Keep this caption", generation: generation)
        try state.renewSpeech(backend, generation: generation)
        XCTAssertEqual(state.generation, generation); XCTAssertEqual(state.call, envelope.call)
        XCTAssertEqual(state.pendingTurn, turn); XCTAssertEqual(state.replyCaption, "Keep this caption")
        XCTAssertTrue(state.textReady); XCTAssertFalse(state.speechReady); XCTAssertFalse(state.canCapture)
        try state.readySpeech(generation: generation)
        XCTAssertFalse(state.canCapture) // Uncertain submission still needs acknowledgment.
        state.reset(); XCTAssertThrowsError(try state.renewSpeech(backend, generation: generation))
    }
    func testRecordingBudgetReservesTimeBeforeCredentialExpiry() throws {
        let backend = try XCTUnwrap(envelope().backend); let expiry = try XCTUnwrap(Wire.date(backend.expiresAt))
        XCTAssertEqual(backend.captureSeconds(at: expiry.addingTimeInterval(-60)), 40)
        XCTAssertEqual(backend.captureSeconds(at: expiry.addingTimeInterval(-300)), 89)
        XCTAssertEqual(backend.captureSeconds(at: expiry.addingTimeInterval(-10)), 0)
        XCTAssertEqual(backend.captureSeconds(at: expiry.addingTimeInterval(1)), 0)
    }
}
