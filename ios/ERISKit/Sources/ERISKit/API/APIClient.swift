import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A refused or failed API call.
public enum APIError: Error, Equatable, Sendable {
    /// No session, or the session ended and could not be renewed.
    case unauthorized
    case forbidden(String?)
    case notFound
    case server(Int)
    case http(Int, String?)
    /// A refusal whose detail is an object (a save conflict, a locked memo):
    /// status, its message, and the detail itself.
    case refused(Int, String?, [String: JSONValue])
    case invalidResponse
    case decoding(String)
    case transport(String)
}

/// Sends one HTTP request. A protocol so tests can answer without a network.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: APIError.transport(error.localizedDescription))
                    return
                }
                guard let http = response as? HTTPURLResponse else {
                    continuation.resume(throwing: APIError.invalidResponse)
                    return
                }
                continuation.resume(returning: (data ?? Data(), http))
            }
            task.resume()
        }
    }
}

/// Where the ERIS session credential is kept. The app uses the Keychain.
public protocol SessionStore: AnyObject, Sendable {
    func load() -> String?
    func save(_ token: String)
    func clear()
}

public final class MemorySessionStore: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?

    public init(token: String? = nil) {
        self.token = token
    }

    public func load() -> String? { lock.locked { token } }
    public func save(_ token: String) { lock.locked { self.token = token } }
    public func clear() { lock.locked { token = nil } }
}

/// A response body the caller does not need.
public struct EmptyResponse: Decodable, Equatable, Sendable {
    public init() {}
}

/// Runs one session renewal at a time: concurrent 401s share it.
actor RenewalGate {
    private var running: Task<Void, Error>?

    func run(_ work: @escaping @Sendable () async throws -> Void) async throws {
        if let running {
            return try await running.value
        }
        let task = Task { try await work() }
        running = task
        defer { running = nil }
        try await task.value
    }
}

/// The ERIS API, under `https://<web-host>/api`.
///
/// Sends `Authorization: Bearer <ERIS session>` and never puts a token in a
/// URL. On a 401 it renews the session once (silent Entra sign-in and
/// exchange, through `reauthenticate`) and retries; if that fails, the stored
/// session is cleared and `.unauthorized` is thrown so the app shows sign-in.
public final class APIClient: @unchecked Sendable {
    public let baseURL: URL
    public let store: SessionStore
    private let transport: HTTPTransport
    private let gate = RenewalGate()
    private let lock = NSLock()
    private var renew: (@Sendable () async throws -> Void)?

    let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    /// For responses whose keys are data, not field names (a GISA form): keys
    /// stay exactly as the server sent them.
    let rawDecoder = JSONDecoder()

    let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    public init(baseURL: URL, store: SessionStore, transport: HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.store = store
        self.transport = transport
    }

    /// Renews the session after a 401; set by `AuthService`.
    public var reauthenticate: (@Sendable () async throws -> Void)? {
        get { lock.locked { renew } }
        set { lock.locked { renew = newValue } }
    }

    public func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], preservingKeys: Bool = false,
                                  as type: T.Type = T.self) async throws -> T {
        try await request("GET", path, query: query, preservingKeys: preservingKeys, as: type)
    }

    public func post<T: Decodable, Body: Encodable>(_ path: String, json body: Body, as type: T.Type = T.self) async throws -> T {
        try await request("POST", path, body: try encoder.encode(body), as: type)
    }

    public func patch<T: Decodable, Body: Encodable>(_ path: String, json body: Body, as type: T.Type = T.self) async throws -> T {
        try await request("PATCH", path, body: try encoder.encode(body), as: type)
    }

    public func request<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String = "application/json",
        authenticated: Bool = true,
        allowRenewal: Bool = true,
        preservingKeys: Bool = false,
        as type: T.Type = T.self
    ) async throws -> T {
        var renewed = false
        while true {
            let request = try makeRequest(method, path, query: query, body: body, contentType: contentType,
                                          authenticated: authenticated)
            let (data, response) = try await transport.send(request)
            switch response.statusCode {
            case 200..<300:
                return try decode(type, from: data, preservingKeys: preservingKeys)
            case 401:
                if authenticated, allowRenewal, !renewed, let renew = reauthenticate {
                    renewed = true
                    do {
                        try await gate.run(renew)
                    } catch {
                        store.clear()
                        throw APIError.unauthorized
                    }
                    continue
                }
                if authenticated { store.clear() }
                throw APIError.unauthorized
            case 403:
                throw APIError.forbidden(detail(in: data))
            case 404:
                throw APIError.notFound
            case 500...:
                throw APIError.server(response.statusCode)
            default:
                if case .object(let structured)? = (try? rawDecoder.decode([String: JSONValue].self, from: data))?["detail"] {
                    throw APIError.refused(response.statusCode, detail(in: data), structured)
                }
                throw APIError.http(response.statusCode, detail(in: data))
            }
        }
    }

    func makeRequest(_ method: String, _ path: String, query: [URLQueryItem], body: Data?, contentType: String,
                     authenticated: Bool) throws -> URLRequest {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        let suffix = path.hasPrefix("/") ? path : "/" + path
        guard var components = URLComponents(string: base + suffix) else { throw APIError.invalidResponse }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        if authenticated, let token = store.load() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data, preservingKeys: Bool = false) throws -> T {
        let payload = data.isEmpty ? Data("{}".utf8) : data
        do {
            return try (preservingKeys ? rawDecoder : decoder).decode(type, from: payload)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private func detail(in data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let text = object["detail"] as? String { return text }
        if let structured = object["detail"] as? [String: Any], let message = structured["message"] as? String {
            return message
        }
        return nil
    }
}

extension NSLock {
    /// `withLock` is not available on every Foundation this package builds with.
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
