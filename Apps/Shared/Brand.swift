import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct BrandIcon: View {
    var body: some View {
        if let url = Bundle.main.url(forResource: "AppIcon-1024", withExtension: "png") {
            #if os(macOS)
            if let icon = NSImage(contentsOf: url) { Image(nsImage: icon).resizable().renderingMode(.original) }
            #else
            if let icon = UIImage(contentsOfFile: url.path) { Image(uiImage: icon).resizable().renderingMode(.original) }
            #endif
        }
    }
}

public enum BrandVoice { case none, you, agent }
enum VoiceBrand {
    static let blue = Color(red: 0.42, green: 0.73, blue: 1)
    static let amber = Color(red: 1, green: 0.72, blue: 0.36)
}

// Original iPhone lens/ripple geometry, rebound to the new app's PCM levels.
struct NativeWaveform: View {
    let levels: [Double]
    let voice: BrandVoice
    let ready: Bool
    var body: some View {
        GeometryReader { geo in
            let color: Color = !ready || voice == .none ? .gray : (voice == .agent ? VoiceBrand.amber : VoiceBrand.blue)
            let count = 25, mid = count / 2
            let width = geo.size.width / (CGFloat(count) * 1.65 - 0.65)
            HStack(spacing: width * 0.65) {
                ForEach(0..<count, id: \.self) { index in
                    let distance = abs(index - mid)
                    let value = ready && distance < levels.count ? levels[levels.count - 1 - distance] : 0
                    let lens = 0.5 + 0.5 * cos(Double(distance) / Double(mid + 1) * .pi / 2)
                    Capsule().fill(color.gradient).frame(width: width, height: max(width, geo.size.height * value * lens))
                }
            }.frame(width: geo.size.width, height: geo.size.height)
        }.animation(.linear(duration: 0.06), value: levels)
    }
}
