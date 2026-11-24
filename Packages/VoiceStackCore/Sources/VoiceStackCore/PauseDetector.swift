import Foundation

/// Energy-only pause detection for the standard Realtime input. Retains the
/// original client's 20 ms frames, adaptive noise floor and 8-of-12 speech onset.
/// It does not import its recognizer, transport or conversation controller.
public struct PauseDetector {
    public var pauseSeconds: Double
    public var sensitivity: Sensitivity
    public private(set) var heardSpeech = false
    public private(set) var silenceSeconds = 0.0
    private var floor = NoiseFloor()
    private var recent: [Bool] = []
    private var buffer = Data()
    private var finished = false
    public init(pauseSeconds: Double = 3.2, sensitivity: Sensitivity = .normal) {
        self.pauseSeconds = pauseSeconds; self.sensitivity = sensitivity
    }
    public mutating func append(_ pcm: Data) -> Bool {
        guard !finished else { return false }
        buffer.append(pcm)
        while buffer.count >= 960 {
            let frame = buffer.prefix(960); buffer = Data(buffer.dropFirst(960))
            let rms = frame.withUnsafeBytes { raw -> Double in
                var sum = 0.0
                for i in stride(from: 0, to: 960, by: 2) { let v = Double(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i, as: Int16.self))) / 32768; sum += v * v }
                return sqrt(sum / 480)
            }
            let voiced = rms > floor.threshold(base: 0.012, factor: sensitivity.factor)
            floor.add(rms, inUtterance: heardSpeech)
            if !heardSpeech {
                recent.append(voiced); if recent.count > 12 { recent.removeFirst() }
                heardSpeech = recent.filter { $0 }.count >= 8
            }
            if heardSpeech {
                silenceSeconds = voiced ? 0 : silenceSeconds + 0.02
                if silenceSeconds + 0.000001 >= max(0.5, pauseSeconds) { finished = true; return true }
            }
        }
        return false
    }
}
