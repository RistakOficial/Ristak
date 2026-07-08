import Foundation
import Observation

/// Router de notificaciones → deep links tipados (doc research/11 §10.3).
/// El shell lo observa: cuando `pendingDeepLink` cambia, navega a la sección
/// correspondiente y lo consume.
///
/// Cableado esperado (dueño del AppDelegate/shell):
/// - `userNotificationCenter(_:didReceive:withCompletionHandler:)` (tap,
///   background o cold start) → `handleNotificationTap(userInfo:)`.
/// - `userNotificationCenter(_:willPresent:...)` (push en foreground) →
///   presentar `.banner .list .sound` + `handleForegroundNotification(userInfo:)`
///   para disparar el refresh inmediato de bandeja/hilo.
@MainActor
@Observable
final class NotificationRouter {
    static let shared = NotificationRouter()

    /// Deep link pendiente de navegar (nil cuando ya se consumió).
    private(set) var pendingDeepLink: RistakDeepLink?
    /// Cambia en cada tap — permite reaccionar aunque el destino se repita.
    private(set) var deepLinkVersion = 0

    /// Contador de «nudges» por push en foreground (observar para refrescar).
    private(set) var foregroundNudgeCount = 0
    /// Contacto del último push en foreground (si venía de chat).
    private(set) var lastForegroundContactID: String?

    private init() {}

    /// Tap en una notificación (background o cold start).
    func handleNotificationTap(userInfo: [AnyHashable: Any]) {
        pendingDeepLink = RistakDeepLink.parse(userInfo: userInfo)
        deepLinkVersion &+= 1
    }

    /// Push recibido con la app al frente: NO navega; solo señal de refresh.
    func handleForegroundNotification(userInfo: [AnyHashable: Any]) {
        lastForegroundContactID = Self.contactID(in: userInfo)
        foregroundNudgeCount &+= 1
    }

    /// El shell llama esto tras navegar al destino.
    func consumePendingDeepLink() -> RistakDeepLink? {
        defer { pendingDeepLink = nil }
        return pendingDeepLink
    }

    private static func contactID(in userInfo: [AnyHashable: Any]) -> String? {
        for key in ["contactId", "contact_id"] {
            if let value = userInfo[key] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }
}
