import Foundation
import VoiceStackCore

final class StartupSecrets: SecretStore {
    var value: Data?
    func read() throws -> Data? { value }
    func write(_ data: Data) throws { value = data }
    func remove() throws { value = nil }
}
@main struct NativeStartupCheck {
    @MainActor static func main() async {
        let journal = StartupSecrets()
        let model = VoiceModel(deviceStore: StartupSecrets(), operationStore: journal, endStore: StartupSecrets())
        await model.launch()
        // This is the mutation path used when PushKit delivers a token before
        // first pairing. No HTTP admission exists, so no uncertain operation exists.
        await model.mutate("PUT", "devices/me/push", ["voip_token": "synthetic", "environment": "sandbox", "bundle_id": "fixture.voicestack"])
        guard model.pendingMutation == nil, journal.value == nil, !model.busy else {
            print("FAIL: first-run device registration created a pending operation before pairing, disabling Start.")
            exit(1)
        }
        print("PASS: unpaired device registration leaves no journal or pending operation.")
    }
}
