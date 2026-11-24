import Foundation
import VoiceStackCore

final class ListeningSecrets: SecretStore {
    var value: Data?
    func read() throws -> Data? { value }
    func write(_ data: Data) throws { value = data }
    func remove() throws { value = nil }
}
@main struct NativeAutoListenCheck {
    @MainActor static func main() async throws {
        var permissionRequests = 0
        let model = VoiceModel(deviceStore: ListeningSecrets(), operationStore: ListeningSecrets(), endStore: ListeningSecrets(), microphonePermission: { permissionRequests += 1; return false })
        func tick() async { try? await Task.sleep(for: .milliseconds(40)) }
        model.listenWhenReady(); await tick()
        precondition(permissionRequests == 0, "Unpaired startup must not request the microphone")
        let ringObject = try Wire.object(Data(contentsOf: URL(fileURLWithPath: "Fixtures/Switchboard-v1/incoming-call.json")))
        let ring = try Wire.decoder.decode(Call.self, from: Wire.data(ringObject["call"] as! [String: Any]))
        try model.state.ring(ring); model.listenWhenReady(); await tick()
        precondition(permissionRequests == 0, "Ringing must not request the microphone")
        var object = try Wire.object(Data(contentsOf: URL(fileURLWithPath: "Fixtures/Switchboard-v1/outgoing-call.json")))
        var backend = object["backend"] as! [String: Any]
        backend["expires_at"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(120)); object["backend"] = backend
        let envelope = try Wire.decoder.decode(CallEnvelope.self, from: Wire.data(object))
        model.error = VoiceError.server("backend_unavailable").localizedDescription
        try model.ownCall(envelope, deviceId: "fixture")
        let generation = model.state.generation
        try model.state.readyText(callId: envelope.call.id, binding: envelope.call.targetBinding!, generation: generation)
        try model.state.readySpeech(generation: generation)
        model.listenWhenReady(); await tick()
        precondition(permissionRequests == 0, "CallKit/audio activation must precede microphone use")
        try model.state.activateAudio(true, generation: generation)
        model.listenWhenReady(); model.listenWhenReady(); await tick()
        precondition(permissionRequests == 1, "An accepted ready call must automatically request the microphone once")
        model.listenWhenReady(); await tick()
        precondition(permissionRequests == 1 && !model.recording, "Denied permission must not spin or capture")
        model.stopLocal(); model.listenWhenReady(); await tick()
        precondition(permissionRequests == 1, "Ended calls cannot reactivate capture")
        let review = VoiceModel(deviceStore: ListeningSecrets(), operationStore: ListeningSecrets(), endStore: ListeningSecrets(), automaticallyListen: false)
        try review.state.own(envelope, deviceId: "fixture", explicit: true)
        let rg = review.state.generation
        try review.state.readyText(callId: envelope.call.id, binding: envelope.call.targetBinding!, generation: rg)
        try review.state.readySpeech(generation: rg); try review.state.activateAudio(true, generation: rg)
        try review.state.commit(generation: rg)
        try await review.speechEvent(["type": "conversation.item.input_audio_transcription.completed", "item_id": "discard-late-final", "transcript": "These final words just appeared."], generation: rg)
        precondition(review.canDiscard && review.state.pendingTurn == nil, "Final words must remain discardable before delivery")
        precondition(review.state.userCaption == "These final words just appeared.", "Final words must be visible during review")
        await review.discardRecording()
        precondition(!review.state.awaitingTranscript && review.state.userCaption.isEmpty, "Discard must clear a finalized but unsent thought")
        try? await Task.sleep(for: .milliseconds(1700))
        precondition(review.state.pendingTurn == nil && review.state.userCaption.isEmpty, "Cancelled delivery timer must not submit the discarded final")
        review.stopLocal()
        print("PASS: late final stays visible and discardable; discard clears it and cancels delayed delivery.")
        print("PASS: automatic listening waits for explicit acceptance, both transports, audio activation and microphone permission; denial and end cannot restart capture.")
    }
}
