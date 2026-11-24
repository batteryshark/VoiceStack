// Presentation components carried over from the earlier VoiceStack Mac pill.
// Only the waveform voice type is rebound to the new presentation model.
import SwiftUI

enum PillLayout { static let button: CGFloat = 28 }

struct PillSurface<S: Shape>: View {
    let shape: S
    let size: CGSize
    @Environment(\.pillTheme) private var theme
    @Environment(\.pillBackdrop) private var backdrop

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let backdrop {
                Image(nsImage: backdrop.image)
                    .resizable()
                    .frame(width: backdrop.image.size.width, height: backdrop.image.size.height)
                    .offset(x: -backdrop.origin.x, y: -backdrop.origin.y)
                Rectangle().fill(theme.materialWash.opacity(theme.materialWashOpacity))
            }
            Rectangle().fill(theme.tint)
            // A little light from above.
            LinearGradient(colors: [Color.white.opacity(theme.name == .graphite ? 0.06 : 0.18), Color.white.opacity(0)],
                           startPoint: .top, endPoint: UnitPoint(x: 0.5, y: min(1, 70 / max(size.height, 1))))
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .clipShape(shape)
    }
}

/// Hairline edges: a dark outer line that separates the module from light content, a lit inner line along the top.
struct PillEdges<S: InsettableShape>: View {
    let shape: S
    let error: Bool
    @Environment(\.pillTheme) private var theme

    var body: some View {
        ZStack {
            shape.strokeBorder(error ? theme.error.opacity(0.85) : theme.outerStroke, lineWidth: error ? 1.25 : 0.5)
            shape.inset(by: error ? 1.25 : 0.5)
                .strokeBorder(LinearGradient(colors: [theme.innerHighlight, theme.innerShade, theme.innerShade.opacity(0.6)],
                                             startPoint: .top, endPoint: .bottom), lineWidth: 0.5)
        }
    }
}


final class Hover: ObservableObject { @Published var on = false }

/// Shrinks a little while pressed.
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// A round glass button. `active` (a mute that is on) fills it; `accent` tints it (Stop while the agent speaks);
/// `plain` has no fill until hovered.
struct CircleButton: View {
    let symbol: String
    let active: Bool
    var accent: Color? = nil
    var plain = false
    let help: String
    var accessibility: String? = nil
    let action: () -> Void
    @StateObject private var hovering = Hover()
    private var hover: Bool { hovering.on }
    @Environment(\.pillTheme) private var theme
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: symbol == "stop.fill" ? 10.5 : 12, weight: .semibold))
                .foregroundStyle(glyph)
                .frame(width: PillLayout.button, height: PillLayout.button)
                .background(Circle().fill(fill))
                .overlay(Circle().strokeBorder(stroke, lineWidth: 0.5))
                .contentShape(Circle())
        }
        .buttonStyle(PressStyle())
        .onHover { hovering.on = $0 }
        .help(help)
        .accessibilityLabel(accessibility ?? help)
    }

    var glyph: Color {
        if active { return theme.activeGlyph }
        if let accent { return accent }
        return plain ? theme.secondary : theme.glyph.opacity(enabled ? 1 : 0.45)
    }
    var fill: Color {
        if active { return theme.activeFill }
        if let accent { return accent.opacity(hover ? 0.30 : 0.20) }
        if plain { return hover ? theme.buttonFill : .clear }
        return hover ? theme.buttonHover : theme.buttonFill
    }
    var stroke: Color {
        if active || plain { return .clear }
        if let accent { return accent.opacity(0.35) }
        return theme.buttonStroke
    }
}


struct MuteButton: View {
    let muted: Bool
    let agent: Bool
    let expanded: Bool
    let width: CGFloat
    let action: () -> Void
    var title: String { "\(muted ? "Unmute" : "Mute") \(agent ? "agent" : "mic")" }
    var help: String { agent ? title + " voice" : title }
    var symbol: String { agent ? (muted ? "speaker.slash.fill" : "speaker.wave.2.fill") : (muted ? "mic.slash.fill" : "mic.fill") }
    @Environment(\.pillTheme) private var theme
    var body: some View {
        if expanded {
            Button(action: action) {
                HStack(spacing: 4) {
                    if agent { Image(systemName: symbol).font(.system(size: 12, weight: .semibold)) }
                    Text(title).font(.system(size: 11.5, weight: .semibold))
                }
                .fixedSize()
                .foregroundStyle(muted ? theme.activeGlyph : theme.glyph)
                .frame(width: width, height: PillLayout.button)
                .background(Capsule().fill(muted ? theme.activeFill : theme.buttonFill))
                .overlay(Capsule().strokeBorder(muted ? .clear : theme.buttonStroke, lineWidth: 0.5))
                .contentShape(Capsule())
            }
            .buttonStyle(PressStyle()).help(help).accessibilityLabel(help)
        } else {
            CircleButton(symbol: symbol, active: muted, help: help, action: action).frame(width: width)
        }
    }
}


struct SendButton: View {
    let holding: Bool
    let hotkey: String
    var textOnly = false
    let action: () -> Void
    @Environment(\.pillTheme) private var theme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if !textOnly { Image(systemName: "arrow.up").font(.system(size: 10, weight: .bold)) }
                Text("Send")
            }
            .font(.system(size: textOnly ? 11.5 : 12, weight: .semibold))
            .foregroundStyle(holding ? theme.onAccent : theme.secondary)
            .padding(.horizontal, textOnly ? 6 : 12).frame(height: PillLayout.button)
            .background(Capsule().fill(holding ? AnyShapeStyle(LinearGradient(colors: [theme.you, theme.youDeep], startPoint: .top, endPoint: .bottom))
                                               : AnyShapeStyle(theme.buttonFill)))
            .overlay(Capsule().strokeBorder(holding ? Color.white.opacity(0.22) : theme.buttonStroke, lineWidth: 0.5))
            .shadow(color: theme.you.opacity(holding ? theme.glow * 0.6 : 0), radius: 6, y: 1)
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .help("Send what you said (\(hotkey))")
    }
}

// MARK: Visualizer

/// One visualizer for whoever is talking: blue for you, amber for the agent. The newest level is in the
/// middle and older ones ripple outward on both sides, under a soft lens-shaped envelope.
public struct VisualizerView: View {
    let levels: [Double]
    let voice: BrandVoice
    let dimmed: Bool
    var bars = 13
    @Environment(\.pillTheme) private var theme

    public init(levels: [Double], voice: BrandVoice, dimmed: Bool, bars: Int = 13) {
        self.levels = levels; self.voice = voice; self.dimmed = dimmed; self.bars = bars
    }

    public var body: some View {
        GeometryReader { geo in
            let mid = bars / 2
            let w = geo.size.width / (CGFloat(bars) + 0.65 * CGFloat(bars - 1))
            let gap = w * 0.65
            let (top, bottom) = colors
            let peak = levels.suffix(4).max() ?? 0
            HStack(alignment: .center, spacing: gap) {
                ForEach(0..<bars, id: \.self) { i in
                    let d = abs(i - mid)
                    let v = d < levels.count ? levels[levels.count - 1 - d] : 0
                    let envelope = 0.5 + 0.5 * cos(Double(d) / Double(mid + 1) * .pi / 2)
                    let shown = dimmed ? 0 : v * envelope
                    Capsule()
                        .fill(LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom))
                        .frame(width: w, height: max(w, geo.size.height * CGFloat(0.10 + 0.90 * shown)))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .shadow(color: top.opacity(dimmed || voice == .none ? 0 : theme.glow * min(1, 0.35 + peak)), radius: 5)
        }
        .animation(.linear(duration: 0.06), value: levels)
    }

    var colors: (Color, Color) {
        if dimmed { return (theme.idle, theme.idle) }
        switch voice {
        case .you: return (theme.you, theme.youDeep)
        case .agent: return (theme.agent, theme.agentDeep)
        case .none: return (theme.idle, theme.idle)
        }
    }
}

struct DiscardButton: View {
    var compact = false
    var iconOnly = false
    var textOnly = false
    let action: () -> Void
    @Environment(\.pillTheme) private var theme
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if iconOnly || !textOnly { Image(systemName: "arrow.counterclockwise").font(.system(size: 10, weight: .semibold)) }
                if !iconOnly { Text("Discard") }
            }
            .font(.system(size: compact ? 11 : textOnly ? 11.5 : 12, weight: .semibold))
            .foregroundStyle(theme.secondary)
            .padding(.horizontal, iconOnly ? 0 : compact ? 7 : textOnly ? 6 : 10)
            .frame(width: iconOnly ? 28 : nil, height: compact ? 22 : 28)
            .background(Capsule().fill(theme.buttonFill))
            .overlay(Capsule().strokeBorder(theme.buttonStroke, lineWidth: 0.5))
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("Discard and start over")
        .help("Discard and start over")
    }
}
