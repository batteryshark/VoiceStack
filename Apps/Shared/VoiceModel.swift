import SwiftUI
import AVFoundation
import VoiceStackCore

@MainActor final class VoiceModel: ObservableObject {
    @Published var enrollment: Enrollment?
    @Published var state = CallState()
    @Published var targets: [Target] = []
    @Published var tokens: [CallerToken] = []
    @Published var selectedTarget = "" {
        didSet { if state.call == nil, status.hasPrefix("Ready to call") { status = "Ready to call \(peerName)" } }
    }
    var peerName: String {
        if let call = state.call {
            if call.direction == "incoming" { return call.callerName?.nonemptyDisplayName ?? "Caller" }
            if let name = call.target?.label.nonemptyDisplayName { return name }
        }
        return targets.first(where: { $0.id == selectedTarget })?.label.nonemptyDisplayName ?? "Agent"
    }
    @Published var oneTimeSecret: String?
    @Published var status = "Pair with Switchboard to begin."
    @Published var error: String?
    @Published var busy = false
    @Published var recording = false
    @Published var callStarting = false
    @Published var hearingSpeech = false
    @Published var muted = false { didSet { audio.muted = muted } }
    @Published var outputMuted = false { didSet { if outputMuted { stopReply() } } }
    @Published var inputLevels = [Double](repeating: 0, count: 15)
    @Published var outputLevels = [Double](repeating: 0, count: 15)
    @Published var automaticSending = UserDefaults.standard.object(forKey: "automaticSending") as? Bool ?? true {
        didSet { UserDefaults.standard.set(automaticSending, forKey: "automaticSending") }
    }
    @Published var pauseSeconds = UserDefaults.standard.object(forKey: "pauseSeconds") as? Double ?? 3.2 {
        didSet { UserDefaults.standard.set(pauseSeconds, forKey: "pauseSeconds") }
    }
    @Published var sensitivity = UserDefaults.standard.string(forKey: "sensitivity") ?? "normal" {
        didSet { UserDefaults.standard.set(sensitivity, forKey: "sensitivity") }
    }
    @Published var pendingMutation: Mutation?
    @Published var pendingEnd: Mutation?
    @Published var speechSettings: SharedSpeechSettings?
    @Published var speechSettingsLoading = false
    @Published var speechSettingsError: String?
    let audio: NativeAudio
    private var meterTask: Task<Void, Never>?
    private let pairing: Pairing
    private let journal: SecretStore
    private let endJournal: SecretStore
    private var ending = false
    private let automaticallyListen: Bool
    private let microphonePermission: () async -> Bool
    var canDiscard: Bool { recording || state.awaitingTranscript }
    private var finalDeliveryTask: Task<Void, Never>?
    private var finalizingItem: String?
    private var explicitSubmission = false
    private var lastPreviewWords = ""
    private var lastPreviewAt: Date?
    private func captionWords(_ text: String) -> String {
        text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).joined(separator: " ")
    }
    private var captureStarting = false
    private var microphoneDenied = false
    private var waitingForReply = false
    private var currentResponse: String?
    private var pendingSpeechRequests = 0
    init(deviceStore: SecretStore = KeychainStore(service: "VoiceStack.device.v1"), operationStore: SecretStore = KeychainStore(service: "VoiceStack.operations.v1"), endStore: SecretStore = KeychainStore(service: "VoiceStack.ends.v1"), automaticallyListen: Bool = true, audio: NativeAudio = NativeAudio(), microphonePermission: @escaping () async -> Bool = { await AVCaptureDevice.requestAccess(for: .audio) }) {
        self.audio = audio
        pairing = Pairing(store: deviceStore); journal = operationStore; endJournal = endStore
        self.automaticallyListen = automaticallyListen; self.microphonePermission = microphonePermission
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard !Task.isCancelled, let self else { return }
                self.updateMeters()
            }
        }
        audio.onPlaybackIdle = { [weak self] in Task { @MainActor in self?.outputLevels = Array(repeating: 0, count: 15); self?.listenWhenReady() } }
    }
    private var client: SwitchboardClient?
    private var deviceSocket: JSONSocket?
    private var textSocket: JSONSocket?
    private var speechSocket: JSONSocket?
    private var tasks: [Task<Void, Never>] = []
    private var deviceTask: Task<Void, Never>?
    private var speechTask: Task<Void, Never>?
    private var speechReceiveTask: Task<Void, Never>?
    private var renewalTask: Task<Void, Never>?
    private var speechEpoch = UUID()
    private var captureTask: Task<Void, Never>?
    private var captureTimer: Task<Void, Never>?
    private var captureStream: AsyncThrowingStream<Data, Error>.Continuation?
    private var spokenResponses = Set<String>()
    private var outstandingReplies = Set<String>()
    private var interruptedReplies = Set<String>()
    private var segments: [String: SpeechSegments] = [:]
    private var playbackEpoch = UUID()
    var onIncoming: ((Call) -> Void)?
    var onEnded: ((String) -> Void)?
    var onOutgoing: (() -> Void)?
    var onConnected: (() -> Void)?
    var systemAudioActive = false
    var platform: String {
        #if os(iOS)
        return "ios"
        #else
        return "macos"
        #endif
    }
    func launch() async {
        guard !busy else { return }; busy = true; defer { busy = false; if client != nil { onConnected?() } }
        do {
            pendingMutation = try await journal.readAsync().map { try Wire.decoder.decode(Mutation.self, from: $0) }
            pendingEnd = try await endJournal.readAsync().map { try Wire.decoder.decode(Mutation.self, from: $0) }
            if let stored = try await pairing.restoreAsync() { enrollment = stored; try await connected(await pairing.reconcile(stored)) }
        } catch { show(error) }
    }
    func pair(base: String, code: String, name: String, replacing: Bool = false) async {
        busy = true; defer { busy = false; if client != nil { onConnected?() } }
        do {
            guard let url = URL(string: base) else { throw VoiceError.insecureAddress }
            let api = try SwitchboardClient(base: url)
            try await connected(await pairing.enroll(client: api, code: code, name: name, platform: platform, replacing: replacing))
        } catch { show(error) }
    }
    private func connected(_ e: Enrollment) async throws {
        enrollment = e; error = nil
        client = try SwitchboardClient(base: e.base, credential: e.device.deviceCredential)
        await reconcileEnd()
        try await refresh(); status = pendingEnd == nil ? "Ready to call \(peerName)" : "Finish ending the previous call"
        var parts = URLComponents(url: e.base.appendingPathComponent("device/events"), resolvingAgainstBaseURL: false)!; parts.scheme = "wss"
        let socket = try client!.socket(parts.url!); deviceSocket?.close(); deviceSocket = socket; deviceTask?.cancel()
        deviceTask = Task { [weak self] in
            do { while !Task.isCancelled { let message = try await socket.receive(); guard let self else { return }; try self.deviceEvent(message) } }
            catch { if !Task.isCancelled { self?.error = "Incoming-call connection lost. Reconnect to receive calls." } }
        }
    }
    func reconnect() async { await launch() }
    func refresh() async throws {
        guard let client else { return }
        targets = try await client.get("targets", as: TargetList.self).targets
        if !targets.contains(where: { $0.id == selectedTarget }) { selectedTarget = targets.first(where: { $0.isDefault == true })?.id ?? "" }
        tokens = try await client.get("caller-tokens", as: TokenList.self).tokens
    }
    func show(_ error: Error) { self.error = (error as? VoiceError)?.localizedDescription ?? "The operation failed. Check service availability and try again." }
    func stopReply() { interruptedReplies.formUnion(outstandingReplies); playbackEpoch = UUID(); pendingSpeechRequests = 0; speechTask?.cancel(); audio.stopPlayback(); outputLevels = Array(repeating: 0, count: 15); waitingForReply = false; currentResponse = nil; listenWhenReady() }
    func listenWhenReady() {
        guard automaticallyListen, error == nil, !microphoneDenied, !captureStarting, !recording, !waitingForReply,
              pendingSpeechRequests == 0, !audio.hasPendingPlayback, state.canCapture,
              !busy, pendingMutation == nil, pendingEnd == nil else { return }
        Task { [weak self] in await self?.beginRecording() }
    }
    /// Match the original visualizer's 50 ms cadence, independently of network
    /// receive/send timing. Heights only reflect measured capture/render PCM.
    func updateMeters() {
        let levels = audio.takeLevels()
        let input = Array(inputLevels.suffix(14)) + [AudioLevel.height(rms: recording && !muted ? levels.input : 0)]
        let output = Array(outputLevels.suffix(14)) + [AudioLevel.height(rms: outputMuted ? 0 : levels.output)]
        if input != inputLevels { inputLevels = input }
        if output != outputLevels { outputLevels = output }
    }
    deinit { meterTask?.cancel() }
    func mutate(_ method: String, _ path: String, _ fields: [String: Any]) async {
        guard client != nil else { return }
        guard pendingMutation == nil, !busy else { error = "Reconcile the pending operation first."; return }
        busy = true
        do {
            let generation = state.generation
            let m = try Mutation(method: method, path: path, fields: fields)
            try await journal.writeAsync(Wire.encoder.encode(m)); pendingMutation = m; busy = false
            guard state.generation == generation else { throw VoiceError.uncertain }
            await retryMutation()
        } catch { busy = false; show(error) }
    }
    func retryMutation() async {
        guard let mutation = pendingMutation, let client, !busy else { return }
        busy = true; defer { busy = false; listenWhenReady() }
        let generation = state.generation
        do {
            let data = try await client.perform(mutation)
            // Decode before clearing the journal: malformed success bodies are uncertain too.
            let creation = mutation.path == "caller-tokens" && mutation.method == "POST" ? try Wire.decoder.decode(TokenCreation.self, from: data) : nil
            let admitted = mutation.path == "calls" || mutation.path.hasSuffix("/accept") ? try Wire.decoder.decode(CallEnvelope.self, from: data) : nil
            let refreshed = mutation.path.hasSuffix("/backend-handoff") ? try Wire.decoder.decode(BackendEnvelope.self, from: data) : nil
            let speech = mutation.path == "settings/speech" ? try Wire.decoder.decode(SharedSpeechSettings.self, from: data) : nil
            try await journal.removeAsync(); pendingMutation = nil
            if let speech { speechSettings = speech }
            if let creation { oneTimeSecret = creation.secret }
            if let envelope = admitted {
                guard state.generation == generation else { throw VoiceError.staleCall }
                try await attach(envelope)
            }
            if let refreshed {
                guard state.generation == generation else { throw VoiceError.staleCall }
                let path = mutation.path.replacingOccurrences(of: "/backend-handoff", with: "")
                let call = try await client.get(path, as: CallEnvelope.self).call
                guard state.generation == generation else { throw VoiceError.staleCall }
                guard call.id == state.call?.id, call.targetBinding == state.call?.targetBinding,
                      call.state == "active", call.ownerDeviceId == enrollment?.device.deviceId else { throw VoiceError.staleCall }
                if textSocket != nil {
                    try state.renewSpeech(refreshed.backend, generation: generation)
                    connectSpeech(refreshed.backend, generation: generation)
                } else { try await attach(CallEnvelope(call: call, backend: refreshed.backend)) }
            }
            if mutation.path.contains("caller-tokens") { try await refresh() }
        } catch let e as VoiceError {
            if case .server = e { try? await journal.removeAsync(); pendingMutation = nil }
            show(e)
        } catch { show(error) }
    }
    func createToken(name: String) async { oneTimeSecret = nil; await mutate("POST", "caller-tokens", ["name": name]) }
    func loadSpeechSettings() async {
        guard let client, !speechSettingsLoading else { return }
        speechSettingsLoading = true; defer { speechSettingsLoading = false }
        do { speechSettings = try await client.get("settings/speech", as: SharedSpeechSettings.self); speechSettingsError = nil }
        catch { speechSettingsError = "Shared voice settings are unavailable. Check the Switchboard connection." }
    }
    func chooseVoice(_ voice: String) async {
        guard state.call == nil else { return }
        await mutate("PUT", "settings/speech", ["voice": voice])
        if pendingMutation == nil { await loadSpeechSettings() }
    }
    func previewVoice(_ voice: String) async {
        guard let client, state.call == nil, !busy else { return }
        busy = true; defer { busy = false }
        do {
            audio.stopPlayback()
            let pcm = try await client.perform(Mutation(method: "POST", path: "settings/speech/preview", fields: ["voice": voice]))
            guard state.call == nil else { return }; try audio.play(pcm)
        } catch { speechSettingsError = "Voice preview failed. Check the speech service and output device." }
    }
    func revoke(_ token: CallerToken) async { await mutate("POST", "caller-tokens/\(token.id)/revoke", [:]) }
    func delete(_ token: CallerToken) async { guard token.state == "revoked" else { return }; await mutate("DELETE", "caller-tokens/\(token.id)", [:]) }
    func dial() async {
        guard state.call == nil, pendingEnd == nil, !selectedTarget.isEmpty else { return }
        #if os(iOS)
        onOutgoing?()
        #else
        await startOutgoing()
        #endif
    }
    func startOutgoing() async { guard state.call == nil, pendingEnd == nil else { return }; callStarting = true; defer { callStarting = false }; await mutate("POST", "calls", ["direction": "outgoing", "target_id": selectedTarget]) }
    func accept(callId: String) async { guard state.call?.id == callId, state.call?.state == "ringing" else { return }; await mutate("POST", "calls/\(callId)/accept", [:]) }
    func decline(callId: String, reason: String = "user") async {
        await finishCall(callId: callId, action: "decline", reason: reason)
    }
    func end(callId: String) async { await finishCall(callId: callId, action: "end", reason: "user") }
    private func finishCall(callId: String, action: String, reason: String) async {
        guard state.call?.id == callId, pendingEnd == nil else { return }
        do {
            pendingEnd = try Mutation(method: "POST", path: "calls/\(callId)/\(action)", fields: ["reason": reason])
            stopLocal(); status = "Ending call…"
            await reconcileEnd()
        } catch { show(error) }
    }
    /// Hang-up has its own durable slot: availability, renewal or an uncertain
    /// ordinary mutation must never prevent the user from ending a call.
    func reconcileEnd() async {
        guard let mutation = pendingEnd, let client, !ending else { return }
        ending = true; defer { ending = false }
        do {
            try await endJournal.writeAsync(Wire.encoder.encode(mutation))
            do { _ = try await client.perform(mutation) }
            catch VoiceError.server(let code) where code == "call_not_active" { /* Already ended is reconciled. */ }
            try await endJournal.removeAsync(); pendingEnd = nil; status = "Ready to call \(peerName)"
        } catch { status = "Hang-up pending — retry to finish"; show(error) }
    }
    func deviceEvent(_ m: [String: Any]) throws {
        if m["type"] as? String == "call.incoming", let obj = m["call"] as? [String: Any] {
            let call = try Wire.decoder.decode(Call.self, from: Wire.data(obj))
            guard state.call == nil, let expiry = call.ringExpiresAt.flatMap(Wire.date), expiry > Date() else { return }
            try state.ring(call); status = "Incoming call"; onIncoming?(call)
        } else if ["call.taken", "call.ended"].contains(m["type"] as? String ?? ""), m["call_id"] as? String == state.call?.id { stopLocal() }
    }
    func reconcileIncoming(_ callId: String) async {
        do {
            guard let client else { throw VoiceError.unauthorized }
            let envelope = try await client.get("calls/\(callId)", as: CallEnvelope.self)
            if envelope.call.state != "ringing" { onEnded?(callId); return }
            if state.call == nil { try state.ring(envelope.call) }
        } catch { onEnded?(callId); show(error) }
    }
    func ownCall(_ envelope: CallEnvelope, deviceId: String) throws {
        try state.own(envelope, deviceId: deviceId, explicit: true)
        // A successful new admission retires errors from the previous attempt.
        // Otherwise listenWhenReady remains blocked even with healthy transports.
        error = nil
    }
    private func attach(_ envelope: CallEnvelope) async throws {
        guard let e = enrollment, let client else { throw VoiceError.unauthorized }
        var envelope = envelope
        state.hold(envelope.call)
        let attachmentGeneration = state.generation
        if let b = envelope.backend, let expires = Wire.date(b.expiresAt), expires <= Date() {
            let mutation = try Mutation(method: "POST", path: "calls/\(envelope.call.id)/backend-handoff", fields: [:])
            // Persist renewal so an uncertain refresh can use the same identifier.
            try await journal.writeAsync(Wire.encoder.encode(mutation)); pendingMutation = mutation
            let fresh = try Wire.decoder.decode(BackendEnvelope.self, from: await client.perform(mutation))
            try state.check(attachmentGeneration)
            envelope = CallEnvelope(call: envelope.call, backend: fresh.backend); try await journal.removeAsync(); pendingMutation = nil
            try state.check(attachmentGeneration)
        }
        try ownCall(envelope, deviceId: e.device.deviceId)
        let generation = state.generation; let backend = state.backend!
        textSocket = try client.socket(state.call!.textChannel!)
        status = "Connecting speech…"
        #if os(macOS)
        try state.activateAudio(true, generation: generation)
        #else
        try state.activateAudio(systemAudioActive, generation: generation)
        #endif
        let text = textSocket!
        tasks.append(Task { [weak self] in
            do { while !Task.isCancelled { let m = try await text.receive(); guard let self else { return }; try await self.textEvent(m, generation: generation) } }
            catch { self?.callFailure(error, generation: generation) }
        })
        connectSpeech(backend, generation: generation)
        renewalTask?.cancel()
        renewalTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self, self.state.generation == generation else { return }
                if !self.recording, !self.state.awaitingTranscript, !self.busy, self.pendingMutation == nil,
                   let backend = self.state.backend, backend.remaining() < 45 {
                    await self.renewSpeechCredential(generation: generation)
                }
            }
        }
    }
    private func connectSpeech(_ backend: Backend, generation: UUID) {
        speechReceiveTask?.cancel(); speechSocket?.close(); speechEpoch = UUID()
        let epoch = speechEpoch
        let speech = JSONSocket(address: backend.transcriptionAddress, credential: backend.credential, livePreview: true); speechSocket = speech
        speechReceiveTask = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let m = try await speech.receive()
                    guard !Task.isCancelled, let self, self.speechEpoch == epoch else { return }
                    try await self.speechEvent(m, generation: generation)
                }
            } catch { if !Task.isCancelled, self?.speechEpoch == epoch { self?.callFailure(error, generation: generation) } }
        }
    }
    private func renewSpeechCredential(generation: UUID) async {
        guard state.generation == generation, let call = state.call, !recording, !state.awaitingTranscript,
              !busy, pendingMutation == nil else { return }
        await mutate("POST", "calls/\(call.id)/backend-handoff", [:])
    }
    func speechEvent(_ m: [String: Any], generation: UUID) async throws {
        try state.check(generation)
        switch m["type"] as? String {
        case "session.created":
            try await speechSocket?.send(["type": "session.update", "session": ["type": "transcription", "audio": ["input": ["format": ["type": "audio/pcm", "rate": 24000], "turn_detection": NSNull(), "transcription": ["model": "local-parakeet"]]]]])
        case "session.updated":
            guard let session = m["session"] as? [String: Any], session["type"] as? String == "transcription",
                  let input = (session["audio"] as? [String: Any])?["input"] as? [String: Any],
                  let format = input["format"] as? [String: Any], format["type"] as? String == "audio/pcm", format["rate"] as? Int == 24000,
                  input["turn_detection"] is NSNull, (input["transcription"] as? [String: Any])?["model"] as? String == "local-parakeet" else { throw VoiceError.unsupportedProfile }
            try state.readySpeech(generation: generation); status = "Connected"; listenWhenReady()
        case "voicestack.input_audio_transcription.preview":
            guard let id = m["item_id"] as? String, let text = m["text"] as? String,
                  finalizingItem == nil, recording || state.awaitingTranscript else { return }
            if !hearingSpeech, recording { try state.beginUserTurn(generation: generation); hearingSpeech = true }
            try state.previewSnapshot(itemId: id, text: text, generation: generation)
            let words = captionWords(text)
            if words != lastPreviewWords { lastPreviewWords = words; lastPreviewAt = Date() }
        case "conversation.item.input_audio_transcription.delta":
            guard let id = m["item_id"] as? String, let delta = m["delta"] as? String,
                  recording || state.awaitingTranscript else { return }
            if !hearingSpeech, recording { try state.beginUserTurn(generation: generation); hearingSpeech = true }
            guard finalizingItem == nil else { return }
            try state.preview(itemId: id, delta: delta, generation: generation)
            lastPreviewWords = captionWords(state.userCaption); lastPreviewAt = Date()
        case "conversation.item.input_audio_transcription.completed":
            guard let id = m["item_id"] as? String, let text = m["transcript"] as? String else { throw VoiceError.invalidResponse }
            guard state.awaitingTranscript, finalizingItem == nil else { return }
            finalizingItem = id
            try state.previewSnapshot(itemId: id, text: text, generation: generation)
            // A slow final must not remove Discard on the same frame its last
            // words appear. No added hold when live words were already visible.
            let seen = captionWords(text) == lastPreviewWords ? lastPreviewAt?.timeIntervalSinceNow ?? 0 : 0
            let grace = explicitSubmission || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : max(0, 1.5 + seen)
            let epoch = speechEpoch
            finalDeliveryTask = Task { [weak self] in
                if grace > 0 { try? await Task.sleep(for: .seconds(grace)) }
                guard !Task.isCancelled, let self, self.state.generation == generation, self.speechEpoch == epoch else { return }
                do {
                    if let turn = try self.state.transcript(itemId: id, text: text, generation: generation) {
                        try await self.textSocket?.send(data: Wire.encoder.encode(turn)); self.status = "Waiting for \(self.peerName)…"
                    } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { self.waitingForReply = false; self.listenWhenReady() }
                } catch { self.callFailure(error, generation: generation) }
            }
        case "conversation.item.input_audio_transcription.failed", "error": throw VoiceError.server("backend_unavailable")
        default: break
        }
    }
    private func textEvent(_ m: [String: Any], generation: UUID) async throws {
        try state.check(generation)
        switch m["type"] as? String {
        case "call.ready": try state.readyText(callId: m["call_id"] as? String ?? "", binding: m["target_binding"] as? String ?? "", generation: generation); listenWhenReady()
        case "turn.accepted":
            guard let id = UUID(uuidString: m["operation_id"] as? String ?? ""), let mode = Delivery(rawValue: m["effective_delivery"] as? String ?? "") else { throw VoiceError.invalidResponse }
            try state.accepted(operationId: id, delivery: mode, binding: m["target_binding"] as? String ?? "", generation: generation)
            if let response = m["response_id"] as? String { outstandingReplies.insert(response); currentResponse = response }
            if mode != state.requestedDelivery { status = "Queued — Steer was unavailable" }
        case "reply.delta":
            guard let id = m["response_id"] as? String, let delta = m["delta"] as? String else { throw VoiceError.invalidResponse }
            if try state.reply(response: id, sequence: m["sequence"] as? Int ?? 0, delta: delta, generation: generation) {
                let ready = segments[id, default: SpeechSegments()].append(delta)
                if !recording, !interruptedReplies.contains(id) { for text in ready { enqueueSpeech(text, generation: generation) } }
            }
        case "reply.done":
            guard let id = m["response_id"] as? String, let text = m["text"] as? String else { throw VoiceError.invalidResponse }
            try state.finishReply(response: id, text: text, generation: generation)
            outstandingReplies.remove(id)
            if currentResponse == id { waitingForReply = false; currentResponse = nil }
            if m["status"] as? String == "completed", !spokenResponses.contains(id) {
                spokenResponses.insert(id); let ready = try segments[id, default: SpeechSegments()].finish(text)
                if !recording, !interruptedReplies.contains(id) { for text in ready { enqueueSpeech(text, generation: generation) } }
            }
            segments.removeValue(forKey: id)
            if m["status"] as? String != "completed" { playbackEpoch = UUID(); pendingSpeechRequests = 0; speechTask?.cancel(); audio.stopPlayback(); status = "\(peerName)’s reply did not complete" }
            listenWhenReady()
        case "call.ended": stopLocal()
        case "error": throw VoiceError.server("request_failed")
        default: break
        }
    }
    func beginRecording() async {
        guard !microphoneDenied, !captureStarting, !recording, !busy, pendingMutation == nil, state.canCapture else { return }
        captureStarting = true; var resumeAfterRenewal = false
        defer { captureStarting = false; if resumeAfterRenewal { listenWhenReady() } }
        let generation = state.generation
        let permission = await microphonePermission()
        guard state.generation == generation, state.canCapture else { resumeAfterRenewal = state.call != nil; return }
        guard permission else { microphoneDenied = true; error = "Allow microphone access in System Settings."; return }
        do {
            try state.check(generation)
            guard !busy, pendingMutation == nil, let backend = state.backend else { return }
            if backend.remaining() < 45 {
                resumeAfterRenewal = true
                await renewSpeechCredential(generation: generation)
                status = "Connecting…"; return
            }
            let captureSeconds = backend.captureSeconds()
            hearingSpeech = false; lastPreviewWords = ""; lastPreviewAt = nil; finalizingItem = nil
            guard let socket = speechSocket else { throw VoiceError.invalidState }
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .bufferingOldest(100))
            captureStream = continuation
            try audio.startCapture { data in
                if case .dropped = continuation.yield(data) { continuation.finish(throwing: VoiceError.server("audio_backpressure")) }
            }
            recording = true; status = "Listening"
            captureTask = Task { [weak self] in
                do {
                    var count = 0
                    var pause = PauseDetector(pauseSeconds: self?.pauseSeconds ?? 3.2, sensitivity: Sensitivity(rawValue: self?.sensitivity ?? "normal") ?? .normal)
                    for try await pcm in stream {
                        guard !Task.isCancelled, let self else { return }; try self.state.check(generation)
                        count += pcm.count; guard count <= 90 * 48000 else { throw VoiceError.server("turn_too_long") }
                        for offset in stride(from: 0, to: pcm.count, by: 4800) { try await socket.send(["type": "input_audio_buffer.append", "audio": pcm.subdata(in: offset..<min(offset + 4800, pcm.count)).base64EncodedString()]) }
                        guard !Task.isCancelled else { return }
                        let paused = pause.append(pcm)
                        if pause.heardSpeech, !self.hearingSpeech { self.hearingSpeech = true; try self.state.beginUserTurn(generation: generation) }
                        if self.automaticSending, !self.muted, paused { await self.sendRecording(explicit: false) }
                    }
                    guard !Task.isCancelled, let self else { return }; try self.state.check(generation)
                    if count > 0 { try await socket.send(["type": "input_audio_buffer.commit"]); self.status = "Transcribing…" }
                } catch { if !Task.isCancelled { self?.callFailure(error, generation: generation) } }
            }
            captureTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(captureSeconds)); guard !Task.isCancelled, let self, self.state.generation == generation else { return }
                if self.hearingSpeech { await self.sendRecording(explicit: false) }
                else {
                    self.captureTask?.cancel(); _ = self.audio.finishCapture(); self.captureStream?.finish(); self.captureStream = nil; self.recording = false
                    try? await self.speechSocket?.send(["type": "input_audio_buffer.clear"])
                    await self.renewSpeechCredential(generation: generation)
                }
            }
        } catch { show(error) }
    }
    func discardRecording() async {
        guard canDiscard, let backend = state.backend else { return }
        let generation = state.generation
        // Close the old transport before yielding: queued partials/finals lose
        // their speech epoch, and cancellation cannot commit the discarded PCM.
        finalDeliveryTask?.cancel(); finalDeliveryTask = nil; finalizingItem = nil; waitingForReply = false
        captureTask?.cancel(); captureTimer?.cancel(); _ = audio.finishCapture()
        captureStream?.finish(); captureStream = nil; recording = false; hearingSpeech = false
        speechReceiveTask?.cancel(); speechSocket?.close(); speechEpoch = UUID()
        inputLevels = Array(repeating: 0, count: 15)
        do {
            try state.discardUnsubmitted(generation: generation)
            try state.renewSpeech(backend, generation: generation)
            status = "Starting fresh…"
            if backend.remaining() < 45 { await renewSpeechCredential(generation: generation) }
            else { connectSpeech(backend, generation: generation) }
        } catch { callFailure(error, generation: generation) }
    }
    func sendRecording(explicit: Bool = true) async {
        guard recording else { return }; let generation = state.generation; let count = audio.finishCapture(); recording = false; captureTimer?.cancel()
        guard count > 0 else { captureTask?.cancel(); captureStream?.finish(); captureStream = nil; status = "No audio captured"; return }
        do {
            explicitSubmission = explicit
            try state.commit(generation: generation); waitingForReply = true; currentResponse = nil
            captureStream?.finish(); captureStream = nil
        } catch { callFailure(error, generation: generation) }
    }
    private func enqueueSpeech(_ text: String, generation: UUID) {
        guard state.backend != nil, !outputMuted else { return }; let epoch = playbackEpoch; let prior = speechTask
        pendingSpeechRequests += 1
        speechTask = Task { [weak self] in
            defer { if let self, self.playbackEpoch == epoch { self.pendingSpeechRequests = max(0, self.pendingSpeechRequests - 1); self.listenWhenReady() } }
            await prior?.value
            do {
                // Bounded segments; one serialized request chain per call.
                var remainder = text[...]
                while !remainder.isEmpty {
                    guard !Task.isCancelled, let self, self.state.generation == generation, self.playbackEpoch == epoch else { return }
                    if (self.state.backend?.remaining() ?? 0) < 40 { await self.renewSpeechCredential(generation: generation) }
                    guard !Task.isCancelled, self.state.generation == generation, self.playbackEpoch == epoch else { return }
                    guard let backend = self.state.backend, backend.remaining() >= 40 else { throw VoiceError.unauthorized }
                    let end = remainder.index(remainder.startIndex, offsetBy: min(240, remainder.count)); let segment = String(remainder[..<end]); remainder = remainder[end...]
                    var req = URLRequest(url: backend.speechAddress); req.httpMethod = "POST"; req.timeoutInterval = 40
                    req.setValue("Bearer \(backend.credential)", forHTTPHeaderField: "Authorization"); req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.httpBody = try Wire.data(["model": "local-breeze", "voice": "local-default", "input": segment, "response_format": "pcm"])
                    let (bytes, response) = try await SecureSession.shared.bytes(for: req)
                    guard !Task.isCancelled, self.state.generation == generation, self.playbackEpoch == epoch else { return }
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("audio/pcm") == true else { throw VoiceError.invalidResponse }
                    var chunk = Data(); var count = 0
                    for try await byte in bytes {
                        guard !Task.isCancelled, self.state.generation == generation, self.playbackEpoch == epoch else { return }
                        chunk.append(byte); count += 1; guard count <= 48000 * 180 else { throw VoiceError.invalidResponse }
                        if chunk.count == 4800 { try self.audio.play(chunk); chunk.removeAll(keepingCapacity: true); self.status = "\(self.peerName) is speaking" }
                    }
                    guard count > 0, chunk.count % 2 == 0 else { throw VoiceError.invalidResponse }
                    if !chunk.isEmpty { try self.audio.play(chunk) }
                }
            } catch { if !Task.isCancelled { self?.callFailure(error, generation: generation) } }
        }
    }
    func audioActivated(_ active: Bool) { systemAudioActive = active; if state.call != nil { try? state.activateAudio(active, generation: state.generation) }; if !active { audio.stop(); recording = false } else { listenWhenReady() } }
    private func callFailure(_ error: Error, generation: UUID) {
        guard state.generation == generation else { return }
        finalDeliveryTask?.cancel(); finalDeliveryTask = nil
        renewalTask?.cancel(); speechTask?.cancel(); playbackEpoch = UUID()
        pendingSpeechRequests = 0
        captureTask?.cancel(); captureTimer?.cancel(); captureStream?.finish(); captureStream = nil; audio.stop(); recording = false; show(error)
        try? state.activateAudio(false, generation: generation)
        // Preserve any uncertain text turn and its operation ID. Do not replay under another ID.
        status = "Call connection interrupted — end this call before starting another"
    }
    func stopLocal() {
        finalDeliveryTask?.cancel(); finalDeliveryTask = nil; finalizingItem = nil; lastPreviewWords = ""; lastPreviewAt = nil
        waitingForReply = false; currentResponse = nil; pendingSpeechRequests = 0; hearingSpeech = false; microphoneDenied = false; callStarting = false
        let callId = state.call?.id; state.reset(); audio.stop(); recording = false; playbackEpoch = UUID(); speechTask?.cancel(); speechTask = nil
        inputLevels = Array(repeating: 0, count: 15); outputLevels = Array(repeating: 0, count: 15)
        captureTask?.cancel(); captureTimer?.cancel(); captureStream?.finish(); captureStream = nil
        renewalTask?.cancel(); renewalTask = nil; speechReceiveTask?.cancel(); speechReceiveTask = nil; speechEpoch = UUID()
        tasks.forEach { $0.cancel() }; tasks.removeAll(); textSocket?.close(); speechSocket?.close(); textSocket = nil; speechSocket = nil; spokenResponses.removeAll(); outstandingReplies.removeAll(); interruptedReplies.removeAll(); segments.removeAll()
        status = "Ready to call \(peerName)"; if let callId { onEnded?(callId) }
    }
    func publishAvailability(_ policy: Availability) async {
        guard platform == "ios", pendingMutation == nil else { return }
        await mutate("PUT", "devices/me/availability", ["calls_allowed": policy.allowed, "reason": policy.reason, "valid_until": ISO8601DateFormatter().string(from: Date().addingTimeInterval(300))])
    }
    func registerPush(_ token: String) async {
        guard let bundle = Bundle.main.bundleIdentifier else { return }
        await mutate("PUT", "devices/me/push", ["environment": Bundle.main.object(forInfoDictionaryKey: "VoiceStackAPNSEnvironment") as? String ?? "sandbox", "bundle_id": bundle, "voip_token": token])
    }
}

private extension String {
    var nonemptyDisplayName: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
