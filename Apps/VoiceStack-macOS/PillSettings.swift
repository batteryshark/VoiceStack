import SwiftUI
import AppKit
import VoiceStackCore

@MainActor final class PillPresentation: ObservableObject {
    enum Page { case call, settings, switchboard, connection }
    @Published var page: Page = .call
    func size(_ model: VoiceModel) -> CGSize {
        switch page {
        case .call: return CallPill.size(model)
        case .settings: return CGSize(width: 360, height: 602)
        case .switchboard: return CGSize(width: 360, height: 510)
        case .connection: return CGSize(width: 420, height: 640)
        }
    }
}

final class DragHandleView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}
struct WindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> DragHandleView { DragHandleView() }
    func updateNSView(_ view: DragHandleView, context: Context) {}
}

struct PillRoot: View {
    @ObservedObject var model: VoiceModel
    @ObservedObject var presentation: PillPresentation
    @AppStorage("pillAppearance") private var appearance = "graphite"
    private var theme: PillTheme { appearance == "frost" ? .frost : .graphite }
    var body: some View {
        let size = presentation.size(model)
        let shape = RoundedRectangle(cornerRadius: 22, style: .circular)
        ZStack {
            if presentation.page == .call {
                CallPill(model: model, open: { presentation.page = .settings })
            } else {
                PillMaterial(theme: theme)
                PillSurface(shape: shape, size: size)
                PillSettings(model: model, presentation: presentation)
                PillEdges(shape: shape, error: model.error != nil).allowsHitTesting(false)
            }
        }
        .frame(width: size.width, height: size.height).clipShape(shape)
        .overlay(alignment: .topLeading) {
            WindowDragRegion().frame(width: presentation.page == .call && size.width == 182 ? 70 : size.width - 112, height: 24).padding(.leading, 8).padding(.top, 8)
        }
        .environment(\.pillTheme, theme).environment(\.colorScheme, theme.colorScheme)
    }
}

/// Original settings groups, row heights, capsule menus and typography, rebound
/// to local audio controls and Switchboard's shared speech settings.
struct PillSettings: View {
    @ObservedObject var model: VoiceModel
    @ObservedObject var presentation: PillPresentation
    @Environment(\.pillTheme) private var theme
    @AppStorage("pillAppearance") private var appearance = "graphite"
    @State private var input: UInt32 = 0
    @State private var output: UInt32 = 0
    private var title: String { presentation.page == .settings ? "Voicestack" : "Switchboard" }
    private var voiceLabel: String {
        guard let speech = model.speechSettings else { return model.speechSettingsLoading ? "Loading…" : "Voice settings" }
        return speech.voices.first(where: { $0.id == speech.voice })?.label ?? speech.voice
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                BrandIcon().frame(width: 21, height: 21)
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(theme.primary)
                Spacer()
                Button("Done") { presentation.page = .call }
                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(theme.onAccent)
                    .padding(.horizontal, 11).frame(height: 22).background(Capsule().fill(theme.you))
                    .buttonStyle(PressStyle()).keyboardShortcut(.cancelAction)
            }.frame(height: 24).padding(.horizontal, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if presentation.page == .connection {
                        VoiceView(model: model, settingsOnly: true).padding(.horizontal, -16)
                    } else if presentation.page == .switchboard { switchboard }
                    else { everyday }
                }
            }.scrollIndicators(.hidden)
            if let error = model.error {
                HStack { Text(error).font(.system(size: 10.5)).foregroundStyle(theme.error).lineLimit(3); Button("Dismiss") { model.error = nil }.buttonStyle(.plain) }
            }
            if model.pendingEnd != nil { Button("Finish ending call") { Task { await model.reconcileEnd() } } }
            if model.pendingMutation != nil { Button("Reconcile pending operation") { Task { await model.retryMutation() } }.disabled(model.busy) }
            HStack {
                if presentation.page == .settings {
                    PlainChip(symbol: "network", label: "Switchboard") { presentation.page = .switchboard }
                } else { PlainChip(symbol: "chevron.left", label: "Voice settings") { presentation.page = .settings } }
                Spacer()
                if let call = model.state.call {
                    PlainChip(symbol: "phone.down.fill", label: "End call") { Task { await model.end(callId: call.id) } }
                }
            }
        }.padding(.horizontal, 12).padding(.vertical, 12)
            .task { await model.loadSpeechSettings() }
    }
    private var everyday: some View {
        VStack(alignment: .leading, spacing: 10) {
            group("Voice") {
                voiceRow
                divider
                inline("Output") {
                    deviceMenu(input: false, selected: output) { id in do { try model.audio.selectDevice(id, input: false); output = id } catch { model.show(error) } }
                }
            }
            group("Listening") {
                inline("Microphone") {
                    deviceMenu(input: true, selected: input) { id in do { try model.audio.selectDevice(id, input: true); input = id } catch { model.show(error) } }
                }
                divider
                inline("Sensitivity") {
                    Segmented(options: [("low","Low"),("normal","Normal"),("high","High")], selected: model.sensitivity) { model.sensitivity = $0 }.disabled(model.recording)
                }
            }
            group("Sending") {
                stacked("Send") {
                    Segmented(options: [("auto","After a pause"),("manual","When I press Send")], selected: model.automaticSending ? "auto" : "manual", stretch: true) { model.automaticSending = $0 == "auto" }.disabled(model.recording)
                }
                divider
                stacked("Pause before sending") {
                    Segmented(options: [("1.5","1.5 s"),("2.0","2 s"),("3.2","3.2 s"),("5.0","5 s")], selected: String(model.pauseSeconds), stretch: true) { if let seconds = Double($0) { model.pauseSeconds = seconds } }.disabled(model.recording || !model.automaticSending)
                }
                divider
                inline("While \(model.peerName) is busy") {
                    Segmented(options: [("steer","Steer"),("queue","Queue")], selected: model.state.requestedDelivery.rawValue) { model.state.requestedDelivery = Delivery(rawValue: $0) ?? .steer }
                }
                if model.state.call != nil, model.state.effectiveDelivery == .queue {
                    Text("This connection queues replies when Steer is unavailable.").font(.system(size: 10.5)).foregroundStyle(theme.secondary).padding(.horizontal, 12).padding(.bottom, 8)
                }
            }
            group("Conversation") {
                inline("Call") { ChoiceMenu(title: model.peerName, choices: model.targets.map { SettingsChoice(id: $0.id, label: $0.label) }, selected: model.selectedTarget) { model.selectedTarget = $0 }.disabled(model.state.call != nil) }
            }
            group("Appearance") {
                inline("Theme") { Segmented(options: [("graphite","Graphite"),("frost","Frost")], selected: appearance) { appearance = $0 } }
            }
        }
    }
    private var switchboard: some View {
        VStack(alignment: .leading, spacing: 10) {
            group("Shared speech") {
                voiceRow
                divider
                inline("Service") { Text(model.speechSettings?.backendLabel ?? "Unavailable").font(.system(size: 11.5)).foregroundStyle(theme.secondary).lineLimit(1) }
            }
            Text("One voice for your Mac and iPhone. End the call before changing it.").font(.system(size: 11)).foregroundStyle(theme.secondary).padding(.horizontal, 12)
            if let message = model.speechSettingsError { Text(message).font(.system(size: 11)).foregroundStyle(theme.error).padding(.horizontal, 12) }
            PlainChip(symbol: "arrow.clockwise", label: "Refresh voices") { Task { await model.loadSpeechSettings() } }
            group("Connection") {
                stacked("Switchboard") { Text(model.enrollment?.base.host ?? "Not paired").font(.system(size: 11.5)).foregroundStyle(theme.secondary).textSelection(.enabled) }
                divider
                inline("Conversation") { Text(model.peerName).font(.system(size: 11.5)).foregroundStyle(theme.primary) }
            }
            PlainChip(symbol: "key", label: "Pairing & caller access") { presentation.page = .connection }
            Text("Caller names come from the tokens you issue. Outgoing calls use the configured conversation name.").font(.system(size: 11)).foregroundStyle(theme.secondary).padding(.horizontal, 12)
        }
    }
    private var voiceRow: some View {
        inline("Voice") {
            ChoiceMenu(title: voiceLabel, choices: model.speechSettings?.voices.map { SettingsChoice(id: $0.id, label: $0.label) } ?? [], selected: model.speechSettings?.voice ?? "") { voice in Task { await model.chooseVoice(voice) } }
                .disabled(model.busy || model.state.call != nil || model.pendingMutation != nil)
            IconChip(symbol: "play.fill", help: "Preview voice") { if let voice = model.speechSettings?.voice { Task { await model.previewVoice(voice) } } }
                .disabled(model.busy || model.state.call != nil || model.speechSettings == nil)
        }
    }
    private func deviceMenu(input: Bool, selected: UInt32, pick: @escaping (UInt32) -> Void) -> some View {
        let devices = NativeAudio.devices(input: input)
        return ChoiceMenu(title: devices.first(where: { $0.id == selected })?.name ?? "System default", choices: [SettingsChoice(id: "0", label: "System default")] + devices.map { SettingsChoice(id: String($0.id), label: $0.name) }, selected: String(selected)) { if let id = UInt32($0) { pick(id) } }.disabled(model.state.call != nil)
    }
    private var divider: some View { Rectangle().fill(theme.divider).frame(height: 0.5).padding(.leading, 12) }
    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title.uppercased()).font(.system(size: 9.5, weight: .bold)).tracking(0.9).foregroundStyle(theme.secondary).padding(.leading, 12)
            VStack(alignment: .leading, spacing: 0, content: content).background(RoundedRectangle(cornerRadius: 12).fill(theme.groupFill)).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.groupStroke, lineWidth: 0.5))
        }
    }
    private func inline<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 6) { Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.primary.opacity(0.9)).lineLimit(1); Spacer(minLength: 8); content() }.padding(.horizontal, 12).frame(height: 34)
    }
    private func stacked<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) { Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.primary.opacity(0.9)); content() }.padding(.horizontal, 12).padding(.vertical, 9)
    }
}
