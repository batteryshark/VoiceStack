import XCTest
@testable import VoiceStackCore

private final class MemoryStore: SecretStore {
    var data: Data?
    var rejectWrites = false
    var requireBackground = false
    func read() throws -> Data? { if requireBackground { XCTAssertFalse(Thread.isMainThread) }; return data }
    func write(_ data: Data) throws { if requireBackground { XCTAssertFalse(Thread.isMainThread) }; if rejectWrites { throw VoiceError.unauthorized }; self.data = data }
    func remove() throws { if requireBackground { XCTAssertFalse(Thread.isMainThread) }; data = nil }
}
private final class PairProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let data = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
final class PairingTests: XCTestCase {
    @MainActor func testSecretStoreOperationsLeaveUIThread() async throws {
        let store = MemoryStore(); store.requireBackground = true
        try await store.writeAsync(Data("fixture".utf8))
        let restored = try await store.readAsync(); XCTAssertEqual(restored, Data("fixture".utf8))
        try await store.removeAsync(); let removed = try await store.readAsync(); XCTAssertNil(removed)
    }
    func testChangingServerRequiresExplicitReplacementAndPreservesOldEnrollmentOnFailure() async throws {
        let store = MemoryStore(); let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [PairProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let old = URL(string: "https://old.fixture.invalid/voicestack/v1")!
        let new = URL(string: "https://new.fixture.invalid/voicestack/v1")!
        var rejectNew = false, pairCount = 0
        PairProtocol.handler = { req in
            let host = req.url!.host!
            switch req.url!.lastPathComponent {
            case "pair":
                pairCount += 1
                if rejectNew && host == new.host { throw URLError(.cannotConnectToHost) }
                return try Wire.data(["device_id": host, "device_credential": "fixture-\(host)", "profile": VoiceProfile.app, "paired_at": "2026-10-29T00:00:00Z"])
            case "me": return try Wire.data(["device_id": host, "acknowledged": true])
            default: throw VoiceError.invalidResponse
            }
        }
        let pairing = Pairing(store: store, session: session)
        _ = try await pairing.enroll(client: SwitchboardClient(base: old, session: session), code: "fixture", name: "Test", platform: "macos")
        _ = try await pairing.enroll(client: SwitchboardClient(base: new, session: session), code: "fixture", name: "Test", platform: "macos")
        XCTAssertEqual(pairCount, 1); XCTAssertEqual(try pairing.restore()?.base, old)
        rejectNew = true
        do { _ = try await pairing.enroll(client: SwitchboardClient(base: new, session: session), code: "fixture", name: "Test", platform: "macos", replacing: true); XCTFail("Expected failure") } catch {}
        XCTAssertEqual(try pairing.restore()?.base, old)
        rejectNew = false
        _ = try await pairing.enroll(client: SwitchboardClient(base: new, session: session), code: "fixture", name: "Test", platform: "macos", replacing: true)
        XCTAssertEqual(try pairing.restore()?.base, new); XCTAssertEqual(pairCount, 3)
    }
    func testPersistBeforeAckAndRecoverLostAcknowledgementAfterRestart() async throws {
        let store = MemoryStore(); let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [PairProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let base = URL(string: "https://switchboard.fixture.invalid/voicestack/v1")!
        var pairCount = 0, ackCount = 0, paired = false
        PairProtocol.handler = { req in
            switch req.url!.lastPathComponent {
            case "pair":
                pairCount += 1
                return try Wire.data(["device_id": "dev_test", "device_credential": "fixture-device", "profile": VoiceProfile.app, "paired_at": "2026-10-29T00:00:00Z"])
            case "me":
                XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-device")
                return try Wire.data(["device_id": "dev_test", "acknowledged": paired])
            case "ack":
                XCTAssertNotNil(store.data); ackCount += 1; paired = true; throw URLError(.networkConnectionLost)
            default: throw VoiceError.invalidResponse
            }
        }
        let first = Pairing(store: store, session: session)
        do { _ = try await first.enroll(client: SwitchboardClient(base: base, session: session), code: "fixture", name: "Test", platform: "macos"); XCTFail("Expected uncertain acknowledgement") } catch { XCTAssertEqual(error as? VoiceError, .uncertain) }
        let restarted = Pairing(store: store, session: session)
        let pending = try XCTUnwrap(restarted.restore()); XCTAssertFalse(pending.acknowledged)
        let recovered = try await restarted.reconcile(pending)
        XCTAssertTrue(recovered.acknowledged); XCTAssertEqual(pairCount, 1); XCTAssertEqual(ackCount, 1)
        XCTAssertEqual(try restarted.restore()?.device.deviceCredential, "fixture-device")
    }
    func testKeychainRoundTripAcrossStoreInstances() throws {
        let name = "VoiceStack.tests.\(UUID().uuidString)"
        let first = KeychainStore(service: name); defer { try? first.remove() }
        let data = Data("fixture-test-only".utf8)
        try first.write(data)
        XCTAssertEqual(try KeychainStore(service: name).read(), data)
        try first.write(Data("fixture-replaced".utf8))
        XCTAssertEqual(try KeychainStore(service: name).read(), Data("fixture-replaced".utf8))
        try first.remove(); XCTAssertNil(try KeychainStore(service: name).read())
    }
}
