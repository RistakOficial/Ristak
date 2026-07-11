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

    enum RegistrationState: Equatable, Sendable {
        /// Hay un token persistido, pero aun no se ha verificado en esta sesion.
        case unknown
        case unregistered
        case registering
        case registered
        case failed(message: String)
    }

    /// Estado del permiso nativo (labels UI: Activo / Bloqueado / Activar).
    private(set) var permissionState: PermissionState = .unknown
    /// Hay un flujo de activación en curso.
    private(set) var isWorking = false
    /// Último resultado del flujo (para el mensaje de estado de Ajustes).
    private(set) var lastOutcome: PushRegistrationOutcome?
    /// Token HEX registrado en el backend (persistido para el logout).
    private(set) var registeredToken: String?
    /// Salud real del enlace APNs -> backend, separada del permiso del sistema.
    private(set) var registrationState: RegistrationState

    var isFullyActive: Bool {
        permissionState == .granted && registrationState == .registered
    }

    private var lastDeviceTokenHex: String?
    private var lastCalendarIDs: [String] = []
    private var tokenContinuation: CheckedContinuation<String, any Error>?
    private var activationTask: Task<PushRegistrationOutcome, Never>?
    private var retryTask: Task<Void, Never>?
    private var retryAttempt = 0
    private var lastSuccessfulRegistrationAt: Date?
    /// Aisla activaciones entre sesiones. Un POST viejo puede terminar, pero no
    /// puede marcar ni reactivar push para la cuenta que ya salio.
    private var registrationEpoch: UInt64 = 0
    private var activeSessionGeneration: UInt64?

    private static let tokenDefaultsKey = "ristak.push.registeredToken"
    private static let successDateDefaultsKey = "ristak.push.lastSuccessfulRegistrationAt"
    private static let tokenWaitTimeout: TimeInterval = 12
    private static let registrationFreshness: TimeInterval = 6 * 60 * 60
    private static let retryDelays: [TimeInterval] = [5, 15, 60, 300]

    private init() {
        let storedToken = UserDefaults.standard.string(forKey: Self.tokenDefaultsKey)
        registeredToken = storedToken
        registrationState = storedToken == nil ? .unregistered : .unknown
        lastSuccessfulRegistrationAt = UserDefaults.standard.object(
            forKey: Self.successDateDefaultsKey
        ) as? Date
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

    func beginSession(generation: UInt64) {
        guard activeSessionGeneration != generation else { return }
        invalidateInFlightRegistration()
        activeSessionGeneration = generation
        registrationEpoch &+= 1
        registrationState = registeredToken == nil ? .unregistered : .unknown
    }

    /// Auto-registro tras login (paridad RN): solo si el permiso es `granted`
    /// o aún no se ha pedido (`notDetermined`).
    func registerAfterLoginIfPossible(calendarIDs: [String] = []) async {
        await refreshPermissionState()
        guard permissionState == .granted || permissionState == .notDetermined else { return }
        _ = await activate(calendarIDs: calendarIDs)
    }

    /// Autorrecuperacion al volver del background. No re-registra en cada
    /// interrupcion: solo cuando fallo/no se verifico o la confirmacion ya es
    /// vieja. El backoff interno cubre red/config temporalmente indisponible.
    func reconcileOnForeground(calendarIDs: [String] = []) async {
        await refreshPermissionState()
        guard permissionState == .granted else { return }
        let isStale = lastSuccessfulRegistrationAt.map {
            Date().timeIntervalSince($0) >= Self.registrationFreshness
        } ?? true
        guard registrationState != .registered || isStale else { return }
        _ = await activate(calendarIDs: calendarIDs)
    }

    /// Flujo completo del botón «Activar»/«Actualizar» de Ajustes.
    /// - Parameter calendarIDs: selección actual si «Citas agendadas» está ON;
    ///   `[]` = todos los calendarios.
    func activate(calendarIDs: [String] = []) async -> PushRegistrationOutcome {
        guard let sessionGeneration = activeSessionGeneration else {
            return .failed(message: "Inicia sesion para activar las alertas.")
        }
        lastCalendarIDs = calendarIDs
        if let activationTask {
            return await activationTask.value
        }

        isWorking = true
        registrationState = .registering
        RistakObservability.recordPush(.registrationStarted)
        let expectedEpoch = registrationEpoch
        let task: Task<PushRegistrationOutcome, Never> = Task { @MainActor [weak self] in
            guard let self else {
                return PushRegistrationOutcome.failed(
                    message: "No se activaron las alertas. Intenta otra vez."
                )
            }
            return await self.performActivation(
                calendarIDs: calendarIDs,
                epoch: expectedEpoch,
                sessionGeneration: sessionGeneration
            )
        }
        activationTask = task
        let outcome = await task.value
        if isRegistrationCurrent(epoch: expectedEpoch, sessionGeneration: sessionGeneration) {
            activationTask = nil
            isWorking = false
        }
        return outcome
    }

    private func performActivation(
        calendarIDs: [String],
        epoch: UInt64,
        sessionGeneration: UInt64
    ) async -> PushRegistrationOutcome {
        guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
            return .failed(message: "Se canceló la activación de notificaciones.")
        }
        // 1. Config pública: sin iOS preparado no se registra nada.
        do {
            let config = try await PushService.publicConfig()
            guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
                return .failed(message: "Se canceló la activación de notificaciones.")
            }
            guard config.iosConfigured == true else {
                return finish(.notConfigured(message: PushRegistrationOutcome.defaultNotConfiguredMessage))
            }
        } catch is CancellationError {
            return .failed(message: "Se canceló la activación de notificaciones.")
        } catch {
            guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
                return .failed(message: "Se canceló la activación de notificaciones.")
            }
            return finish(.failed(message: "No se pudo leer la configuración de notificaciones."))
        }

        // 2. Permiso del sistema.
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        await refreshPermissionState()
        guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
            return .failed(message: "Se canceló la activación de notificaciones.")
        }
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
        } catch is CancellationError {
            return .failed(message: "Se canceló la activación de notificaciones.")
        } catch {
            return finish(.failed(message: "No se pudo obtener la llave de notificaciones del celular."))
        }

        // 5. Registro en el backend.
        return await register(
            token: token,
            calendarIDs: calendarIDs,
            epoch: epoch,
            sessionGeneration: sessionGeneration
        )
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
        if activeSessionGeneration != nil,
           registeredToken != hex || registrationState != .registered {
            Task { _ = await activate(calendarIDs: lastCalendarIDs) }
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
        let token = registeredToken ?? lastDeviceTokenHex
        let inFlight = activationTask
        registrationEpoch &+= 1
        activeSessionGeneration = nil
        invalidateInFlightRegistration()
        inFlight?.cancel()
        if let inFlight {
            _ = await inFlight.value
        }
        if let token {
            try? await PushService.unregisterDevice(token: token)
        }
        clearLocalRegistration()
    }

    /// Corta inmediatamente la entrega local aun cuando un 401 ya no permita
    /// ejecutar el DELETE autenticado. Evita que la siguiente persona que abra
    /// el iPhone reciba avisos de la cuenta anterior.
    func clearLocalRegistration() {
        registrationEpoch &+= 1
        activeSessionGeneration = nil
        invalidateInFlightRegistration()
        UIApplication.shared.unregisterForRemoteNotifications()
        lastDeviceTokenHex = nil
        registeredToken = nil
        registrationState = .unregistered
        isWorking = false
        retryAttempt = 0
        lastSuccessfulRegistrationAt = nil
        lastOutcome = nil
        UserDefaults.standard.removeObject(forKey: Self.tokenDefaultsKey)
        UserDefaults.standard.removeObject(forKey: Self.successDateDefaultsKey)
        RistakObservability.recordPush(.deviceUnregistered)
    }

    // MARK: - Internos

    private func register(
        token: String,
        calendarIDs: [String],
        epoch: UInt64,
        sessionGeneration: UInt64
    ) async -> PushRegistrationOutcome {
        guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
            return .failed(message: "Se canceló la activación de notificaciones.")
        }
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
            guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
                return .failed(message: "Se canceló la activación de notificaciones.")
            }
            registeredToken = token
            UserDefaults.standard.set(token, forKey: Self.tokenDefaultsKey)
            lastSuccessfulRegistrationAt = Date()
            UserDefaults.standard.set(lastSuccessfulRegistrationAt, forKey: Self.successDateDefaultsKey)
            return finish(.subscribed)
        } catch is CancellationError {
            return .failed(message: "Se canceló la activación de notificaciones.")
        } catch let error as RistakAPIError {
            guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
                return .failed(message: "Se canceló la activación de notificaciones.")
            }
            return finish(.failed(message: error.message))
        } catch {
            guard isRegistrationCurrent(epoch: epoch, sessionGeneration: sessionGeneration) else {
                return .failed(message: "Se canceló la activación de notificaciones.")
            }
            return finish(.failed(message: "No se activaron las alertas. Intenta otra vez."))
        }
    }

    private func finish(_ outcome: PushRegistrationOutcome) -> PushRegistrationOutcome {
        lastOutcome = outcome
        switch outcome {
        case .subscribed:
            registrationState = .registered
            RistakObservability.recordPush(.backendRegistered)
            retryAttempt = 0
            retryTask?.cancel()
            retryTask = nil
        case .denied(let message):
            registrationState = .failed(message: message)
            RistakObservability.recordPush(.permissionDenied)
            retryTask?.cancel()
            retryTask = nil
        case .notConfigured(let message):
            registrationState = .failed(message: message)
            RistakObservability.recordPush(.configurationUnavailable)
            scheduleAutomaticRetry()
        case .failed(let message):
            registrationState = .failed(message: message)
            RistakObservability.recordPush(.backendRegistrationFailed)
            scheduleAutomaticRetry()
        }
        return outcome
    }

    private func scheduleAutomaticRetry() {
        guard let sessionGeneration = activeSessionGeneration else { return }
        guard permissionState == .granted || permissionState == .notDetermined else { return }
        guard retryTask == nil else { return }
        let expectedEpoch = registrationEpoch
        let index = min(retryAttempt, Self.retryDelays.count - 1)
        let delay = Self.retryDelays[index]
        retryAttempt = min(retryAttempt + 1, Self.retryDelays.count - 1)
        retryTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                try Task.checkCancellation()
            } catch {
                return
            }
            guard let self else { return }
            guard self.isRegistrationCurrent(
                epoch: expectedEpoch,
                sessionGeneration: sessionGeneration
            ) else { return }
            self.retryTask = nil
            _ = await self.activate(calendarIDs: self.lastCalendarIDs)
        }
    }

    private func isRegistrationCurrent(epoch: UInt64, sessionGeneration: UInt64) -> Bool {
        epoch == registrationEpoch && activeSessionGeneration == sessionGeneration
    }

    private func invalidateInFlightRegistration() {
        retryTask?.cancel()
        retryTask = nil
        activationTask?.cancel()
        activationTask = nil
        if let continuation = tokenContinuation {
            tokenContinuation = nil
            continuation.resume(throwing: CancellationError())
        }
        isWorking = false
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
