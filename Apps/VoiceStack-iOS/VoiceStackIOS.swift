import SwiftUI
import CallKit
import PushKit
import AVFoundation
import Intents
import VoiceStackCore

@main struct VoiceStackIOS: App {
    @UIApplicationDelegateAdaptor(PhoneDelegate.self) var delegate
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            PhoneView(model: delegate.model, coordinator: delegate.calls)
                .task { await delegate.model.launch() }
                .onChange(of: phase) { _, new in if new == .active { Task {
                    if delegate.model.state.call == nil { await delegate.model.reconnect() }
                    else { await delegate.calls.publishPolicy() }
                } } }
        }
    }
}
@MainActor final class PhoneDelegate: NSObject, UIApplicationDelegate {
    let model = VoiceModel()
    lazy var calls = PhoneCalls(model: model)
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool { _ = calls; return true }
}
@MainActor final class PhoneCalls: NSObject, @preconcurrency PKPushRegistryDelegate, @preconcurrency CXProviderDelegate {
    let model: VoiceModel
    let provider: CXProvider
    let controller = CXCallController()
    private var registry: PKPushRegistry!
    private var callIDs: [UUID: String] = [:]
    private var outgoing: UUID?
    private var pushToken: String?
    init(model: VoiceModel) {
        self.model = model
        let config = CXProviderConfiguration(); config.supportsVideo = false; config.maximumCallsPerCallGroup = 1; config.maximumCallGroups = 1; config.supportedHandleTypes = [.generic]; config.includesCallsInRecents = false
        provider = CXProvider(configuration: config); super.init(); provider.setDelegate(self, queue: .main)
        registry = PKPushRegistry(queue: .main); registry.delegate = self; registry.desiredPushTypes = [.voIP]
        model.onEnded = { [weak self] call in self?.ended(call) }
        model.onOutgoing = { [weak self] in self?.start() }
        model.onConnected = { [weak self] in Task { await self?.syncDevice() } }
        // PushKit owns iPhone incoming presentation. Device socket does not start capture.
    }
    func syncDevice() async {
        guard model.enrollment != nil else { return }
        if let pushToken { await model.registerPush(pushToken) }
        await publishPolicy()
    }
    func refreshPush() { Task { await syncDevice() } }
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) { pushToken = pushCredentials.token.map { String(format: "%02x", $0) }.joined(); refreshPush() }
    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) { pushToken = nil }
    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let object = payload.dictionaryPayload["voicestack"] as? [String: Any]
        let callID = object?["call_id"] as? String
        let uuid = callIDs.first(where: { $0.value == callID })?.key ?? UUID()
        let update = CXCallUpdate(); update.localizedCallerName = object?["caller_name"] as? String ?? "Caller"
        update.remoteHandle = CXHandle(type: .generic, value: String((object?["subject"] as? String ?? "Incoming call").prefix(60)))
        update.hasVideo = false; update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false
        // Report before network reconciliation, even for an invalid signal.
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            completion()
            Task { @MainActor in
                guard let self else { return }
                guard error == nil, object?["profile"] as? String == VoiceProfile.app, object?["event"] as? String == "call.incoming", let callID else { self.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed); return }
                self.callIDs[uuid] = callID
                await self.model.reconcileIncoming(callID)
                let policy = self.policy(); await self.model.publishAvailability(policy)
                if !policy.allowed { await self.model.decline(callId: callID, reason: policy.reason); self.provider.reportCall(with: uuid, endedAt: Date(), reason: .declinedElsewhere) }
            }
        }
    }
    func start() {
        guard outgoing == nil else { return }; let uuid = UUID(); outgoing = uuid
        controller.request(CXTransaction(action: CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: model.peerName)))) { [weak self] error in
            if error != nil { Task { @MainActor in self?.outgoing = nil; self?.model.error = "Could not start the system call." } }
        }
    }
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            do { try configureAudio() } catch { action.fail(); return }
            await model.startOutgoing()
            guard outgoing == action.callUUID, let call = model.state.call, model.state.explicitlyAccepted else { action.fail(); outgoing = nil; return }
            callIDs[action.callUUID] = call.id; action.fulfill(); provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        }
    }
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            guard let call = callIDs[action.callUUID] else { action.fail(); return }
            do { try configureAudio() } catch { action.fail(); return }
            await model.reconcileIncoming(call)
            let policy = policy()
            guard policy.allowed else { await model.decline(callId: call, reason: policy.reason); action.fail(); return }
            await model.accept(callId: call)
            guard callIDs[action.callUUID] == call, model.state.call?.id == call, model.state.explicitlyAccepted else { action.fail(); return }
            action.fulfill()
        }
    }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard let call = callIDs[action.callUUID] else { action.fulfill(); return }
        Task { @MainActor in
            if model.state.call?.id == call {
                if model.state.call?.state == "ringing" { await model.decline(callId: call) } else { await model.end(callId: call) }
            }; action.fulfill()
        }
    }
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) { guard callIDs[action.callUUID] == model.state.call?.id else { action.fail(); return }; model.muted = action.isMuted; action.fulfill() }
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) { model.audioActivated(true); if let outgoing { provider.reportOutgoingCall(with: outgoing, connectedAt: Date()) } }
    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) { model.audioActivated(false) }
    private func configureAudio() throws { try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP]) }
    func providerDidReset(_ provider: CXProvider) { model.stopLocal(); callIDs.removeAll(); outgoing = nil }
    private func ended(_ call: String) { for (uuid, value) in callIDs where value == call { provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded); callIDs.removeValue(forKey: uuid); if outgoing == uuid { outgoing = nil } } }
    func policy() -> Availability {
        let defaults = UserDefaults.standard
        let components = Calendar.current.dateComponents([.hour, .minute], from: Date())
        return Availability.evaluate(enabled: defaults.object(forKey: "callsEnabled") as? Bool ?? true,
            focused: INFocusStatusCenter.default.focusStatus.isFocused,
            quietStart: defaults.bool(forKey: "quietEnabled") ? (defaults.object(forKey: "quietStart") as? Int ?? 1320) : nil,
            quietEnd: defaults.bool(forKey: "quietEnabled") ? (defaults.object(forKey: "quietEnd") as? Int ?? 540) : nil,
            minute: (components.hour ?? 0) * 60 + (components.minute ?? 0))
    }
    func publishPolicy() async { await model.publishAvailability(policy()) }
    func requestFocus() { INFocusStatusCenter.default.requestAuthorization { [weak self] _ in Task { @MainActor in await self?.publishPolicy() } } }
}
struct PhoneView: View {
    @ObservedObject var model: VoiceModel
    let coordinator: PhoneCalls
    @AppStorage("callsEnabled") private var callsEnabled = true
    @AppStorage("quietEnabled") private var quietEnabled = false
    @AppStorage("quietStart") private var quietStart = 1320
    @AppStorage("quietEnd") private var quietEnd = 540
    @State private var settings = false
    var body: some View {
        ConversationView(model: model, settings: { settings = true })
        .sheet(isPresented: $settings) { NavigationStack {
        TabView {
            Form {
                Section("Sending") {
                    Toggle("Send after a pause", isOn: $model.automaticSending)
                    Picker("Pause", selection: $model.pauseSeconds) {
                        Text("1.5 seconds").tag(1.5); Text("2 seconds").tag(2.0); Text("3.2 seconds").tag(3.2); Text("5 seconds").tag(5.0)
                    }.disabled(!model.automaticSending)
                    Picker("Sensitivity", selection: $model.sensitivity) { Text("Low").tag("low"); Text("Normal").tag("normal"); Text("High").tag("high") }
                }.disabled(model.recording)
                Section("While busy") {
                    Picker("Delivery", selection: $model.state.requestedDelivery) { Text("Steer").tag(Delivery.steer); Text("Queue").tag(Delivery.queue) }
                    if model.state.call != nil, model.state.effectiveDelivery == .queue { Text("This connection queues replies when Steer is unavailable.").font(.caption).foregroundStyle(.secondary) }
                }
            }.tabItem { Label("Voice", systemImage: "waveform") }
            VoiceView(model: model, settingsOnly: true).tabItem { Label("Switchboard", systemImage: "network") }
            Form {
                Toggle("Allow incoming calls", isOn: $callsEnabled)
                Toggle("Quiet hours", isOn: $quietEnabled)
                if quietEnabled {
                    Stepper("Start: \(clock(quietStart))", value: $quietStart, in: 0...1439, step: 15)
                    Stepper("End: \(clock(quietEnd))", value: $quietEnd, in: 0...1439, step: 15)
                }
                Button("Allow Focus status access") { coordinator.requestFocus() }
                Text("Phone policy governs both devices. Incoming calls stay disabled when Apple does not expose Focus status. Grant Focus access above. Focus visibility is specific to this app.").font(.footnote)
            }.tabItem { Label("Availability", systemImage: "moon") }
                .onChange(of: callsEnabled) { _, _ in Task { await coordinator.publishPolicy() } }
                .onChange(of: quietEnabled) { _, _ in Task { await coordinator.publishPolicy() } }
                .onChange(of: quietStart) { _, _ in Task { await coordinator.publishPolicy() } }
                .onChange(of: quietEnd) { _, _ in Task { await coordinator.publishPolicy() } }
        }.navigationTitle("Sessions & settings").navigationBarTitleDisplayMode(.inline).toolbar { Button("Done") { settings = false } }
        }.preferredColorScheme(.dark) }
    }
    private func clock(_ value: Int) -> String { String(format: "%02d:%02d", value / 60, value % 60) }
}
