import Foundation
import Observation

/// Fase de la sesión.
enum SessionPhase: Equatable, Sendable {
    /// Leyendo Keychain al arrancar.
    case booting
    /// Sin sesión: mostrar login.
    case loggedOut
    /// Con sesión (el `user` puede seguir en `nil` mientras verifica — arranque optimista).
    case active
}

/// Store de sesión (doc research/02). Arranque optimista con verify en
/// paralelo, login vía resolve de tenant, logout local y hooks globales de
/// 401/licencia cableados a `APIClient`.
@MainActor
@Observable
final class SessionStore {
    // MARK: Estado observable

    private(set) var phase: SessionPhase = .booting
    /// Usuario verificado (nil durante arranque optimista o si verify falló por red).
    private(set) var user: RistakUser?
    private(set) var baseURL: URL?
    private(set) var isVerifying = false
    /// Nombre de la empresa resuelta en el último login (para la alerta de logout).
    private(set) var tenantName: String?

    /// Mensaje pendiente de la alerta única "Licencia suspendida". La UI lo
    /// muestra y luego llama `clearLicenseBlockedAlert()`.
    private(set) var licenseBlockedAlertMessage: String?

    /// Hook best-effort para desregistrar el push token antes de cerrar sesión
    /// (lo instala el módulo Push: `DELETE /api/push/mobile-devices`).
    var pushUnregisterHandler: (@MainActor () async -> Void)?
    /// Limpieza local sin red para 401/revocacion/licencia: en ese punto el
    /// DELETE autenticado puede ser imposible, pero iOS debe dejar de entregar.
    var pushLocalResetHandler: (@MainActor () -> Void)?

    // MARK: Internos

    private let keychain = KeychainStore()
    private let resolver = TenantResolver()
    private var licenseAlertAlreadyShown = false
    private var hooksWired = false
    /// Epoch de identidad. Toda operacion async captura este valor y descarta
    /// su resultado si hubo logout, cambio de tenant o rotacion de token.
    private(set) var sessionGeneration: UInt64 = 0

    /// Timeout del verify de arranque (`BOOTSTRAP_SESSION_VERIFY_TIMEOUT_MS = 8000`).
    private static let bootstrapVerifyTimeout: TimeInterval = 8

    init() {}

    // MARK: - Arranque

    /// Bootstrap de sesión: entrar al shell de forma optimista con el token
    /// guardado y verificar en paralelo. Solo 401/403 desloguean; un error de
    /// red mantiene la sesión con el usuario cacheado (o `nil`).
    func bootstrap() async {
        sessionGeneration &+= 1
        isVerifying = false
        let expectedGeneration = sessionGeneration
        await wireAPIClientHooksIfNeeded()

        let storedBaseURL = keychain.string(for: .baseURL).flatMap { TenantResolver.cleanBaseURL($0) }
        let storedToken = keychain.string(for: .token)

        baseURL = storedBaseURL

        guard let storedBaseURL, let storedToken, !storedToken.isEmpty else {
            await APIClient.shared.configure(baseURL: storedBaseURL, token: nil)
            guard expectedGeneration == sessionGeneration else { return }
            RistakSnapshotCache.shared.configure(namespace: nil)
            phase = .loggedOut
            return
        }

        user = loadCachedUser()
        await APIClient.shared.configure(baseURL: storedBaseURL, token: storedToken)

        // Precarga de la caché SWR a memoria ANTES de pintar el shell: cada
        // pantalla lee su snapshot al instante (cero flash de vacío). Rápida
        // (una lectura de directorio); namespaceada por cuenta.
        RistakSnapshotCache.shared.configure(
            namespace: RistakSnapshotCache.namespace(baseURL: storedBaseURL, userID: user?.id)
        )
        await RistakSnapshotCache.shared.preloadIntoMemory()
        // Precarga los tamaños de imagen aprendidos (JSON en disco) FUERA de main,
        // para que el init de la primera burbuja de foto no bloquee el hilo.
        ChatImageSizeCache.preloadIntoMemory()

        guard expectedGeneration == sessionGeneration else { return }
        phase = .active

        await verifySession(token: storedToken, timeout: Self.bootstrapVerifyTimeout)
    }

    /// Re-verifica la sesión al volver a foreground (refresca `accessConfig` y
    /// `licenseFeatures`; no hay push de cambios de permisos).
    func verifyOnForeground() async {
        guard phase == .active, !isVerifying else { return }
        guard let token = keychain.string(for: .token), !token.isEmpty else { return }
        await verifySession(token: token, timeout: Self.bootstrapVerifyTimeout)
    }

    // MARK: - Login

    /// Login móvil de un solo paso: resolver tenant por correo → login contra
    /// la instalación.
    func login(email: String, password: String) async throws {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanEmail.isEmpty, !password.isEmpty else {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "Escribe tu correo y contraseña."
            )
        }

        let tenant = try await resolver.resolve(identifier: cleanEmail)
        tenantName = tenant.name.isEmpty ? nil : tenant.name
        try await completeLogin(email: cleanEmail, password: password, baseURL: tenant.appURL)
    }

    /// Login directo contra un servidor específico para pruebas internas.
    /// No se expone en la UI: el usuario siempre entra por resolve de correo.
    func login(email: String, password: String, serverURL: URL) async throws {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanEmail.isEmpty, !password.isEmpty else {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "Escribe tu correo y contraseña."
            )
        }
        guard let origin = TenantResolver.cleanBaseURL(serverURL.absoluteString) else {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "La dirección del servidor no es válida."
            )
        }
        tenantName = nil
        try await completeLogin(email: cleanEmail, password: password, baseURL: origin)
    }

    private func completeLogin(email: String, password: String, baseURL newBaseURL: URL) async throws {
        sessionGeneration &+= 1
        isVerifying = false
        let expectedGeneration = sessionGeneration
        let previousBaseURL = baseURL
        let previousToken = keychain.string(for: .token)

        // Cambio de empresa: purgar el snapshot del tenant anterior.
        if let previous = baseURL, previous != newBaseURL {
            keychain.set(nil, for: .cachedUser)
        }

        await APIClient.shared.configure(baseURL: newBaseURL, token: nil)

        let response: RistakLoginResponse
        do {
            response = try await APIClient.shared.post(
                "/api/auth/login",
                body: RistakLoginRequestBody(email: email, password: password)
            )
        } catch {
            // Sin sesión válida: restaurar la configuración previa del cliente.
            if expectedGeneration == sessionGeneration {
                await APIClient.shared.configure(baseURL: previousBaseURL, token: previousToken)
            }
            throw error
        }

        guard expectedGeneration == sessionGeneration else { throw CancellationError() }
        guard let token = response.token, !token.isEmpty, let loggedUser = response.user else {
            await APIClient.shared.configure(baseURL: previousBaseURL, token: previousToken)
            throw RistakAPIError(
                kind: .server,
                status: 0,
                message: response.message ?? "Correo o contraseña incorrectos."
            )
        }

        await APIClient.shared.configure(baseURL: newBaseURL, token: token)
        guard expectedGeneration == sessionGeneration else { throw CancellationError() }

        keychain.setString(newBaseURL.absoluteString, for: .baseURL)
        keychain.setString(token, for: .token)
        persistCachedUser(loggedUser)

        baseURL = newBaseURL
        user = loggedUser

        // Reapuntar la caché SWR a la cuenta recién autenticada y precargar lo
        // que hubiera guardado de una sesión previa en esta misma cuenta.
        RistakSnapshotCache.shared.configure(
            namespace: RistakSnapshotCache.namespace(baseURL: newBaseURL, userID: loggedUser.id)
        )
        await RistakSnapshotCache.shared.preloadIntoMemory()
        guard expectedGeneration == sessionGeneration else { throw CancellationError() }

        licenseAlertAlreadyShown = false
        licenseBlockedAlertMessage = nil
        phase = .active
    }

    // MARK: - Logout

    /// Cierra sesión localmente (no existe endpoint de logout).
    /// - Parameter switchApp: `true` = "Cambiar app" (borra también la base URL
    ///   del tenant); `false` = "Cerrar sesión" (conserva la empresa).
    func logout(switchApp: Bool = false) async {
        sessionGeneration &+= 1
        isVerifying = false
        let expectedGeneration = sessionGeneration
        await pushUnregisterHandler?()
        // Vaciar la caché SWR (memoria + disco del namespace) para que las
        // cuentas nunca se mezclen. Solo en logout explícito, no en un 401.
        RistakSnapshotCache.shared.reset()
        // Aísla las cuentas también en las cachés de imagen: los bytes de fotos de
        // media/perfil (URLCache en disco) y las dimensiones aprendidas por URL no
        // deben sobrevivir a un cambio de cuenta.
        await RistakImageLoader.shared.removeAll()
        ChatImageSizeCache.removeAll()
        // Notas de voz propias (m4a = audio real grabado = PII): también viven
        // fuera del snapshot namespaceado y no deben cruzar de cuenta a cuenta.
        VoiceNoteLocalStore.removeAll()
        guard expectedGeneration == sessionGeneration else { return }
        await clearLocalSession(keepBaseURL: !switchApp, invalidateGeneration: false)
    }

    /// Tras `POST /api/auth/change-password` el backend revoca las demás
    /// sesiones y entrega un token nuevo: reemplazarlo INMEDIATAMENTE.
    func adoptToken(_ newToken: String) async {
        sessionGeneration &+= 1
        isVerifying = false
        keychain.setString(newToken, for: .token)
        await APIClient.shared.updateToken(newToken)
    }

    /// Actualiza el usuario en memoria y en el snapshot (p. ej. tras `PATCH /api/auth/profile`).
    func applyUpdatedUser(_ updated: RistakUser) {
        user = updated
        persistCachedUser(updated)
    }

    func clearLicenseBlockedAlert() {
        licenseBlockedAlertMessage = nil
    }

    // MARK: - Verify

    private func verifySession(token: String, timeout: TimeInterval) async {
        let expectedGeneration = sessionGeneration
        isVerifying = true
        defer {
            if expectedGeneration == sessionGeneration {
                isVerifying = false
            }
        }

        do {
            let response: RistakVerifyResponse = try await APIClient.shared.post(
                "/api/auth/verify",
                body: RistakVerifyRequestBody(token: token),
                timeout: timeout
            )
            guard isCurrentSession(generation: expectedGeneration, token: token) else { return }
            if let verifiedUser = response.user {
                // Si el snapshot de Keychain faltó/no decodificó, el arranque
                // estuvo deliberadamente sin caché. Activarla solo después de
                // conocer una identidad real evita el namespace compartido
                // `sin-usuario` y deja disco listo antes de notificar a la UI.
                RistakSnapshotCache.shared.configure(
                    namespace: RistakSnapshotCache.namespace(
                        baseURL: baseURL,
                        userID: verifiedUser.id
                    )
                )
                await RistakSnapshotCache.shared.preloadIntoMemory()
                guard isCurrentSession(generation: expectedGeneration, token: token) else { return }
                user = verifiedUser
                persistCachedUser(verifiedUser)
            } else {
                // Respuesta válida sin user: token inservible.
                await clearLocalSession(keepBaseURL: true)
            }
        } catch let error as RistakAPIError {
            guard isCurrentSession(generation: expectedGeneration, token: token) else { return }
            if error.status == 401 || error.status == 403 {
                if error.kind == .licenseBlocked {
                    presentLicenseBlockedAlert(error)
                }
                await clearLocalSession(keepBaseURL: true)
            }
            // Error de red/timeout/5xx: mantener la sesión (tolerante a offline).
        } catch {
            // Error no tipado (cancelación, etc.): mantener la sesión.
        }
    }

    // MARK: - Hooks globales

    private func wireAPIClientHooksIfNeeded() async {
        guard !hooksWired else { return }
        hooksWired = true

        await APIClient.shared.setHooks(
            onUnauthorized: { [weak self] error in
                Task { @MainActor in
                    await self?.handleUnauthorized(error)
                }
            },
            onLicenseBlocked: { [weak self] error in
                Task { @MainActor in
                    await self?.handleLicenseBlocked(error)
                }
            }
        )
    }

    private func handleUnauthorized(_ error: RistakAPIError) async {
        guard phase == .active else { return }
        await clearLocalSession(keepBaseURL: true)
    }

    private func handleLicenseBlocked(_ error: RistakAPIError) async {
        guard phase == .active else { return }
        presentLicenseBlockedAlert(error)
        await clearLocalSession(keepBaseURL: true)
    }

    private func presentLicenseBlockedAlert(_ error: RistakAPIError) {
        guard !licenseAlertAlreadyShown else { return }
        licenseAlertAlreadyShown = true
        licenseBlockedAlertMessage = "Tu licencia de Ristak ya no está activa. Inicia sesión de nuevo cuando se reactive."
    }

    private func clearLocalSession(
        keepBaseURL: Bool,
        invalidateGeneration: Bool = true
    ) async {
        if invalidateGeneration {
            sessionGeneration &+= 1
            isVerifying = false
        }
        pushLocalResetHandler?()
        keychain.set(nil, for: .token)
        keychain.set(nil, for: .cachedUser)
        if !keepBaseURL {
            keychain.set(nil, for: .baseURL)
            baseURL = nil
            tenantName = nil
        }
        user = nil
        phase = .loggedOut

        // Un 401/licencia no borra el snapshot válido del usuario, pero sí lo
        // desmonta de RAM: ninguna pantalla sin identidad puede leerlo/escribirlo.
        RistakSnapshotCache.shared.configure(namespace: nil)

        let retainedBaseURL = keepBaseURL ? baseURL : nil
        await APIClient.shared.configure(baseURL: retainedBaseURL, token: nil)
    }

    func isCurrentActiveSession(_ generation: UInt64) -> Bool {
        phase == .active && sessionGeneration == generation
    }

    private func isCurrentSession(generation: UInt64, token: String) -> Bool {
        generation == sessionGeneration
            && phase == .active
            && keychain.string(for: .token) == token
    }

    // MARK: - Snapshot de usuario

    private func loadCachedUser() -> RistakUser? {
        guard let data = keychain.data(for: .cachedUser) else { return nil }
        return try? JSONDecoder().decode(RistakUser.self, from: data)
    }

    private func persistCachedUser(_ user: RistakUser) {
        guard let data = try? JSONEncoder().encode(user) else { return }
        keychain.set(data, for: .cachedUser)
    }
}
