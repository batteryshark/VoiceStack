import XCTest
@testable import VoiceStackCore

final class AudioLevelTests: XCTestCase {
    func testQuietSpeechHasTheOriginalVisibleLogarithmicHeight() {
        // Original PillModel: -50 dBFS is flat and -10 dBFS is full.
        // At -40 dBFS the 28pt iPhone waveform must be 7pt, above its ~4pt idle dot.
        XCTAssertEqual(AudioLevel.height(rms: 0.01) * 28, 7, accuracy: 0.001)
        XCTAssertEqual(AudioLevel.height(rms: 0.1), 0.75, accuracy: 0.001)
        XCTAssertEqual(AudioLevel.height(rms: 0), 0)
        XCTAssertEqual(AudioLevel.height(rms: 0.001), 0)
        XCTAssertEqual(AudioLevel.height(rms: 1), 1)
    }
}
