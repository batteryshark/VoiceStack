import AVFoundation
import Foundation
import VoiceStackCore
#if os(macOS)
import CoreAudio
import AudioToolbox
#endif

final class NativeAudio {
    private let engine: AVAudioEngine
    private let player = AVAudioPlayerNode()
    private let lock = NSLock()
    private var onFrame: ((Data) -> Void)?
    private var converter: AVAudioConverter?
    private var target: AVAudioFormat?
    private var capturedBytes = 0
    private var recording = false
    private var tapped = false
    private var playbackGeneration = UUID()
    private var playbackBuffers = 0
    private var inputPeak = 0.0
    private var outputPeak = 0.0
    var onPlaybackIdle: (() -> Void)?
    var hasPendingPlayback: Bool { lock.lock(); defer { lock.unlock() }; return playbackBuffers > 0 }
    private var isMuted = false
    var muted: Bool {
        get { lock.lock(); defer { lock.unlock() }; return isMuted }
        set { lock.lock(); isMuted = newValue; lock.unlock() }
    }
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    init(engine: AVAudioEngine = AVAudioEngine()) {
        self.engine = engine
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        // Observe rendered audio, not arriving HTTP chunks. A fully buffered
        // reply must keep moving the waveform throughout playback.
        player.installTap(onBus: 0, bufferSize: 480, format: format) { [weak self] buffer, _ in
            guard let self, let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            var sum = 0.0
            for i in 0..<Int(buffer.frameLength) { let v = Double(samples[i]); sum += v * v }
            let rms = sqrt(sum / Double(buffer.frameLength))
            self.lock.lock(); defer { self.lock.unlock() }
            if self.playbackBuffers > 0 { self.outputPeak = max(self.outputPeak, rms) }
        }
    }
    /// One display tick consumes peaks since the preceding tick. No audio is retained.
    func takeLevels() -> (input: Double, output: Double) {
        lock.lock(); defer { lock.unlock() }
        let levels = (input: recording && !isMuted ? inputPeak : 0, output: playbackBuffers > 0 ? outputPeak : 0)
        inputPeak = 0; outputPeak = 0
        return levels
    }
    func startCapture(onFrame: @escaping (Data) -> Void) throws {
        stopPlayback()
        #if os(iOS)
        // CallKit owns activation for system calls; outgoing calls are started through CallKit too.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        #endif
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target) else { throw VoiceError.invalidState }
        lock.lock(); self.onFrame = onFrame; self.converter = converter; self.target = target; capturedBytes = 0; inputPeak = 0; recording = true; lock.unlock()
        input.installTap(onBus: 0, bufferSize: 1024, format: source) { [weak self] buffer, _ in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard self.recording else { return }
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 24000 / source.sampleRate) + 32)
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false; var error: NSError?
            converter.convert(to: output, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }; supplied = true; status.pointee = .haveData; return buffer
            }
            guard error == nil, let samples = output.int16ChannelData else { return }
            let bytes = Data(bytes: samples[0], count: Int(output.frameLength) * 2)
            self.capturedBytes += bytes.count
            if output.frameLength > 0, !self.isMuted {
                var sum = 0.0
                for i in 0..<Int(output.frameLength) { let v = Double(samples[0][i]) / 32768; sum += v * v }
                self.inputPeak = max(self.inputPeak, sqrt(sum / Double(output.frameLength)))
            }
            self.onFrame?(self.isMuted ? Data(count: bytes.count) : bytes)
        }
        tapped = true
        if !engine.isRunning { try engine.start() }
    }
    func finishCapture() -> Int {
        lock.lock()
        if recording, let converter, let target, let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 4096) {
            var error: NSError?
            converter.convert(to: output, error: &error) { _, status in status.pointee = .endOfStream; return nil }
            if error == nil, output.frameLength > 0, let samples = output.int16ChannelData {
                let bytes = Data(bytes: samples[0], count: Int(output.frameLength) * 2); capturedBytes += bytes.count; onFrame?(isMuted ? Data(count: bytes.count) : bytes)
            }
        }
        recording = false; inputPeak = 0; onFrame = nil; converter = nil; target = nil; let count = capturedBytes; capturedBytes = 0; lock.unlock()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }; return count
    }
    func play(_ pcm: Data) throws {
        guard !pcm.isEmpty, pcm.count % 2 == 0 else { throw VoiceError.invalidResponse }
        let frames = pcm.count / 2
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)), let channel = buffer.floatChannelData?[0] else { throw VoiceError.invalidResponse }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in for i in 0..<frames { channel[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768 } }
        if !engine.isRunning { try engine.start() }
        lock.lock(); let generation = playbackGeneration; playbackBuffers += 1; lock.unlock()
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            guard self.playbackGeneration == generation else { self.lock.unlock(); return }
            self.playbackBuffers -= 1; let idle = self.playbackBuffers == 0; self.lock.unlock()
            if idle { self.onPlaybackIdle?() }
        }
        if !player.isPlaying { player.play() }
    }
    func stopPlayback() { lock.lock(); playbackGeneration = UUID(); playbackBuffers = 0; outputPeak = 0; lock.unlock(); player.stop() }
    func stop() { _ = finishCapture(); stopPlayback(); engine.stop() }
    #if os(iOS)
    func speaker(_ enabled: Bool) throws { try AVAudioSession.sharedInstance().overrideOutputAudioPort(enabled ? .speaker : .none) }
    #endif
    #if os(macOS)
    struct Device: Identifiable { let id: AudioDeviceID; let name: String }
    static func devices(input: Bool) -> [Device] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            var stream = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
            var count: UInt32 = 0; guard AudioObjectGetPropertyDataSize(id, &stream, 0, nil, &count) == noErr, count > 0 else { return nil }
            var name: Unmanaged<CFString>?; var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            var prop = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectGetPropertyData(id, &prop, 0, nil, &nameSize, &name) == noErr, let name else { return nil }; return Device(id: id, name: name.takeRetainedValue() as String)
        }
    }
    func selectDevice(_ id: AudioDeviceID, input: Bool) throws {
        guard !engine.isRunning else { throw VoiceError.invalidState }
        let unit = input ? engine.inputNode.audioUnit : engine.outputNode.audioUnit
        guard let unit else { throw VoiceError.invalidState }; var id = id
        if id == 0 {
            var prop = AudioObjectPropertyAddress(mSelector: input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var size = UInt32(MemoryLayout<AudioDeviceID>.size)
            guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &prop, 0, nil, &size, &id) == noErr else { throw VoiceError.invalidState }
        }
        guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else { throw VoiceError.invalidState }
    }
    #endif
}
