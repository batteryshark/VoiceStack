import SwiftUI
import AppKit
import Combine
import VoiceStackCore

@main struct VoiceStackMac: App {
    @NSApplicationDelegateAdaptor(MacDelegate.self) var delegate
    var body: some Scene {
        Settings { EmptyView() }
            .commands { VoiceCommands(model: delegate.model, settings: delegate.openControls) }
    }
}
struct VoiceCommands: Commands {
    @ObservedObject var model: VoiceModel
    let settings: () -> Void
    var body: some Commands {
        CommandGroup(replacing: .appSettings) { Button("Voice settings…", action: settings).keyboardShortcut(",") }
        CommandMenu("Call") {
            Button("End Call") { if let call = model.state.call { Task { await model.end(callId: call.id) } } }
                .keyboardShortcut(".", modifiers: [.command]).disabled(model.state.call == nil)
        }
    }
}
final class VoicePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
@MainActor final class MacDelegate: NSObject, NSApplicationDelegate {
    let model = VoiceModel()
    let presentation = PillPresentation()
    private var pill: VoicePanel!
    private var lastDesiredSize = CGSize(width: 182, height: 44)
    private var updates = Set<AnyCancellable>()
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        pill = VoicePanel(contentRect: NSRect(x: 80, y: 100, width: 182, height: 44), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        pill.level = .floating; pill.isFloatingPanel = true; pill.hidesOnDeactivate = false; pill.isMovableByWindowBackground = true; pill.backgroundColor = .clear; pill.isOpaque = false
        pill.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        pill.contentView = NSHostingView(rootView: PillRoot(model: model, presentation: presentation))
        model.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.resizePill() } }.store(in: &updates)
        presentation.objectWillChange.sink { [weak self] in DispatchQueue.main.async { self?.resizePill(); self?.pill.makeKeyAndOrderFront(nil) } }.store(in: &updates)
        model.onIncoming = { [weak self] _ in self?.presentation.page = .call; self?.pill.orderFrontRegardless() }
        pill.orderFrontRegardless()
        Task { await model.launch(); if model.enrollment == nil { presentation.page = .connection } }
    }
    func openControls() { presentation.page = .settings; pill.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func resizePill() {
        let desired = presentation.size(model)
        guard desired != lastDesiredSize else { return }
        lastDesiredSize = desired
        let visible = (pill.screen ?? NSScreen.main)?.visibleFrame ?? pill.frame
        let frame = FloatingPanelGeometry.frame(current: pill.frame, desired: desired, visible: visible.insetBy(dx: 8, dy: 8))
        guard pill.frame != frame else { return }
        NSAnimationContext.runAnimationGroup { context in context.duration = 0.25; pill.animator().setFrame(frame, display: true) }
    }
    func applicationWillTerminate(_ notification: Notification) { model.stopLocal() }
}
