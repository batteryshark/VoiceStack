import Foundation

/// Display height only; never changes captured PCM or playback volume.
public enum AudioLevel {
    // Original PillModel scale: -50 dBFS is flat; -10 dBFS is full.
    public static func height(rms: Double) -> Double {
        guard rms.isFinite, rms > 0 else { return 0 }
        return min(1, max(0, (20 * log10(rms) + 50) / 40))
    }
}
