import LocusSDK
import SwiftUI
import UserNotifications

@main
struct DemoBankApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(DemoModel.shared)
        }
    }
}

/// iOS relaunches the app in the background for mall arrivals, so Locus is configured at launch.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        let model = DemoModel.shared
        if model.apply(), Locus.shared.consentGranted, model.wasRunning { Locus.shared.start() }
        return true
    }

    /// Show offer notifications even while the demo is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }
}
