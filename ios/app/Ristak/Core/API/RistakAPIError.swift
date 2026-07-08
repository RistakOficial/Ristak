import Foundation

/// Cuerpo de error del backend. Los endpoints mezclan `error` y `message`;
/// la regla de extracción es `error || message` (paridad con RN `api.ts`).
struct RistakAPIErrorPayload: Decodable, Sendable {
    let success: Bool?
    let error: String?
    let message: String?
    let code: String?
    let reason: String?
    let feature: String?
    let module: String?

    enum CodingKeys: String, CodingKey {
        case success, error, message, code, reason, feature, module
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        error = container.flexibleString(forKey: .error)
        message = container.flexibleString(forKey: .message)
        code = container.flexibleString(forKey: .code)
        reason = container.flexibleString(forKey: .reason)
        feature = container.flexibleString(forKey: .feature)
        module = container.flexibleString(forKey: .module)
    }

    var resolvedMessage: String? {
        if let error, !error.isEmpty { return error }
        if let message, !message.isEmpty { return message }
        return nil
    }
}

/// Error tipado de la API de Ristak.
struct RistakAPIError: Error, LocalizedError, Sendable {
    enum Kind: Equatable, Sendable {
        /// 401 (token faltante/inválido/expirado, usuario inactivo).
        case unauthorized
        /// 401 con `code: "token_revoked"` (cambió la contraseña).
        case tokenRevoked
        /// 403 `license_blocked`: licencia central suspendida.
        case licenseBlocked
        /// 403 `feature_not_available`: función fuera del plan. Silencioso en GET.
        case featureUnavailable
        /// 403 `read_access_required` / `write_access_required`: sin permiso de módulo.
        case accessDenied
        /// 403 `admin_required`.
        case adminRequired
        /// 429 `rate_limited`.
        case rateLimited
        /// 503 de arranque ("Aplicación iniciando"), tras agotar los reintentos.
        case starting
        /// 400 validación.
        case badRequest
        /// 404.
        case notFound
        /// 5xx u otros códigos.
        case server
        /// Error de red / timeout (sin respuesta HTTP).
        case network
        /// Respuesta 2xx que no se pudo decodificar.
        case decoding
        /// APIClient sin base URL configurada.
        case notConfigured
    }

    let kind: Kind
    /// Status HTTP (0 si no hubo respuesta).
    let status: Int
    let code: String?
    let message: String
    let reason: String?
    let feature: String?
    let module: String?
    let underlying: Error?
    /// Cuerpo crudo de la respuesta de error, para payloads extra que el
    /// envelope estándar no modela (p. ej. el objeto `conflict` del 409
    /// `merge_confirmation_required` de contactos — doc research/06 §6.2).
    let rawBody: Data?

    init(
        kind: Kind,
        status: Int,
        code: String? = nil,
        message: String,
        reason: String? = nil,
        feature: String? = nil,
        module: String? = nil,
        underlying: Error? = nil,
        rawBody: Data? = nil
    ) {
        self.kind = kind
        self.status = status
        self.code = code
        self.message = message
        self.reason = reason
        self.feature = feature
        self.module = module
        self.underlying = underlying
        self.rawBody = rawBody
    }

    /// Decodifica el cuerpo crudo de error como `T` (nil si no hay cuerpo o
    /// no coincide la forma).
    func decodeRawBody<T: Decodable>(_ type: T.Type) -> T? {
        guard let rawBody else { return nil }
        return try? JSONDecoder().decode(T.self, from: rawBody)
    }

    var errorDescription: String? { message }

    /// `true` si es un fallo de acceso de módulo (la vista muestra estado "sin acceso", no logout).
    var isAccessDenied: Bool { kind == .accessDenied }

    /// `true` si la sesión debe considerarse inválida (401, incl. `token_revoked`).
    var isUnauthorized: Bool { kind == .unauthorized || kind == .tokenRevoked }

    // MARK: Constructores

    static func network(_ underlying: Error) -> RistakAPIError {
        RistakAPIError(
            kind: .network,
            status: 0,
            message: "Sin conexión con el servidor. Revisa tu internet e intenta de nuevo.",
            underlying: underlying
        )
    }

    static func decoding(_ underlying: Error) -> RistakAPIError {
        RistakAPIError(
            kind: .decoding,
            status: 0,
            message: "No se pudo leer la respuesta del servidor.",
            underlying: underlying
        )
    }

    static var notConfigured: RistakAPIError {
        RistakAPIError(
            kind: .notConfigured,
            status: 0,
            message: "No hay servidor configurado. Inicia sesión de nuevo."
        )
    }

    static var invalidResponse: RistakAPIError {
        RistakAPIError(
            kind: .server,
            status: 0,
            message: "Respuesta inválida del servidor."
        )
    }

    /// Mapea una respuesta HTTP no exitosa al error tipado.
    static func from(status: Int, payload: RistakAPIErrorPayload?, rawBody: Data? = nil) -> RistakAPIError {
        let code = payload?.code
        let message = payload?.resolvedMessage
        let kind: Kind
        var fallbackMessage: String

        switch status {
        case 400:
            kind = .badRequest
            fallbackMessage = "Solicitud inválida."
        case 401:
            kind = (code == "token_revoked") ? .tokenRevoked : .unauthorized
            fallbackMessage = "Tu sesión ya no es válida. Inicia sesión de nuevo."
        case 403:
            switch code {
            case "license_blocked":
                kind = .licenseBlocked
                fallbackMessage = "Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar."
            case "feature_not_available":
                kind = .featureUnavailable
                fallbackMessage = "Esta función no está incluida en tu plan actual. Contacta al administrador para activarla."
            case "read_access_required":
                kind = .accessDenied
                fallbackMessage = "No tienes acceso a esta sección."
            case "write_access_required":
                kind = .accessDenied
                fallbackMessage = "No tienes permiso para cambiar información en esta sección."
            case "admin_required":
                kind = .adminRequired
                fallbackMessage = "Solo un administrador puede hacer esto."
            default:
                kind = .accessDenied
                fallbackMessage = "No tienes acceso a esta sección."
            }
        case 404:
            kind = .notFound
            fallbackMessage = "No se encontró el recurso solicitado."
        case 429:
            kind = .rateLimited
            fallbackMessage = "Demasiados intentos. Espera unos minutos e intenta de nuevo."
        case 503:
            // Sin `code` es el gate de arranque del backend.
            kind = (code == nil) ? .starting : .server
            fallbackMessage = "La app está terminando de preparar la base de datos y servicios internos."
        default:
            kind = .server
            fallbackMessage = "Error en el servidor."
        }

        return RistakAPIError(
            kind: kind,
            status: status,
            code: code,
            message: message ?? fallbackMessage,
            reason: payload?.reason,
            feature: payload?.feature,
            module: payload?.module,
            rawBody: rawBody
        )
    }
}
