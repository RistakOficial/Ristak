import SwiftUI
import UserNotifications

/// Puente UIKit para los callbacks que SwiftUI no expone: registro APNs y
/// entrega/tap de notificaciones. Reenvía todo a `PushRegistrar` y
/// `NotificationRouter` (doc research/11 §10).
final class RistakAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushRegistrar.shared.handleDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        Task { @MainActor in
            PushRegistrar.shared.handleRegistrationError(error)
        }
    }
}

extension RistakAppDelegate: UNUserNotificationCenterDelegate {
    /// Push con la app al frente: banner discreto + señal de refresh, sin
    /// navegar (paridad RN, doc research/11 §9.3).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let userInfo = notification.request.content.userInfo
        await MainActor.run {
            NotificationRouter.shared.handleForegroundNotification(userInfo: userInfo)
        }
        return [.banner, .list, .sound]
    }

    /// Tap en una notificación (background o cold start) → deep link tipado.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        await MainActor.run {
            NotificationRouter.shared.handleNotificationTap(userInfo: userInfo)
        }
    }
}
