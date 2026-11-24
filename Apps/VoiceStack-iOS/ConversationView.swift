import SwiftUI
import VoiceStackCore

/// The accepted iPhone call surface: same dark canvas, blue/amber meters,
/// caption cards and 62-point circular controls. Actions now belong to VoiceModel.
struct ConversationView: View {
    @ObservedObject var model: VoiceModel
    let settings: () -> Void
    @State private var speaker = false
    private var active: Bool { model.state.call != nil }
    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(active ? model.peerName : model.status).font(.headline).accessibilityAddTraits(.updatesFrequently)
                    Spacer()
                    Text("0.1 · 7").font(.caption2).foregroundStyle(.secondary)
                }
                HStack(spacing: 16) {
                    meter("YOU", levels: model.inputLevels, voice: .you, color: VoiceBrand.blue)
                    meter(model.peerName, levels: model.outputLevels, voice: .agent, color: VoiceBrand.amber)
                }.padding(.horizontal, 6)
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if model.state.userCaption.isEmpty && model.state.replyCaption.isEmpty {
                                Text(model.recording ? "Listening…" : "Your conversation appears here").foregroundStyle(.secondary).padding()
                            }
                            if !model.state.userCaption.isEmpty { caption("You", text: model.state.userCaption, color: VoiceBrand.blue, user: true) }
                            if !model.state.replyCaption.isEmpty { caption(model.peerName, text: model.state.replyCaption, color: VoiceBrand.amber, user: false) }
                            Color.clear.frame(height: 1).id("latest")
                        }.padding(6)
                    }.defaultScrollAnchor(.bottom).scrollIndicators(.visible)
                        .onChange(of: model.state.userCaption) { _, _ in proxy.scrollTo("latest", anchor: .bottom) }
                        .onChange(of: model.state.replyCaption) { _, _ in proxy.scrollTo("latest", anchor: .bottom) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).layoutPriority(1)
                    .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 16))
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.secondary) }
                if model.pendingMutation != nil { Button("Reconcile pending operation") { Task { await model.retryMutation() } }.font(.callout).disabled(model.busy) }
                if model.pendingEnd != nil { Button("Finish ending call") { Task { await model.reconcileEnd() } }.font(.callout) }
                if model.enrollment == nil {
                    Button("Pair with Switchboard", action: settings).buttonStyle(.borderedProminent)
                } else if active && model.recording && !model.automaticSending {
                    Button("Send", systemImage: "arrow.up") { Task { await model.sendRecording() } }
                        .buttonStyle(.bordered).tint(VoiceBrand.blue)
                }
                if model.canDiscard { Button("Discard", systemImage: "arrow.counterclockwise") { Task { await model.discardRecording() } }.buttonStyle(.bordered) }
                HStack(alignment: .top, spacing: 12) {
                    callButton("Mute mic", symbol: model.muted ? "mic.slash.fill" : "mic.fill", on: model.muted) { model.muted.toggle() }
                    callButton("Mute voice", symbol: model.outputMuted ? "speaker.slash.fill" : "speaker.wave.2.fill", on: model.outputMuted) { model.outputMuted.toggle() }
                    callButton(speaker ? "Speaker" : "Phone", symbol: speaker ? "speaker.wave.2.fill" : "phone.fill", on: speaker) {
                        do { try model.audio.speaker(!speaker); speaker.toggle() } catch { model.show(error) }
                    }.disabled(!active)
                    callButton(active ? "End" : "Start", symbol: active ? "phone.down.fill" : "phone.fill", on: false, end: active) {
                        Task { if let call = model.state.call { await model.end(callId: call.id) } else { await model.dial() } }
                    }.disabled(model.enrollment == nil || (!active && (model.busy || model.pendingMutation != nil || model.pendingEnd != nil || model.selectedTarget.isEmpty)))
                }
            }.padding().background(Color(white: 0.055))
                .navigationTitle("Voicestack").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Settings", systemImage: "gearshape", action: settings) } }
        }.preferredColorScheme(.dark)
    }
    private func meter(_ label: String, levels: [Double], voice: BrandVoice, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(color)
            NativeWaveform(levels: levels, voice: voice, ready: active).frame(height: 28)
        }.accessibilityElement(children: .ignore).accessibilityLabel(label + " audio level")
    }
    private func caption(_ label: String, text: String, color: Color, user: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.bold()).foregroundStyle(color)
            Text(text).textSelection(.enabled).privacySensitive()
        }.fixedSize(horizontal: false, vertical: true).padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(user ? color.opacity(0.07) : Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 14))
    }
    // Retained from the original VoiceMainView.callButton.
    private func callButton(_ label: String, symbol: String, on: Bool, end: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: symbol).font(.system(size: 24, weight: .medium)).frame(width: 62, height: 62)
                    .foregroundStyle(end || !on ? Color.white : Color.black)
                    .background(end ? Color.red : on ? Color.white.opacity(0.94) : Color.white.opacity(0.13), in: Circle())
                Text(label).font(.caption).lineLimit(2).multilineTextAlignment(.center)
            }.frame(maxWidth: .infinity, minHeight: 88).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(label).accessibilityValue(end ? "" : on ? "on" : "off")
    }
}
