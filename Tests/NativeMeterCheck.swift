import Foundation
import AVFoundation
import VoiceStackCore

@main struct NativeMeterCheck {
    @MainActor static func main() async throws {
        // Render offline: no microphone, speaker, network, or agent conversation.
        let engine = AVAudioEngine()
        let audio = NativeAudio(engine: engine)
        let model = VoiceModel(automaticallyListen: false, audio: audio)
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 2400)
        var pcm = Data()
        for sample in 0..<48000 {
            let amplitude = (sample / 4800) % 2 == 0 ? 0.1 : 0.0
            var value = Int16(amplitude * 32767 * sin(Double(sample) * 2 * .pi * 440 / 24000)).littleEndian
            withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
        }
        try audio.play(pcm) // Entire reply arrives at once; it still plays for two seconds.
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2400)!
        var latePeaks = 0, lateSilences = 0, renderedSound = 0
        for step in 0..<24 {
            let status = try engine.renderOffline(2400, to: buffer)
            guard status == .success else { continue }
            if let values = buffer.floatChannelData?[0], (0..<Int(buffer.frameLength)).contains(where: { abs(values[$0]) > 0.02 }) { renderedSound += 1 }
            try await Task.sleep(for: .milliseconds(60)) // Let both the tap and actual model display clock run.
            let level = model.outputLevels.suffix(2).max() ?? 0
            if step >= 5 { if level > 0.02 { latePeaks += 1 } else { lateSilences += 1 } }
        }
        model.stopReply()
        precondition(model.outputLevels.allSatisfy { $0 == 0 }, "Stopping playback must reset the published waveform")
        let stopped = audio.takeLevels().output
        guard renderedSound > 5, latePeaks > 3, lateSilences > 3, stopped == 0 else {
            print("FAIL: audio rendered but waveform did not follow later playback: sound=\(renderedSound), late peaks=\(latePeaks), late silence=\(lateSilences), stopped=\(stopped)")
            exit(1)
        }
        print("PASS: one buffered reply drives continuing published waveform peaks and silence on the model display clock; stop clears levels.")
    }
}
