import Foundation

public enum AuthError: Error, Equatable, Sendable {
    /// The server has no ERIS Mobile client configured.
    case mobileSignInDisabled
    /// The server named an authority that is not Microsoft Entra.
    case untrustedAuthority
    /// Entra signed the person in, but no active ERIS account is linked.
    case notLinked
    /// ERIS could not verify the Entra token.
    case notVerified
    /// Silent sign-in is impossible; the person must sign in interactively.
    case interactionRequired
    case cancelled
}

/// Gets an Entra access token for the ERIS API scope. The app implements it
/// with MSAL through Microsoft Authenticator; tests use a fake.
public protocol EntraTokenProvider: AnyObject, Sendable {
    func acquireTokenInteractively(_ config: EntraMobileConfig) async throws -> String
    /// Throws `AuthError.interactionRequired` when no silent token is possible.
    func acquireTokenSilently(_ config: EntraMobileConfig) async throws -> String
}

/// Checks the authority the server hands out before MSAL is pointed at it.
public enum EntraAuthority {
    static let hosts: Set<String> = ["login.microsoftonline.com", "login.microsoftonline.us"]

    /// The authority as `https://<host>/<tenant-guid>`, or `.untrustedAuthority`.
    public static func validated(_ authority: String) throws -> String {
        guard let url = URL(string: authority), url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), hosts.contains(host),
              url.query == nil, url.fragment == nil, url.user == nil, url.port == nil
        else { throw AuthError.untrustedAuthority }
        let parts = url.path.split(separator: "/")
        guard parts.count == 1, UUID(uuidString: String(parts[0])) != nil else {
            throw AuthError.untrustedAuthority
        }
        return "https://\(host)/\(parts[0].lowercased())"
    }
}

/// Signs the person in and keeps the ERIS session alive.
///
/// 1. `GET /auth/config` names the ERIS Mobile client and API scope.
/// 2. MSAL (through Authenticator) returns an Entra access token for that scope.
/// 3. `POST /auth/entra/native` exchanges it for an ERIS session, which is stored;
///    the Entra token is dropped.
/// On a 401 the API client calls `renewSilently`, which repeats 2 and 3 without
/// any prompt while the device's Caltrans sign-in is valid.
public final class AuthService: @unchecked Sendable {
    public let api: APIClient
    private let provider: EntraTokenProvider
    private let lock = NSLock()
    private var mobile: EntraMobileConfig?

    public init(api: APIClient, provider: EntraTokenProvider) {
        self.api = api
        self.provider = provider
        api.reauthenticate = { [weak self] in
            guard let self else { throw AuthError.interactionRequired }
            try await self.renewSilently()
        }
    }

    public func configuration() async throws -> AuthConfig {
        try await api.request("GET", "/auth/config", authenticated: false, as: AuthConfig.self)
    }

    func mobileConfiguration() async throws -> EntraMobileConfig {
        if let cached = lock.locked({ mobile }) { return cached }
        guard let config = try await configuration().entraMobile else { throw AuthError.mobileSignInDisabled }
        let checked = EntraMobileConfig(authority: try EntraAuthority.validated(config.authority),
                                        clientId: config.clientId, scopes: config.scopes)
        lock.locked { mobile = checked }
        return checked
    }

    /// Interactive sign-in (Authenticator, MFA as Caltrans requires).
    public func signIn() async throws -> Me {
        let config = try await mobileConfiguration()
        try await exchange(try await provider.acquireTokenInteractively(config))
        return try await me()
    }

    /// A new ERIS session without prompting, or `.interactionRequired`.
    public func renewSilently() async throws {
        let config = try await mobileConfiguration()
        try await exchange(try await provider.acquireTokenSilently(config))
    }

    func exchange(_ entraAccessToken: String) async throws {
        do {
            let body = try api.encoder.encode(["access_token": entraAccessToken])
            let session = try await api.request("POST", "/auth/entra/native", body: body, authenticated: false,
                                                as: SessionResponse.self)
            api.store.save(session.accessToken)
        } catch APIError.forbidden {
            throw AuthError.notLinked
        } catch APIError.unauthorized {
            throw AuthError.notVerified
        }
    }

    public func me() async throws -> Me {
        try await api.get("/auth/me", as: Me.self)
    }

    /// The signed-in account if a stored session (or a silent renewal) works.
    public func restore() async -> Me? {
        guard api.store.load() != nil else { return nil }
        return try? await me()
    }

    /// Ends this device's ERIS session; other devices stay signed in.
    public func signOut(device: DeviceRegistration?) async {
        // Signing out must never trigger a silent sign-in to renew the session.
        if let device, let body = try? api.encoder.encode(device) {
            _ = try? await api.request("POST", "/notifications/devices/unregister", body: body, allowRenewal: false,
                                       as: EmptyResponse.self)
        }
        if api.store.load() != nil {
            _ = try? await api.request("POST", "/auth/logout", allowRenewal: false, as: EmptyResponse.self)
        }
        api.store.clear()
    }
}
