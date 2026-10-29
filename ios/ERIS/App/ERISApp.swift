import BackgroundTasks
import ERISKit
import MSAL
import SwiftUI
import UserNotifications

@main
struct ERISApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task {
                    delegate.model = model
                    await model.start()
                }
                // Microsoft Authenticator returns here (msauth.<bundle id>://auth).
                .onOpenURL { url in
                    _ = MSALPublicClientApplication.handleMSALResponse(url, sourceApplication: nil)
                }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?
    /// iOS's background refresh: catch up now and then while ERIS is closed.
    static let refreshTask = "gov.ca.dot.eris.refresh"

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTask, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            Self.scheduleRefresh()
            let work = Task { @MainActor [weak self] in
                let reached = await self?.model?.catchUpInBackground() ?? false
                task.setTaskCompleted(success: reached)
            }
            task.expirationHandler = { work.cancel() }
        }
        Self.scheduleRefresh()
        return true
    }

    /// Asks for background time in about half an hour; iOS decides when.
    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTask)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// A notice arrived, maybe while ERIS was closed or the iPhone locked: fetch
    /// the work it is about (new assignments are kept ready to work on offline).
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async
        -> UIBackgroundFetchResult {
        guard let model = await MainActor.run(body: { self.model }) else { return .noData }
        return await model.catchUpInBackground() ? .newData : .failed
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await model?.registerPush(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Push is optional; the in-app feed still works.
    }

    /// Show the alert while ERIS is open, and refresh the badge.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        Task { @MainActor in
            await self.model?.refreshUnread()
            self.model?.offline?.kick()
        }
        return [.banner, .sound, .list]
    }

    /// Tapping a notification opens the screen its link points to.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let link = info["link"] as? String
        await MainActor.run {
            model?.pendingRoute = NotificationRoutes.route(link: link, kind: "")
        }
    }
}
