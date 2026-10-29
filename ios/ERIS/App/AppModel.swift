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
    /// The signed-in person's forms and unsent work kept on this iPhone.
    private(set) var offline: OfflineSync?
    /// Highway reference data for finding post miles without a connection.
    let roads = RoadData()
    private var foreground: NSObjectProtocol?

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

    /// `ERISAPIBaseURL` in Info.plist, from the `ERIS_API_BASE_URL` build setting.
    nonisolated static var configuredBaseURL: URL {
        let value = Bundle.main.object(forInfoDictionaryKey: "ERISAPIBaseURL") as? String ?? ""
        return URL(string: value) ?? URL(string: "https://eris.invalid/api")!
    }

    func start() async {
        if let me = await auth.restore() {
            enter(me)
            await afterSignIn()
        } else {
            phase = .signedOut(message: nil)
        }
    }

    func signIn() async {
        do {
            enter(try await auth.signIn())
            await afterSignIn()
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

    /// Signed in: this person's offline store first, so every screen has it.
    private func enter(_ me: Me) {
        if offline == nil {
            // The demo's sample data starts afresh each launch, so does what it kept.
            if isDemo { OfflineStore(directory: OfflineSync.folder(for: me.id)).wipe() }
            offline = OfflineSync(api: api, me: me)
        }
        phase = .signedIn(me)
        // Reporters (by role or district duty) and form authors find post miles with it; viewers are refused by the server.
        if !isDemo && (!RoleModel.isPublicOnly(me.roles) || me.reportsForMaintenance) {
            roads.refresh(api: api)
            if foreground == nil {
                foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
                                                                    object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, case .signedIn = self.phase else { return }
                        self.roads.refresh(api: self.api)
                    }
                }
            }
        }
    }

    /// Signing out deletes what this person kept on the iPhone, sent or not.
    func signOut() async {
        offline?.stop(wiping: true)
        offline = nil
        await auth.signOut(device: device)
        device = nil
        unread = 0
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
