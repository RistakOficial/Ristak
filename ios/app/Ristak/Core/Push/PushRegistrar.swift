import Foundation
import Observation
import UIKit
import UserNotifications

/// Registro de push nativo (doc research/11 §5, §10.1):
/// 1. `GET /api/push/public-key` → exige `iosConfigured == true`.
/// 2. Permiso `UNUserNotificationCenter` (.alert .badge .sound).
/// 3. `registerForRemoteNotifications()` → token APNs.
/// 4. `POST /api/push/mobile-devices` con el token en **HEX** + metadata.
///
/// El AppDelegate (dueño: agente de App) debe reenviar los callbacks:
/// - `didRegisterForRemoteNotificationsWithDeviceToken` →
///   `PushRegistrar.shared.handleDeviceToken(_:)`
/// - `didFailToRegisterForRemoteNotificationsWithError` →
///   `PushRegistrar.shared.handleRegistrationError(_:)`
///
/// En logout, `SessionStore.pushUnregisterHandler` debe apuntar a
/// `unregisterForLogout()` (DELETE best-effort del token).
@MainActor
@Observable
final class PushRegistrar {
    static let shared = PushRegistrar()

    enum PermissionState: Equatable, Sendable {
        case unknown
        case notDetermined
        case granted
        case denied
    }

    /// Estado del permiso nativo (labels UI: Activo / Bloqueado / Activar).
    private(set) var permissionState: PermissionState = .unknown
    /// Hay un flujo de activación en curso.
    private(set) var isWorking = false
    /// Último resultado del flujo (para el mensaje de estado de Ajustes).
    private(set) var lastOutcome: PushRegistrationOutcome?
    /// Token HEX registrado en el backend (persistido para el logout).
    private(set) var registeredToken: String?

    private var lastDeviceTokenHex: String?
    private var lastCalendarIDs: [String] = []
    private var tokenContinuation: CheckedContinuation<String, any Error>?

    private static let tokenDefaultsKey = "ristak.push.registeredToken"
    private static let tokenWaitTimeout: TimeInterval = 12

    private init() {
        registeredToken = UserDefaults.standard.string(forKey: Self.tokenDefaultsKey)
    }

    // MARK: - Permiso

    func refreshPermissionState() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            permissionState = .granted
        case .denied:
            permissionState = .denied
        case .notDetermined:
            permissionState = .notDetermined
        @unknown default:
            permissionState = .unknown
        }
    }

    // MARK: - Activación

    /// Auto-registro tras login (paridad RN): solo si el permiso es `granted`
    /// o aún no se ha pedido (`notDetermined`).
    func registerAfterLoginIfPossible(calendarIDs: [String] = []) async {
        await refreshPermissionState()
        guard permissionState == .granted || permissionState == .notDetermined else { return }
        _ = await activate(calendarIDs: calendarIDs)
    }

    /// Flujo completo del botón «Activar»/«Actualizar» de Ajustes.
    /// - Parameter calendarIDs: selección actual si «Citas agendadas» está ON;
    ///   `[]` = todos los calendarios.
    func activate(calendarIDs: [String] = []) async -> PushRegistrationOutcome {
        isWorking = true
        defer { isWorking = false }

        lastCalendarIDs = calendarIDs

        // 1. Config pública: sin iOS preparado no se registra nada.
        do {
            let config = try await PushService.publicConfig()
            guard config.iosConfigured == true else {
                return finish(.notConfigured(message: PushRegistrationOutcome.defaultNotConfiguredMessage))
            }
        } catch {
            return finish(.failed(message: "No se pudo leer la configuración de notificaciones."))
        }

        // 2. Permiso del sistema.
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        await refreshPermissionState()
        guard granted else {
            return finish(.denied(message: PushRegistrationOutcome.defaultDeniedMessage))
        }

        // 3. Categorías (hoy sin acciones; ids del backend, doc 11 §11.4).
        center.setNotificationCategories(Self.notificationCategories)

        // 4. Token APNs.
        UIApplication.shared.registerForRemoteNotifications()
        let token: String
        do {
            token = try await waitForDeviceToken()
        } catch {
            return finish(.failed(message: "No se pudo obtener la llave de notificaciones del celular."))
        }

        // 5. Registro en el backend.
        return await register(token: token, calendarIDs: calendarIDs)
    }

    // MARK: - Callbacks del AppDelegate

    /// Token APNs crudo → HEX (`BadDeviceToken` con cualquier otro formato).
    func handleDeviceToken(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        lastDeviceTokenHex = hex

        if let continuation = tokenContinuation {
            tokenContinuation = nil
            continuation.resume(returning: hex)
            return
        }

        // Rotación de token con la app ya registrada: re-registrar silencioso.
        if let registeredToken, registeredToken != hex {
            Task { _ = await register(token: hex, calendarIDs: lastCalendarIDs) }
        }
    }

    func handleRegistrationError(_ error: any Error) {
        if let continuation = tokenContinuation {
            tokenContinuation = nil
            continuation.resume(throwing: error)
        }
    }

    // MARK: - Logout

    /// `DELETE /api/push/mobile-devices` best-effort (doc 11 gap 6): sin esto
    /// el device sigue recibiendo push del último usuario.
    func unregisterForLogout() async {
        guard let token = registeredToken ?? lastDeviceTokenHex else { return }
        try? await PushService.unregisterDevice(token: token)
        registeredToken = nil
        UserDefaults.standard.removeObject(forKey: Self.tokenDefaultsKey)
    }

    // MARK: - Internos

    private func register(token: String, calendarIDs: [String]) async -> PushRegistrationOutcome {
        let registration = MobilePushDeviceRegistration(
            token: token,
            platform: "ios",
            calendarIds: calendarIDs,
            appVersion: Self.appVersion,
            appBuild: Self.appBuild,
            deviceModel: Self.deviceModelIdentifier,
            osVersion: UIDevice.current.systemVersion
        )
        do {
            _ = try await PushService.registerDevice(registration)
            registeredToken = token
            UserDefaults.standard.set(token, forKey: Self.tokenDefaultsKey)
            return finish(.subscribed)
        } catch let error as RistakAPIError {
            return finish(.failed(message: error.message))
        } catch {
            return finish(.failed(message: "No se activaron las alertas. Intenta otra vez."))
        }
    }

    private func finish(_ outcome: PushRegistrationOutcome) -> PushRegistrationOutcome {
        lastOutcome = outcome
        return outcome
    }

    private func waitForDeviceToken() async throws -> String {
        // APNs entrega el mismo token repetido: si ya llegó, usarlo directo.
        if let cached = lastDeviceTokenHex { return cached }

        return try await withCheckedThrowingContinuation { continuation in
            tokenContinuation = continuation
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.tokenWaitTimeout * 1_000_000_000))
                guard let self, let pending = self.tokenContinuation else { return }
                self.tokenContinuation = nil
                pending.resume(throwing: RistakAPIError(
                    kind: .network,
                    status: 0,
                    message: "No se pudo obtener la llave de notificaciones del celular."
                ))
            }
        }
    }

    /// Categorías UNNotification a registrar (hoy sin acciones).
    private static var notificationCategories: Set<UNNotificationCategory> {
        let identifiers = [
            "CHAT",
            "PAYMENT",
            "APPOINTMENT_BOOKED",
            "APPOINTMENT_CONFIRMED",
            "APPOINTMENT_CANCELLED",
            "APPOINTMENT_RESCHEDULED",
            "APPOINTMENT_NO_SHOW",
            "RISTAK",
        ]
        return Set(identifiers.map {
            UNNotificationCategory(identifier: $0, actions: [], intentIdentifiers: [], options: [])
        })
    }

    private static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    private static var appBuild: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    }

    /// Identificador de hardware (`iPhone17,1`); fallback al modelo genérico.
    private static var deviceModelIdentifier: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce(into: "") { result, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            result.append(Character(UnicodeScalar(UInt8(bitPattern: value))))
        }
        return identifier.isEmpty ? UIDevice.current.model : identifier
    }
}
