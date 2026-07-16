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
        ChatBackgroundRefreshCoordinator.shared.register()
        RistakObservability.recordPush(.delegateReady)
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        ChatBackgroundRefreshCoordinator.shared.scheduleNextRefresh()
    }

    /// APNs de chat con `content-available=1`: bajar el hilo concreto y confirmar
    /// únicamente cuando inbox + snapshot ya quedaron persistidos.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { @MainActor in
            let result = await ChatBackgroundRefreshCoordinator.shared
                .refreshForRemoteNotification(userInfo: userInfo)
            completionHandler(result)
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        RistakObservability.recordPush(.apnsTokenReceived)
        Task { @MainActor in
            PushRegistrar.shared.handleDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        RistakObservability.recordPush(.apnsTokenFailed)
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
        RistakObservability.recordPush(.notificationReceived)
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
        RistakObservability.recordPush(.notificationOpened)
        let userInfo = response.notification.request.content.userInfo
        await MainActor.run {
            NotificationRouter.shared.handleNotificationTap(userInfo: userInfo)
        }
    }
}
