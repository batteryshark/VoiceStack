import SwiftUI

struct SettingsChoice: Hashable { let id: String; let label: String }

/// A chip that opens a menu of choices (the selected one checked).
struct ChoiceMenu: View {
    let title: String
    let choices: [SettingsChoice]
    let selected: String
    let pick: (String) -> Void
    @Environment(\.pillTheme) private var theme

    var body: some View {
        Menu {
            ForEach(choices, id: \.self) { c in
                Button { pick(c.id) } label: {
                    if c.id == selected { Label(c.label, systemImage: "checkmark") } else { Text(c.label) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(title).lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 7.5, weight: .bold)).foregroundStyle(theme.secondary)
            }
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(theme.primary)
            .padding(.horizontal, 10).frame(height: 24)
            .background(Capsule().fill(theme.buttonFill))
            .overlay(Capsule().strokeBorder(theme.buttonStroke, lineWidth: 0.5))
            .frame(maxWidth: 196, alignment: .trailing)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct IconChip: View {
    let symbol: String
    let help: String
    let action: () -> Void
    @Environment(\.pillTheme) private var theme

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.you)
                .frame(width: 24, height: 24)
                .background(Circle().fill(theme.you.opacity(0.16)))
                .overlay(Circle().strokeBorder(theme.you.opacity(0.3), lineWidth: 0.5))
                .contentShape(Circle())
        }
        .buttonStyle(PressStyle())
        .help(help)
    }
}

struct PlainChip: View {
    let symbol: String
    let label: String
    let action: () -> Void
    @Environment(\.pillTheme) private var theme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
                Text(label)
            }
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(theme.primary.opacity(0.9))
            .padding(.horizontal, 11).frame(height: 26)
            .background(Capsule().fill(theme.buttonFill))
            .overlay(Capsule().strokeBorder(theme.buttonStroke, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
    }
}

/// Capsule segmented choice, drawn in SwiftUI. `stretch` spreads the segments over the full width.
struct Segmented: View {
    let options: [(String, String)]
    let selected: String
    var stretch = false
    let pick: (String) -> Void
    @Environment(\.pillTheme) private var theme

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { id, label in
                Button { pick(id) } label: {
                    Text(label)
                        .font(.system(size: 11, weight: id == selected ? .semibold : .medium))
                        .foregroundStyle(id == selected ? theme.segmentText : theme.primary.opacity(0.78))
                        .lineLimit(1)
                        .padding(.horizontal, 8).frame(height: 22)
                        .frame(maxWidth: stretch ? .infinity : nil)
                        .background(Capsule().fill(id == selected ? theme.segmentFill : Color.clear)
                            .shadow(color: .black.opacity(id == selected ? 0.18 : 0), radius: 1.5, y: 0.5))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Capsule().fill(theme.buttonFill))
        .overlay(Capsule().strokeBorder(theme.buttonStroke, lineWidth: 0.5))
    }
}
