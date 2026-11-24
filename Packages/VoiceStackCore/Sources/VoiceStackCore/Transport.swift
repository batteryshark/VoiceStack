import Foundation
import Security

public protocol SecretStore { func read() throws -> Data?; func write(_ data: Data) throws; func remove() throws }
public extension SecretStore {
    // Keychain may wait for a system authorization dialog after an app is rebuilt.
    // Keep that synchronous wait off the UI actor without bypassing its ACL.
    func readAsync() async throws -> Data? { try await Task.detached { try self.read() }.value }
    func writeAsync(_ data: Data) async throws { try await Task.detached { try self.write(data) }.value }
    func removeAsync() async throws { try await Task.detached { try self.remove() }.value }
}
public final class KeychainStore: SecretStore {
    private let service: String
    private let account: String
    public init(service: String, account: String = "device") { self.service = service; self.account = account }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] }
    public func read() throws -> Data? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }; guard status == errSecSuccess else { throw VoiceError.unauthorized }; return result as? Data
    }
    public func write(_ data: Data) throws {
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            let add = query.merging(attrs) { _, new in new }; guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw VoiceError.unauthorized }
        } else if status != errSecSuccess { throw VoiceError.unauthorized }
    }
    public func remove() throws { let status = SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw VoiceError.unauthorized } }
}
public struct Enrollment: Codable {
    public let base: URL
    public let installationId: UUID
    public let device: PairResponse
    public var acknowledged: Bool
    public let acknowledgement: Mutation
}
public final class SwitchboardClient {
    public let base: URL
    public var credential: String?
    public let session: URLSession
    public init(base: URL, credential: String? = nil, session: URLSession = SecureSession.shared) throws {
        try SecureAddress.validate(base, scheme: "https"); self.base = base; self.credential = credential; self.session = session
    }
    public func request(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        var req = URLRequest(url: base.appendingPathComponent(path)); req.httpMethod = method; req.httpBody = body; req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type"); if let credential { req.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization") }
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: req) } catch { throw VoiceError.uncertain }
        guard let http = response as? HTTPURLResponse else { throw VoiceError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let obj = try? Wire.object(data); let code = (obj?["error"] as? [String: Any])?["code"] as? String ?? "request_failed"
            // Display only known codes, never arbitrary server text that might contain credentials.
            let allowed = ["unauthorized", "forbidden", "validation_error", "operation_conflict", "call_taken", "call_not_active", "target_unavailable", "backend_unavailable", "token_active", "token_revoked", "profile_unsupported"]
            throw VoiceError.server(allowed.contains(code) ? code : "request_failed")
        }; return data
    }
    public func perform(_ mutation: Mutation) async throws -> Data { try await request(mutation.method, mutation.path, body: mutation.body) }
    public func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T { try Wire.decoder.decode(type, from: await request("GET", path)) }
    public func socket(_ address: URL) throws -> JSONSocket {
        try SecureAddress.validate(address, scheme: "wss"); guard let credential else { throw VoiceError.unauthorized }
        return JSONSocket(address: address, credential: credential, session: session)
    }
}
public final class Pairing {
    private let store: SecretStore
    private let session: URLSession
    public init(store: SecretStore, session: URLSession = SecureSession.shared) { self.store = store; self.session = session }
    public func restore() throws -> Enrollment? { try store.read().map { try Wire.decoder.decode(Enrollment.self, from: $0) } }
    public func restoreAsync() async throws -> Enrollment? { try await store.readAsync().map { try Wire.decoder.decode(Enrollment.self, from: $0) } }
    public func enroll(client: SwitchboardClient, code: String, name: String, platform: String, replacing: Bool = false) async throws -> Enrollment {
        if !replacing, let old = try await restoreAsync() { return try await reconcile(old) }
        let installation = UUID()
        let body = try Wire.data(["profile": VoiceProfile.app, "pairing_code": code, "device": ["installation_id": installation.uuidString.lowercased(), "name": name, "platform": platform, "app_version": "0.1.0"]])
        let device = try Wire.decoder.decode(PairResponse.self, from: await client.request("POST", "pair", body: body))
        guard device.profile == VoiceProfile.app else { throw VoiceError.unsupportedProfile }
        let ack = try Mutation(method: "POST", path: "pair/ack", fields: ["installation_id": installation.uuidString.lowercased()])
        let enrollment = Enrollment(base: client.base, installationId: installation, device: device, acknowledged: false, acknowledgement: ack)
        try await store.writeAsync(Wire.encoder.encode(enrollment)) // Must succeed before any acknowledgement.
        return try await reconcile(enrollment)
    }
    public func reconcile(_ enrollment: Enrollment) async throws -> Enrollment {
        var e = enrollment; let client = try SwitchboardClient(base: e.base, credential: e.device.deviceCredential, session: session)
        let me = try Wire.object(await client.request("GET", "me"))
        guard me["device_id"] as? String == e.device.deviceId else { throw VoiceError.unauthorized }
        guard let acknowledged = me["acknowledged"] as? Bool else { throw VoiceError.invalidResponse }
        if !acknowledged { _ = try await client.perform(e.acknowledgement) }
        e.acknowledged = true; try await store.writeAsync(Wire.encoder.encode(e)); return e
    }
}
public final class JSONSocket {
    private let task: URLSessionWebSocketTask
    public init(address: URL, credential: String, session: URLSession = SecureSession.shared, livePreview: Bool = false) {
        var req = URLRequest(url: address); req.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        if livePreview { req.setValue("snapshots-v1", forHTTPHeaderField: "X-VoiceStack-Live-Preview") }
        task = session.webSocketTask(with: req); task.maximumMessageSize = 1024 * 1024; task.resume()
    }
    public func send(_ object: [String: Any]) async throws { try await send(data: Wire.data(object)) }
    public func send(data: Data) async throws { guard let text = String(data: data, encoding: .utf8) else { throw VoiceError.invalidResponse }; try await task.send(.string(text)) }
    public func receive() async throws -> [String: Any] {
        switch try await task.receive() { case .string(let text): return try Wire.object(Data(text.utf8)); case .data: throw VoiceError.invalidResponse; @unknown default: throw VoiceError.invalidResponse }
    }
    public func close() { task.cancel(with: .normalClosure, reason: nil) }
    deinit { close() }
}

/// Never follow a credential-bearing HTTP request onto another route or origin.
public enum SecureSession {
    private final class Delegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private static let delegate = Delegate()
    public static let shared: URLSession = {
        let config = URLSessionConfiguration.ephemeral; config.urlCache = nil; config.httpCookieStorage = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }()
}
