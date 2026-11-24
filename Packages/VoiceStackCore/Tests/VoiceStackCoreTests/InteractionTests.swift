import XCTest
import CoreGraphics
@testable import VoiceStackCore

final class InteractionTests: XCTestCase {
    private func pcm(_ amplitude: Int16, frames: Int) -> Data {
        var data = Data()
        for _ in 0..<(frames * 480) { var sample = amplitude.littleEndian; withUnsafeBytes(of: &sample) { data.append(contentsOf: $0) } }
        return data
    }
    func testPauseSendsAfterSpeechWithoutWaitingForCredentialLimit() {
        var detector = PauseDetector(pauseSeconds: 1.5)
        XCTAssertFalse(detector.append(pcm(0, frames: 100)))
        XCTAssertFalse(detector.append(pcm(4000, frames: 40)))
        XCTAssertTrue(detector.heardSpeech)
        XCTAssertFalse(detector.append(pcm(0, frames: 74)))
        XCTAssertTrue(detector.append(pcm(0, frames: 1)))
        XCTAssertFalse(detector.append(pcm(0, frames: 100)))
    }
    func testPauseResetsWhenSpeechResumesAndIgnoresQuietInput() {
        var detector = PauseDetector(pauseSeconds: 1.5)
        XCTAssertFalse(detector.append(pcm(100, frames: 300)))
        XCTAssertFalse(detector.heardSpeech)
        XCTAssertFalse(detector.append(pcm(5000, frames: 20)))
        XCTAssertFalse(detector.append(pcm(0, frames: 60)))
        XCTAssertFalse(detector.append(pcm(5000, frames: 10)))
        XCTAssertFalse(detector.append(pcm(0, frames: 60)))
        XCTAssertTrue(detector.append(pcm(0, frames: 15)))
    }
    func testPauseDetectionIsIndependentOfAudioChunkBoundaries() {
        let input = pcm(0, frames: 75) + pcm(5000, frames: 25) + pcm(0, frames: 100)
        var whole = PauseDetector(pauseSeconds: 1.5), split = PauseDetector(pauseSeconds: 1.5)
        XCTAssertTrue(whole.append(input))
        var sends = 0
        for offset in stride(from: 0, to: input.count, by: 713) {
            if split.append(input.subdata(in: offset..<min(offset + 713, input.count))) { sends += 1 }
        }
        XCTAssertEqual(sends, 1)
    }
    func testPanelExpansionRetainsControlsInsideTheVisibleDesktop() {
        let screen = CGRect(x: 0, y: 48, width: 1440, height: 830)
        let lowPill = CGRect(x: 80, y: 100, width: 182, height: 44)
        // This was the shipped resize calculation; it puts End/Send below the screen.
        let old = CGRect(x: lowPill.minX, y: lowPill.maxY - 602, width: 360, height: 602)
        XCTAssertFalse(screen.contains(old))
        let fixed = FloatingPanelGeometry.frame(current: lowPill, desired: CGSize(width: 360, height: 602), visible: screen)
        XCTAssertTrue(screen.contains(fixed))
        let secondDisplay = CGRect(x: -1440, y: -200, width: 1440, height: 900)
        let edge = CGRect(x: -80, y: -190, width: 182, height: 44)
        XCTAssertTrue(secondDisplay.contains(FloatingPanelGeometry.frame(current: edge, desired: CGSize(width: 420, height: 640), visible: secondDisplay)))
    }
}
