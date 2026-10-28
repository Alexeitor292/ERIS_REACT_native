import XCTest
@testable import ERISKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Answers requests from a script and records them.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    struct Reply {
        let status: Int
        let body: String
    }

    private let lock = NSLock()
    private var handler: (URLRequest) -> Reply
    private(set) var requests: [URLRequest] = []

    init(_ handler: @escaping (URLRequest) -> Reply) {
        self.handler = handler
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let reply: Reply = lock.locked {
            requests.append(request)
            return handler(request)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        return (Data(reply.body.utf8), response)
    }

    func paths() -> [String] { lock.locked { requests.map { "\($0.httpMethod ?? "") \($0.url!.path)" } } }
}

final class FakeProvider: EntraTokenProvider, @unchecked Sendable {
    var interactive: Result<String, Error> = .success("entra-interactive")
    var silent: Result<String, Error> = .success("entra-silent")
    private(set) var silentCalls = 0

    func acquireTokenInteractively(_ config: EntraMobileConfig) async throws -> String { try interactive.get() }
    func acquireTokenSilently(_ config: EntraMobileConfig) async throws -> String {
        silentCalls += 1
        return try silent.get()
    }
}

let tenant = "11111111-1111-4111-8111-111111111111"
let configJSON = """
{"local_login_enabled": false, "entra_enabled": true, "session_idle_minutes": 30,
 "session_absolute_minutes": 720,
 "entra_mobile": {"authority": "https://login.microsoftonline.com/\(tenant)",
                  "client_id": "55555555-5555-4555-8555-555555555555",
                  "scopes": ["api://22222222-2222-4222-8222-222222222222/access_as_user"]}}
"""
let meJSON = """
{"id": 7, "email": "a@dot.ca.gov", "full_name": "A Person", "roles": ["STAFF"],
 "maintenance_districts": [], "org": {"office_name": "Office of Geotechnical Design", "home_district": "04"},
 "metadata": {"office_code": "X"}}
"""
let base = URL(string: "https://eris.example.test/api")!

final class APIClientTests: XCTestCase {
    func testRequestsGoUnderTheApiPathWithTheBearerHeaderAndNoTokenInTheURL() async throws {
        let transport = FakeTransport { _ in .init(status: 200, body: #"{"items": []}"#) }
        let api = APIClient(baseURL: base, store: MemorySessionStore(token: "eris-session"), transport: transport)
        _ = try await api.get("/incidents", query: [URLQueryItem(name: "scope", value: "mobile")], as: IncidentList.self)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://eris.example.test/api/incidents?scope=mobile")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer eris-session")
        XCTAssertFalse(request.url!.absoluteString.contains("eris-session"))
    }

    func testA401RenewsTheSessionOnceAndRetries() async throws {
        let store = MemorySessionStore(token: "old")
        let transport = FakeTransport { request in
            request.value(forHTTPHeaderField: "Authorization") == "Bearer new"
                ? .init(status: 200, body: meJSON) : .init(status: 401, body: #"{"detail": "Session expired"}"#)
        }
        let api = APIClient(baseURL: base, store: store, transport: transport)
        api.reauthenticate = { store.save("new") }
        let me = try await api.get("/auth/me", as: Me.self)
        XCTAssertEqual(me.fullName, "A Person")
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testAFailedRenewalSignsOutLocally() async {
        let store = MemorySessionStore(token: "old")
        let api = APIClient(baseURL: base, store: store, transport: FakeTransport { _ in .init(status: 401, body: "{}") })
        api.reauthenticate = { throw AuthError.interactionRequired }
        do {
            _ = try await api.get("/auth/me", as: Me.self)
            XCTFail("expected unauthorized")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        XCTAssertNil(store.load())
    }

    func testRefusalsCarryTheServersDetail() async {
        let api = APIClient(baseURL: base, store: MemorySessionStore(token: "t"),
                            transport: FakeTransport { _ in .init(status: 403, body: #"{"detail": "Insufficient permissions"}"#) })
        do {
            _ = try await api.get("/admin/users", as: EmptyResponse.self)
            XCTFail("expected forbidden")
        } catch {
            XCTAssertEqual(error as? APIError, .forbidden("Insufficient permissions"))
        }
    }

    func testIncidentsDecodeFromTheServersSnakeCase() async throws {
        let body = """
        {"items": [{"id": 12, "title": null, "incident_key": "INC-12", "incident_type": "ROCKFALL",
          "district": "04", "county": "ALA", "route": "880", "post_mile": "12.3", "current_stage": "COORDINATOR_REVIEW",
          "status": "NEW", "latitude": 37.8, "longitude": -122.2, "first_observed_at": "2026-10-28T08:00:00",
          "assignment": {"assignee_name": "B Staff", "assignment_stage": "ENGINEER"}, "unknown_new_field": 1}]}
        """
        let api = APIClient(baseURL: base, store: MemorySessionStore(token: "t"),
                            transport: FakeTransport { _ in .init(status: 200, body: body) })
        let incident = try await api.get("/incidents", as: IncidentList.self).items[0]
        XCTAssertEqual(incident.displayTitle, "INC-12")
        XCTAssertEqual(incident.locationLine, "D04 · ALA · 880 · PM 12.3")
        XCTAssertEqual(IncidentLabels.stage(incident.currentStage), "Coordinator review")
        XCTAssertEqual(incident.assignment?.assigneeName, "B Staff")
    }
}

final class AuthServiceTests: XCTestCase {
    func makeService(nativeStatus: Int = 200, config: String = configJSON) -> (AuthService, FakeTransport, FakeProvider) {
        let transport = FakeTransport { request in
            switch request.url!.path {
            case "/api/auth/config": return .init(status: 200, body: config)
            case "/api/auth/entra/native":
                return nativeStatus == 200
                    ? .init(status: 200, body: #"{"access_token": "eris-session", "token_type": "bearer", "expires_at": "2026-10-28T20:00:00Z"}"#)
                    : .init(status: nativeStatus, body: #"{"detail": "No active ERIS account is linked"}"#)
            case "/api/auth/me":
                return request.value(forHTTPHeaderField: "Authorization") == "Bearer eris-session"
                    ? .init(status: 200, body: meJSON) : .init(status: 401, body: "{}")
            default: return .init(status: 200, body: "{}")
            }
        }
        let provider = FakeProvider()
        let api = APIClient(baseURL: base, store: MemorySessionStore(), transport: transport)
        return (AuthService(api: api, provider: provider), transport, provider)
    }

    func testSignInExchangesTheEntraTokenAndKeepsOnlyTheErisSession() async throws {
        let (auth, transport, _) = makeService()
        let me = try await auth.signIn()
        XCTAssertEqual(me.roles, ["STAFF"])
        XCTAssertEqual(auth.api.store.load(), "eris-session")
        let exchange = try XCTUnwrap(transport.requests.first { $0.url!.path == "/api/auth/entra/native" })
        XCTAssertNil(exchange.value(forHTTPHeaderField: "Authorization"))
        let body = try JSONSerialization.jsonObject(with: exchange.httpBody ?? Data()) as? [String: String]
        XCTAssertEqual(body, ["access_token": "entra-interactive"])
    }

    func testAnUnlinkedAccountIsReportedAsSuch() async {
        let (auth, _, _) = makeService(nativeStatus: 403)
        do {
            _ = try await auth.signIn()
            XCTFail("expected notLinked")
        } catch {
            XCTAssertEqual(error as? AuthError, .notLinked)
        }
        XCTAssertNil(auth.api.store.load())
    }

    func testMobileSignInOffOnTheServerIsReported() async {
        let (auth, _, _) = makeService(config: #"{"local_login_enabled": false, "entra_enabled": true, "entra_mobile": null}"#)
        do {
            _ = try await auth.signIn()
            XCTFail("expected mobileSignInDisabled")
        } catch {
            XCTAssertEqual(error as? AuthError, .mobileSignInDisabled)
        }
    }

    func testAnUntrustedAuthorityIsNeverUsed() async {
        let evil = configJSON.replacingOccurrences(of: "login.microsoftonline.com", with: "login.evil.example")
        let (auth, _, _) = makeService(config: evil)
        do {
            _ = try await auth.signIn()
            XCTFail("expected untrustedAuthority")
        } catch {
            XCTAssertEqual(error as? AuthError, .untrustedAuthority)
        }
    }

    func testAnExpiredSessionIsRenewedSilently() async throws {
        let (auth, _, provider) = makeService()
        auth.api.store.save("expired")
        let me = try await auth.me()
        XCTAssertEqual(me.id, 7)
        XCTAssertEqual(provider.silentCalls, 1)
        XCTAssertEqual(auth.api.store.load(), "eris-session")
    }

    func testSignOutUnregistersPushAndEndsOnlyThisSessionWithoutRenewing() async {
        let (auth, transport, provider) = makeService()
        auth.api.store.save("eris-session")
        await auth.signOut(device: DeviceRegistration(token: "ab", platform: "apns"))
        XCTAssertEqual(transport.paths(), ["POST /api/notifications/devices/unregister", "POST /api/auth/logout"])
        XCTAssertNil(auth.api.store.load())
        XCTAssertEqual(provider.silentCalls, 0)
    }

    func testRestoreWithoutASessionDoesNotTouchTheNetwork() async {
        let (auth, transport, _) = makeService()
        let restored = await auth.restore()
        XCTAssertNil(restored)
        XCTAssertTrue(transport.requests.isEmpty)
    }
}
