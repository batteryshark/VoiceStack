import SwiftUI
import AppKit
import VoiceStackCore

struct PillMaterial: NSViewRepresentable {
    let theme: PillTheme
    func makeNSView(context: Context) -> NSVisualEffectView { let view = NSVisualEffectView(); view.blendingMode = .behindWindow; view.state = .active; return view }
    func updateNSView(_ view: NSVisualEffectView, context: Context) { view.material = theme.material; view.appearance = NSAppearance(named: theme.appearance) }
}

/// Presentation port of the accepted 182×44 pill and 360-point caption card.
/// Original theme, material, hairlines, waveform and glass controls are retained.
struct CallPill: View {
    @ObservedObject var model: VoiceModel
    let open: () -> Void
    @AppStorage("pillAppearance") private var appearance = "graphite"
    private var theme: PillTheme { appearance == "frost" ? .frost : .graphite }
    private var expanded: Bool { Self.size(model).width > 182 }
    private var active: Bool { model.state.call != nil }
    static func size(_ model: VoiceModel) -> CGSize {
        guard model.callStarting || model.state.call != nil || !model.state.userCaption.isEmpty || !model.state.replyCaption.isEmpty || model.state.call?.state == "ringing" || model.error != nil || (!model.automaticSending && model.recording) else { return CGSize(width: 182, height: 44) }
        var height: CGFloat = 93
        if model.error != nil { height += 42 }
        if model.callStarting || model.state.call != nil || !model.state.userCaption.isEmpty { height += 66 }
        if !model.state.replyCaption.isEmpty { height += 82 }
        if model.state.call?.state == "ringing" { height += 36 }
        return CGSize(width: 360, height: height)
    }
    var body: some View {
        let size = Self.size(model)
        let shape = RoundedRectangle(cornerRadius: 22, style: .circular)
        ZStack {
            PillMaterial(theme: theme)
            PillSurface(shape: shape, size: size)
            VStack(alignment: .leading, spacing: 11) {
                if expanded {
                    HStack(spacing: 7) {
                        Circle().fill(model.error == nil ? theme.ready : theme.error).frame(width: 6, height: 6)
                        Text(model.peerName).font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.secondary).lineLimit(1)
                        Spacer(minLength: 4)
                        CircleButton(symbol: "gearshape.fill", active: false, plain: true, help: "Settings", action: open)
                    }.padding(.horizontal, 8)
                    if let error = model.error { Text(error).font(.system(size: 11.5, weight: .medium)).foregroundStyle(theme.error).lineLimit(2).padding(.horizontal, 8) }
                    if model.callStarting || active || !model.state.userCaption.isEmpty {
                        caption("YOU", text: model.state.userCaption.isEmpty ? (model.recording ? "Listening…" : model.callStarting ? "Connecting…" : model.status) : model.state.userCaption, color: theme.you, lines: 2)
                    }
                    if !model.state.replyCaption.isEmpty { caption(model.peerName, text: model.state.replyCaption, color: theme.agent, lines: 3) }
                    if let call = model.state.call, call.state == "ringing" {
                        HStack {
                            Button("Answer") { Task { await model.accept(callId: call.id) } }.tint(theme.you)
                            Button("Decline") { Task { await model.decline(callId: call.id) } }
                        }.buttonStyle(.bordered).padding(.horizontal, 8)
                    }
                }
                controls
            }.padding(8)
            PillEdges(shape: shape, error: model.error != nil).allowsHitTesting(false)
        }.frame(width: size.width, height: size.height).clipShape(shape)
            .environment(\.pillTheme, theme).environment(\.colorScheme, theme.colorScheme)
    }
    private var controls: some View {
        HStack(spacing: 6) {
            VisualizerView(levels: model.recording ? model.inputLevels : model.outputLevels,
                           voice: model.recording ? .you : model.outputLevels.contains(where: { $0 > 0 }) ? .agent : .none,
                           dimmed: !active)
                .frame(width: expanded ? 55 : 64, height: 22).allowsHitTesting(false)
            Spacer(minLength: 0)
            Button {
                if model.enrollment == nil { open() }
                else { Task { if let call = model.state.call { await model.end(callId: call.id) } else { await model.dial() } } }
            } label: {
                Image(systemName: "power").font(.system(size: 10.5, weight: .bold))
                    .foregroundStyle(active ? theme.glyph : theme.onAccent).frame(width: 28, height: 28)
                    .background(Capsule().fill(active ? theme.buttonFill : theme.you))
            }.buttonStyle(PressStyle()).help(active ? "End call" : "Start voice")
                .disabled(!active && (model.busy || model.pendingMutation != nil || model.pendingEnd != nil))
            if active && expanded {
                MuteButton(muted: model.muted, agent: false, expanded: false, width: 28) { model.muted.toggle() }
                MuteButton(muted: model.outputMuted, agent: true, expanded: false, width: 28) { model.outputMuted.toggle() }
                if model.canDiscard { DiscardButton(textOnly: true) { Task { await model.discardRecording() } } }
                if model.recording && !model.automaticSending { SendButton(holding: true, hotkey: "Send") { Task { await model.sendRecording() } } }
            }
            if !expanded { CircleButton(symbol: "gearshape.fill", active: false, plain: true, help: "Settings", action: open) }
        }.frame(height: 28)
    }
    private func caption(_ label: String, text: String, color: Color, lines: Int) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Capsule().fill(LinearGradient(colors: [color, color.opacity(0.55)], startPoint: .top, endPoint: .bottom)).frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.system(size: 9.5, weight: .bold)).tracking(0.9).foregroundStyle(color.opacity(0.78))
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(text).font(.system(size: 14, weight: .medium)).lineSpacing(2.5).foregroundStyle(theme.primary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled).privacySensitive()
                            Color.clear.frame(height: 1).id("latest")
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.scrollIndicators(.hidden).defaultScrollAnchor(.bottom)
                        .onChange(of: text) { _, _ in proxy.scrollTo("latest", anchor: .bottom) }
                }.frame(height: CGFloat(lines) * 19)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.fixedSize(horizontal: false, vertical: true).padding(.horizontal, 8)
    }
}
