import Combine
import ERISKit
import Foundation
import UserNotifications
import UIKit

/// The app's signed-in state, shared by every screen.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case starting
        case signedOut(message: String?)
        case signedIn(Me)
    }

    @Published private(set) var phase: Phase = .starting
    @Published var unread = 0
    @Published var pendingRoute: AppRoute?
    /// Forms wait in My Work for someone who otherwise has no queue there.
    @Published private(set) var hasForms = false
    /// The signed-in person's forms and unsent work kept on this iPhone.
    private(set) var offline: OfflineSync?
    /// Highway reference data for finding post miles without a connection.
    let roads = RoadData()
    /// ArcGIS key and license, from ERIS.
    let maps = MapSetup()
    private var foreground: NSObjectProtocol?
    private var rounds: AnyCancellable?

    let auth: AuthService
    var api: APIClient { auth.api }
    private var device: DeviceRegistration?

    init(baseURL: URL = AppModel.configuredBaseURL) {
        var api = APIClient(baseURL: baseURL, store: KeychainSessionStore())
        #if DEBUG
        if DemoServer.isEnabled { api = DemoServer.makeClient() }
        #endif
        auth = AuthService(api: api, provider: MSALTokenProvider())
    }

    /// Debug builds started with `-ERISDemo YES` show sample data.
    var isDemo: Bool {
        #if DEBUG
        return DemoServer.isEnabled
        #else
        return false
        #endif
    }

    /// `ERISDeployment` in Info.plist, from the `ERIS_DEPLOYMENT` build setting.
    nonisolated static var deployment: Deployment {
        Deployment(Bundle.main.object(forInfoDictionaryKey: "ERISDeployment") as? String)
    }

    /// How this build may sign in to the server; nil when it cannot be reached.
    func signInMethods() async -> SignInMethods? {
        guard let config = try? await auth.configuration() else { return nil }
        return SignInMethods(config, deployment: Self.deployment)
    }

    /// `ERISAPIBaseURL` in Info.plist, from the `ERIS_API_BASE_URL` build setting.
    nonisolated static var configuredBaseURL: URL {
        let value = Bundle.main.object(forInfoDictionaryKey: "ERISAPIBaseURL") as? String ?? ""
        return URL(string: value) ?? URL(string: "https://eris.invalid/api")!
    }

    func start() async {
        do {
            if let me = try await auth.restoreChecked() {
                await arrive(me)
            } else {
                phase = .signedOut(message: nil)
            }
        } catch {
            await refuse(error)
        }
    }

    func signIn() async {
        do {
            await arrive(try await auth.signIn())
        } catch APIError.forbidden(let detail) {
            await refuse(APIError.forbidden(detail))
        } catch AuthError.cancelled {
            phase = .signedOut(message: nil)
        } catch AuthError.notLinked {
            phase = .signedOut(message: "Your Caltrans account is not linked to an active ERIS account. Ask an ERIS administrator for access.")
        } catch AuthError.mobileSignInDisabled {
            phase = .signedOut(message: "This ERIS server has not enabled the mobile app yet. Contact the ERIS administrator.")
        } catch AuthError.untrustedAuthority {
            phase = .signedOut(message: "This ERIS server's sign-in settings are not a Caltrans Entra tenant.")
        } catch {
            phase = .signedOut(message: "Caltrans sign-in could not be completed. Try again.")
        }
    }

    /// Staging builds only: the ERIS email and password (see `SignInMethods`).
    func signIn(email: String, password: String) async {
        guard Self.deployment == .staging else { return }
        do {
            await arrive(try await auth.signIn(email: email, password: password))
        } catch APIError.forbidden(let detail) {
            await refuse(APIError.forbidden(detail))
        } catch AuthError.wrongPassword {
            phase = .signedOut(message: "That email and password did not sign in. Check them and try again.")
        } catch AuthError.passwordSignInDisabled {
            phase = .signedOut(message: "This ERIS server does not allow password sign-in.")
        } catch {
            phase = .signedOut(message: "ERIS could not be reached. Check the connection and try again.")
        }
    }

    /// Standing in for someone away, or (nil) back to one's own work. Their queue and
    /// what is kept for them sit apart from this person's own.
    func actFor(_ person: Int?) async {
        let before = api.actingFor
        api.actingFor = person
        do {
            enter(try await auth.me())
            await offline?.catchUp()
            await refreshUnread()
        } catch {
            api.actingFor = before
        }
    }

    private func arrive(_ me: Me) async {
        guard AppAccess.allowed(me) else { return await refuse(nil) }
        enter(me)
        await afterSignIn()
    }

    /// ERIS does not admit this account to the app. The session ends, but what it
    /// kept on this iPhone stays, for if the person is placed again.
    private func refuse(_ error: Error?) async {
        api.actingFor = nil
        var message = AppAccess.refusal
        if let error = error as? APIError, case .forbidden(let detail?) = error { message = detail }
        offline?.stop(wiping: false)
        offline = nil
        rounds = nil
        await auth.signOut(device: device)
        device = nil
        unread = 0
        hasForms = false
        phase = .signedOut(message: message)
    }

    /// Picks up a change of place: the server applies it at the next request, and
    /// the tabs, queue and steps follow it here. Called when the app comes back
    /// and after each round of catching up.
    func refreshMe() async {
        guard case .signedIn(let current) = phase else { return }
        do {
            let fresh = try await auth.me()
            guard case .signedIn = phase else { return }
            guard AppAccess.allowed(fresh) else { return await refuse(nil) }
            guard fresh != current else { return }
            enter(fresh)
            if fresh.roles != current.roles || fresh.maintenanceDistricts != current.maintenanceDistricts {
                await offline?.catchUp()
            }
        } catch APIError.forbidden(let detail) {
            // The delegation ended: back to this person's own work, not out of the app.
            if api.actingFor != nil { await actFor(nil) } else { await refuse(APIError.forbidden(detail)) }
        } catch {
            // Not reached, or the session ended: the next request says so.
        }
    }

    /// Signed in: this person's offline store first, so every screen has it.
    private func enter(_ me: Me) {
        // After a session ended, someone else may sign in: the last person's
        // kept work stays in their own folder for when they come back.
        if let offline, offline.personId != me.id {
            offline.stop(wiping: false)
            self.offline = nil
        }
        if offline == nil {
            // The demo's sample data starts afresh each launch, so does what it kept.
            if isDemo { OfflineStore(directory: OfflineSync.folder(for: me.id)).wipe() }
            offline = OfflineSync(api: api, me: me)
            rounds = offline?.$rounds.dropFirst().sink { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.hasForms = !(self.offline?.work.forms.isEmpty ?? true)
                    await self.refreshMe()
                }
            }
        } else {
            offline?.update(me: me)
        }
        if let store = offline?.store { Task { await maps.prepare(api: api, store: store) } }
        phase = .signedIn(me)
        // Reporters (by role or district duty) and form authors find post miles with it; viewers are refused by the server.
        if !isDemo && (!RoleModel.isPublicOnly(me.roles) || me.reportsForMaintenance) { roads.refresh(api: api) }
        if foreground == nil {
            foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, case .signedIn = self.phase else { return }
                    if !self.isDemo { self.roads.refresh(api: self.api) }
                    await self.refreshMe()
                }
            }
        }
    }

    /// Signing out deletes what this person kept on the iPhone, sent or not.
    func signOut() async {
        if api.actingFor != nil { await actFor(nil) }
        offline?.stop(wiping: true)
        offline = nil
        rounds = nil
        await auth.signOut(device: device)
        device = nil
        unread = 0
        hasForms = false
        phase = .signedOut(message: "You have signed out of ERIS.")
    }

    /// The signed-in person's roles; none before sign-in.
    var roles: [String] { me?.roles ?? [] }

    /// The signed-in person, if any.
    var me: Me? {
        if case .signedIn(let me) = phase { return me }
        return nil
    }

    /// Any screen that sees `.unauthorized` sends the person back to sign-in.
    func handle(_ error: Error) -> String {
        if let error = error as? APIError {
            switch error {
            case .unauthorized:
                phase = .signedOut(message: "Your ERIS session ended. Sign in again to continue.")
                return "Signed out."
            case .forbidden(let detail): return detail ?? "You do not have access to this."
            case .notFound: return "Not found."
            case .transport: return "ERIS could not be reached. Check the connection."
            // The server's own words when it gives a reason ("Only DRAFT or REJECTED…").
            case .http(_, let detail?), .refused(_, let detail?, _): return detail
            default: return "Something went wrong. Try again."
            }
        }
        return "Something went wrong. Try again."
    }

    /// A notice or background time: catch up, so new work is ready before it is opened.
    func catchUpInBackground() async -> Bool {
        guard let offline else { return false }
        let reached = await offline.catchUpInBackground()
        await refreshUnread()
        if !isDemo { roads.refresh(api: api) }
        return reached
    }

    func refreshUnread() async {
        if let count = try? await api.get("/notifications/unread", as: UnreadCount.self) {
            unread = count.unread
        }
    }

    private func afterSignIn() async {
        await refreshUnread()
        if isDemo { return }
        let center = UNUserNotificationCenter.current()
        if (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// From the app delegate once iOS hands over the APNs device token.
    func registerPush(token: Data) async {
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        let registration = PushRegistration.registration(token: token, sandbox: sandbox)
        device = registration
        _ = try? await api.post("/notifications/devices", json: registration, as: EmptyResponse.self)
    }
}
