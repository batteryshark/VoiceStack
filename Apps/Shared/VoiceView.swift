import SwiftUI
import VoiceStackCore

struct VoiceView: View {
    @ObservedObject var model: VoiceModel
    var settingsOnly = false
    @State private var base = ""
    @State private var code = ""
    @State private var deviceName = "VoiceStack"
    @State private var tokenName = ""
    @State private var speaker = false
    @State private var inputDevice: UInt32 = 0
    @State private var outputDevice: UInt32 = 0
    @State private var changingServer = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack { BrandIcon().frame(width: 42, height: 42); Text("Voicestack").font(.title.bold()); Spacer() }
                if model.enrollment == nil || changingServer {
                    pairing
                    if changingServer { Button("Cancel") { changingServer = false; code = "" } }
                } else { if settingsOnly { connectionSettings; SpeechSettingsPanel(model: model) } else { callControls }; tokenControls }
                if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled); Button("Dismiss") { model.error = nil } }
                if model.pendingMutation != nil { Button("Reconcile pending operation") { Task { await model.retryMutation() } }.disabled(model.busy) }
                if model.pendingEnd != nil { Button("Finish ending call") { Task { await model.reconcileEnd() } } }
                if model.enrollment != nil { Button("Reconnect") { Task { await model.reconnect() } }.disabled(model.busy || model.state.call != nil) }
                if let enrollment = model.enrollment {
                    Text(enrollment.base.absoluteString).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Change server") { changingServer = true; code = "" }.disabled(model.busy || model.state.call != nil || model.pendingMutation != nil || model.pendingEnd != nil)
                }
            }.padding(24)
        }.frame(minWidth: 320)
        .sheet(isPresented: Binding(get: { model.oneTimeSecret != nil }, set: { if !$0 { model.oneTimeSecret = nil } })) {
            VStack(alignment: .leading, spacing: 18) {
                Text("Caller token — shown once").font(.title2.bold())
                Text("Move this secret to the caller’s protected storage. It will not appear in the token list.")
                Text(model.oneTimeSecret ?? "").font(.system(.body, design: .monospaced)).textSelection(.enabled).privacySensitive()
                Button("Done") { model.oneTimeSecret = nil }.buttonStyle(.borderedProminent)
            }.padding(24).frame(minWidth: 300)
        }
    }
    private var connectionSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Conversation", selection: $model.selectedTarget) { ForEach(model.targets) { Text($0.label).tag($0.id) } }.disabled(model.state.call != nil)
            Picker("While busy", selection: $model.state.requestedDelivery) { Text("Steer").tag(Delivery.steer); Text("Queue").tag(Delivery.queue) }.pickerStyle(.segmented)
            #if os(macOS)
            Picker("Microphone", selection: $inputDevice) { Text("System default").tag(UInt32(0)); ForEach(NativeAudio.devices(input: true)) { Text($0.name).tag($0.id) } }
                .onChange(of: inputDevice) { _, value in do { try model.audio.selectDevice(value, input: true) } catch { model.show(error) } }.disabled(model.state.call != nil)
            Picker("Output", selection: $outputDevice) { Text("System default").tag(UInt32(0)); ForEach(NativeAudio.devices(input: false)) { Text($0.name).tag($0.id) } }
                .onChange(of: outputDevice) { _, value in do { try model.audio.selectDevice(value, input: false) } catch { model.show(error) } }.disabled(model.state.call != nil)
            #endif
        }
    }
    private var pairing: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pair this device").font(.title2)
            TextField("Switchboard HTTPS base address", text: $base).textContentType(.URL)
            TextField("Device name", text: $deviceName)
            SecureField("One-use pairing code", text: $code).privacySensitive()
            Button("Pair") { let secret = code; code = ""; Task { await model.pair(base: base, code: secret, name: deviceName, replacing: changingServer); if model.enrollment?.base.absoluteString == base { changingServer = false } } }
                .buttonStyle(.borderedProminent).disabled(model.busy || base.isEmpty || code.isEmpty)
        }.textFieldStyle(.roundedBorder)
    }
    private var callControls: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.status).foregroundStyle(.secondary)
            if let call = model.state.call {
                Text(model.peerName).font(.title.bold())
                if let subject = call.subject { Text(subject).font(.headline) }
                if call.state == "ringing" {
                    #if os(macOS)
                    HStack {
                        Button("Answer", systemImage: "phone.fill") { Task { await model.accept(callId: call.id) } }.buttonStyle(.borderedProminent)
                        Button("Decline", role: .destructive) { Task { await model.decline(callId: call.id) } }
                    }
                    #else
                    Text("Answer using the system call screen.")
                    #endif
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        if !model.state.userCaption.isEmpty { Text("You").font(.caption).foregroundStyle(.secondary); Text(model.state.userCaption).privacySensitive() }
                        if !model.state.replyCaption.isEmpty { Text(model.peerName).font(.caption).foregroundStyle(.secondary); Text(model.state.replyCaption).privacySensitive() }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                    HStack {
                        Button(model.recording ? "Send turn" : "Record turn", systemImage: model.recording ? "arrow.up.circle.fill" : "mic.fill") {
                            Task { if model.recording { await model.sendRecording() } else { await model.beginRecording() } }
                        }.buttonStyle(.borderedProminent).disabled(!model.recording && (!model.state.canCapture || model.busy || model.pendingMutation != nil))
                        Toggle("Mute", isOn: $model.muted).toggleStyle(.button)
                    }
                    #if os(iOS)
                    Toggle("Speakerphone", isOn: $speaker).onChange(of: speaker) { _, value in do { try model.audio.speaker(value) } catch { model.show(error) } }
                    #endif
                    Button("End call", systemImage: "phone.down.fill", role: .destructive) { Task { await model.end(callId: call.id) } }
                }
            } else {
                Picker("Conversation", selection: $model.selectedTarget) { ForEach(model.targets) { target in Text(target.label).tag(target.id) } }
                Button("Call \(model.peerName)", systemImage: "phone.fill") { Task { await model.dial() } }
                    .buttonStyle(.borderedProminent).disabled(model.busy || model.pendingMutation != nil || model.selectedTarget.isEmpty)
                #if os(macOS)
                Picker("Microphone", selection: $inputDevice) { Text("System default").tag(UInt32(0)); ForEach(NativeAudio.devices(input: true)) { Text($0.name).tag($0.id) } }
                    .onChange(of: inputDevice) { _, value in do { try model.audio.selectDevice(value, input: true) } catch { model.show(error) } }
                Picker("Output", selection: $outputDevice) { Text("System default").tag(UInt32(0)); ForEach(NativeAudio.devices(input: false)) { Text($0.name).tag($0.id) } }
                    .onChange(of: outputDevice) { _, value in do { try model.audio.selectDevice(value, input: false) } catch { model.show(error) } }
                #endif
            }
            Picker("Next turn", selection: $model.state.requestedDelivery) { Text("Steer").tag(Delivery.steer); Text("Queue").tag(Delivery.queue) }.pickerStyle(.segmented)
            if model.state.effectiveDelivery == .queue { Text("Effective delivery: Queue").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var tokenControls: some View {
        GroupBox("Caller tokens") {
            VStack(alignment: .leading, spacing: 12) {
                HStack { TextField("Caller name", text: $tokenName); Button("Create") { Task { await model.createToken(name: tokenName) } }.disabled(model.busy || tokenName.trimmingCharacters(in: .whitespaces).isEmpty || model.pendingMutation != nil) }
                ForEach(model.tokens) { token in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text(token.name).bold(); Spacer(); Text(token.state).foregroundStyle(.secondary) }
                        Text("Created: \(token.createdAt ?? "—")").font(.caption)
                        Text("Last used: \(token.lastUsedAt ?? "Never")").font(.caption)
                        if token.state == "active" { Button("Revoke", role: .destructive) { Task { await model.revoke(token) } } }
                        else { Button("Delete record", role: .destructive) { Task { await model.delete(token) } } }
                    }.disabled(model.busy || model.pendingMutation != nil)
                }
            }.padding(4)
        }
    }
}
