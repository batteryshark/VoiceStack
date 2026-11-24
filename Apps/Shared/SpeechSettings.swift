import SwiftUI
import VoiceStackCore

struct SpeechSettingsPanel: View {
    @ObservedObject var model: VoiceModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(model.peerName)’s voice").font(.headline)
            Text("Shared by your Mac and iPhone. End the call before changing or previewing a voice.").font(.caption).foregroundStyle(.secondary)
            if let settings = model.speechSettings {
                LabeledContent("Speech service", value: settings.backendLabel)
                Picker("Voice", selection: Binding(get: { settings.voice }, set: { voice in Task { await model.chooseVoice(voice) } })) {
                    ForEach(settings.voices) { Text($0.label).tag($0.id) }
                }.disabled(model.busy || model.state.call != nil || model.pendingMutation != nil)
                Button("Preview voice", systemImage: "play.fill") { Task { await model.previewVoice(settings.voice) } }
                    .disabled(model.busy || model.state.call != nil)
            } else if model.speechSettingsLoading { ProgressView("Loading voices…") }
            if let error = model.speechSettingsError { Text(error).font(.caption).foregroundStyle(.secondary) }
            Button("Refresh voices") { Task { await model.loadSpeechSettings() } }.disabled(model.speechSettingsLoading)
        }.task { await model.loadSpeechSettings() }
    }
}
