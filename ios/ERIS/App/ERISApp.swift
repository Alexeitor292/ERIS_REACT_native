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

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
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
        Task { @MainActor in await self.model?.refreshUnread() }
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
