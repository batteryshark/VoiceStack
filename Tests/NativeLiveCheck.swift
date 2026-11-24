// Opt-in live check of the SAME VoiceModel compiled by the Mac app. Uses memory
// stores, never opens the microphone, and never touches the app's Keychain entry.
import Foundation
import VoiceStackCore

final class MemorySecrets: SecretStore {
    var value: Data?
    func read() throws -> Data? { value }
    func write(_ data: Data) throws { value = data }
    func remove() throws { value = nil }
}
@main struct NativeLiveCheck {
    @MainActor static func main() async throws {
        let base = ProcessInfo.processInfo.environment["VOICE_SWITCHBOARD_BASE"]!
        let input = try Wire.object(FileHandle.standardInput.readDataToEndOfFile())
        let model = VoiceModel(deviceStore: MemorySecrets(), operationStore: MemorySecrets(), endStore: MemorySecrets(), automaticallyListen: false)
        await model.pair(base: base, code: input["pairing_code"] as! String, name: "Native renewal verifier")
        guard model.enrollment != nil, model.error == nil else { throw VoiceError.invalidResponse }
        await model.startOutgoing()
        guard let call = model.state.call else {
            print("FAIL: call was not admitted: \(model.error ?? model.status)")
            exit(1)
        }
        if ProcessInfo.processInfo.environment["VOICE_NATIVE_END_RACE_CHECK"] == "1" {
            let enrollment = model.enrollment!
            let api = try SwitchboardClient(base: enrollment.base, credential: enrollment.device.deviceCredential)
            model.busy = true // Simulate availability or handout work owning the ordinary mutation slot.
            await model.end(callId: call.id)
            model.busy = false
            guard model.pendingEnd == nil else { throw VoiceError.uncertain }
            let result = try await api.get("calls/\(call.id)", as: CallEnvelope.self)
            if result.call.state != "ended" {
                // Clean up the disposable reproduction even when the assertion fails.
                _ = try await api.perform(Mutation(method: "POST", path: "calls/\(call.id)/end", fields: ["reason": "user"]))
                print("FAIL: ending during a busy setup operation stopped local state but left the server call active.")
                exit(1)
            }
            print("PASS: ending during a busy setup operation ended the server call.")
            return
        }
        do {
            let generation = model.state.generation
            var lastCredential = model.state.backend?.credential
            var renewals = 0
            // Cross the initial 60-second expiry; keep the same call/text channel.
            for _ in 0..<75 {
                try await Task.sleep(for: .seconds(1))
                guard model.error == nil, model.state.generation == generation,
                      model.state.call?.id == call.id, model.state.call?.targetBinding == call.targetBinding,
                      !model.recording else { throw VoiceError.invalidState }
                if model.state.backend?.credential != lastCredential {
                    renewals += 1; lastCredential = model.state.backend?.credential
                }
            }
            guard renewals >= 2, model.state.textReady, model.state.speechReady, model.state.canCapture else { throw VoiceError.invalidState }
            print("Native VoiceModel: same call and text binding survived 75 seconds; \(renewals) speech renewals; microphone stayed off.")
            await model.end(callId: call.id)
            guard model.pendingMutation == nil, model.error == nil else { throw VoiceError.uncertain }
            print("Native verification call ended.")
        } catch {
            await model.end(callId: call.id); throw error
        }
    }
}
