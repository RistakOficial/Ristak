import Foundation

struct APIAuthorizedRequestSnapshot: Sendable {
    var request: URLRequest
    fileprivate let generation: UInt64
}

/// Cliente HTTP central de la app (actor). Réplica del contrato del cliente RN
/// (`mobile/src/api.ts`, doc research/01):
/// - Base URL del tenant + `Authorization: Bearer <jwt>`.
/// - Prefijo `/api` automático; query params omite nil/vacíos.
/// - Regla de envelope `{success, data}` (ver `RistakEnvelopeDecoder`).
/// - Errores tipados `RistakAPIError` con hooks globales (401, licencia, feature).
/// - 503 de arranque → reintento con backoff SOLO para GET/HEAD idempotentes.
actor APIClient {
    static let shared = APIClient()

    /// Timeout por defecto (doc 01 recomienda 15 s).
    static let defaultTimeout: TimeInterval = 15
    /// Envíos con media (data URLs base64 grandes).
    static let mediaTimeout: TimeInterval = 60
    /// Dashboard / agregaciones pesadas.
    static let dashboardTimeout: TimeInterval = 30

    private var baseURL: URL?
    private var token: String?
    /// Cambia cada vez que cambia tenant/token. Una respuesta de una generacion
    /// vieja puede terminar, pero nunca dispara hooks contra la sesion nueva.
    private var configurationGeneration: UInt64 = 0

    private struct RequestContext: Sendable {
        let baseURL: URL
        let token: String?
        let generation: UInt64
    }

    private var onUnauthorized: (@Sendable (RistakAPIError) -> Void)?
    private var onLicenseBlocked: (@Sendable (RistakAPIError) -> Void)?
    private var onFeatureUnavailable: (@Sendable (RistakAPIError) -> Void)?

    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// Rutas que manejan sus propios 401/403 (login muestra el error inline;
    /// verify lo maneja SessionStore.bootstrap). No disparan hooks globales.
    private static let hookExemptPaths: [String] = [
        "/api/auth/login",
        "/api/auth/verify",
    ]

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 120
        // Las pantallas ya tienen cache, polling y reintentos explicitos. Fallar
        // rapido sin red evita dejar un refresh pegado durante minutos/dias.
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    // MARK: - Configuración

    func configure(baseURL: URL?, token: String?) {
        if self.baseURL != baseURL || self.token != token {
            configurationGeneration &+= 1
        }
        self.baseURL = baseURL
        self.token = token
    }

    func updateToken(_ token: String?) {
        if self.token != token {
            configurationGeneration &+= 1
        }
        self.token = token
    }

    func reset() {
        if baseURL != nil || token != nil {
            configurationGeneration &+= 1
        }
        baseURL = nil
        token = nil
    }

    var currentBaseURL: URL? { baseURL }
    var hasSession: Bool { token?.isEmpty == false }
    var currentConfigurationGeneration: UInt64 { configurationGeneration }

    func setHooks(
        onUnauthorized: (@Sendable (RistakAPIError) -> Void)?,
        onLicenseBlocked: (@Sendable (RistakAPIError) -> Void)?,
        onFeatureUnavailable: (@Sendable (RistakAPIError) -> Void)? = nil
    ) {
        self.onUnauthorized = onUnauthorized
        self.onLicenseBlocked = onLicenseBlocked
        self.onFeatureUnavailable = onFeatureUnavailable
    }

    // MARK: - Métodos genéricos (aplican la regla de envelope)

    func get<T: Decodable>(
        _ path: String,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        let data = try await perform(method: "GET", path: path, query: query, bodyData: nil, contentType: nil, timeout: timeout)
        return try decodeResponse(data)
    }

    /// GET que desenvuelve `{ success, <key>: T }` (p. ej. `config`, `timezone`, `users`).
    func get<T: Decodable>(
        _ path: String,
        keyedUnder key: String,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        let data = try await perform(method: "GET", path: path, query: query, bodyData: nil, contentType: nil, timeout: timeout)
        do {
            return try RistakEnvelopeDecoder.keyed(key, from: data)
        } catch {
            throw RistakAPIError.decoding(error)
        }
    }

    func post<T: Decodable>(
        _ path: String,
        body: (any Encodable)? = nil,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        let data = try await perform(method: "POST", path: path, query: query, bodyData: try encodeBody(body), contentType: body == nil ? nil : "application/json", timeout: timeout)
        return try decodeResponse(data)
    }

    /// POST sin interés en la respuesta (204/acks).
    func post(
        _ path: String,
        body: (any Encodable)? = nil,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws {
        _ = try await perform(method: "POST", path: path, query: query, bodyData: try encodeBody(body), contentType: body == nil ? nil : "application/json", timeout: timeout)
    }

    func put<T: Decodable>(
        _ path: String,
        body: (any Encodable)? = nil,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        let data = try await perform(method: "PUT", path: path, query: query, bodyData: try encodeBody(body), contentType: body == nil ? nil : "application/json", timeout: timeout)
        return try decodeResponse(data)
    }

    func patch<T: Decodable>(
        _ path: String,
        body: (any Encodable)? = nil,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        let data = try await perform(method: "PATCH", path: path, query: query, bodyData: try encodeBody(body), contentType: body == nil ? nil : "application/json", timeout: timeout)
        return try decodeResponse(data)
    }

    /// DELETE; soporta body JSON (el backend usa DELETE con body en
    /// `/api/whatsapp-api/messages/scheduled/:id`).
    func delete<T: Decodable>(
        _ path: String,
        body: (any Encodable)? = nil,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        let data = try await perform(method: "DELETE", path: path, query: query, bodyData: try encodeBody(body), contentType: body == nil ? nil : "application/json", timeout: timeout)
        return try decodeResponse(data)
    }

    func delete(
        _ path: String,
        body: (any Encodable)? = nil,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws {
        _ = try await perform(method: "DELETE", path: path, query: query, bodyData: try encodeBody(body), contentType: body == nil ? nil : "application/json", timeout: timeout)
    }

    /// Upload binario crudo (p. ej. `POST /api/ai-agent/transcribe` con `audio/m4a`).
    func upload<T: Decodable>(
        _ path: String,
        rawBody: Data,
        contentType: String,
        method: String = "POST",
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.mediaTimeout
    ) async throws -> T {
        let data = try await perform(method: method, path: path, query: query, bodyData: rawBody, contentType: contentType, timeout: timeout)
        return try decodeResponse(data)
    }

    /// Respuesta cruda (Data) con la misma tubería de errores/reintentos.
    func rawData(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil,
        query: [String: String?] = [:],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> Data {
        try await perform(method: method, path: path, query: query, bodyData: try encodeBody(body), contentType: body == nil ? nil : "application/json", timeout: timeout)
    }

    /// Request autenticado listo para usarse fuera del cliente (SSE con
    /// `URLSession.bytes`, descargas). Incluye Bearer y query; el caller decide
    /// la sesión/stream.
    func authorizedRequest(
        for path: String,
        method: String = "GET",
        query: [String: String?] = [:],
        accept: String? = nil,
        timeout: TimeInterval = APIClient.defaultTimeout
    ) throws -> URLRequest {
        try authorizedRequestSnapshot(
            for: path,
            method: method,
            query: query,
            accept: accept,
            timeout: timeout
        ).request
    }

    func authorizedRequestSnapshot(
        for path: String,
        method: String = "GET",
        query: [String: String?] = [:],
        accept: String? = nil,
        timeout: TimeInterval = APIClient.defaultTimeout
    ) throws -> APIAuthorizedRequestSnapshot {
        let context = try requestContext()
        return APIAuthorizedRequestSnapshot(
            request: try buildRequest(
                context: context,
                method: method,
                path: path,
                query: query,
                bodyData: nil,
                contentType: nil,
                accept: accept,
                timeout: timeout
            ),
            generation: context.generation
        )
    }

    func validate(_ snapshot: APIAuthorizedRequestSnapshot) throws {
        guard snapshot.generation == configurationGeneration else {
            throw CancellationError()
        }
    }

    // MARK: - Núcleo

    private func encodeBody(_ body: (any Encodable)?) throws -> Data? {
        guard let body else { return nil }
        do {
            return try encoder.encode(RistakAnyEncodable(body))
        } catch {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "No se pudo preparar la solicitud.",
                underlying: error
            )
        }
    }

    private func decodeResponse<T: Decodable>(_ data: Data) throws -> T {
        if data.isEmpty {
            if let empty = APINoContent() as? T { return empty }
            if let ack = try? decoder.decode(T.self, from: Data("{}".utf8)) { return ack }
            throw RistakAPIError.decoding(
                DecodingError.dataCorrupted(
                    DecodingError.Context(codingPath: [], debugDescription: "Respuesta vacía")
                )
            )
        }
        do {
            return try RistakEnvelopeDecoder.unwrap(data, decoder: decoder)
        } catch {
            throw RistakAPIError.decoding(error)
        }
    }

    private func buildRequest(
        context: RequestContext,
        method: String,
        path: String,
        query: [String: String?],
        bodyData: Data?,
        contentType: String?,
        accept: String? = nil,
        timeout: TimeInterval
    ) throws -> URLRequest {
        let apiPath = Self.withAPIPrefix(path)
        guard var components = URLComponents(url: context.baseURL, resolvingAgainstBaseURL: false) else {
            throw RistakAPIError.invalidResponse
        }
        components.path = apiPath
        let items = query.compactMap { key, value -> URLQueryItem? in
            guard let value, !value.isEmpty else { return nil }
            return URLQueryItem(name: key, value: value)
        }
        if !items.isEmpty {
            components.queryItems = items.sorted { $0.name < $1.name }
            // Express decodifica '+' del query string como espacio (convención
            // x-www-form-urlencoded); URLComponents lo deja literal. Sin esto,
            // buscar teléfonos "+52..." llega al backend como " 52...".
            components.percentEncodedQuery = components.percentEncodedQuery?
                .replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else { throw RistakAPIError.invalidResponse }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        if let token = context.token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            request.httpBody = bodyData
            request.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        }
        if let accept {
            request.setValue(accept, forHTTPHeaderField: "Accept")
        }
        return request
    }

    private func perform(
        method: String,
        path: String,
        query: [String: String?],
        bodyData: Data?,
        contentType: String?,
        timeout: TimeInterval
    ) async throws -> Data {
        let maxStartupRetries = 2
        var attempt = 0
        let context = try requestContext()
        let normalizedMethod = method.uppercased()
        let mayRetry = normalizedMethod == "GET" || normalizedMethod == "HEAD"
        // La URL y credencial se capturan UNA sola vez. Un retry iniciado en la
        // cuenta A nunca se reconstruye accidentalmente contra la cuenta B.
        let request = try buildRequest(
            context: context,
            method: method,
            path: path,
            query: query,
            bodyData: bodyData,
            contentType: contentType,
            timeout: timeout
        )

        while true {
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: request)
            } catch is CancellationError {
                // Salir de una pantalla cancela su `.task`: NO es un fallo de red.
                // Propagar la cancelación para que `try?` la ignore y nadie pinte
                // un falso estado de "sin conexión".
                throw CancellationError()
            } catch let urlError as URLError where urlError.code == .cancelled {
                throw CancellationError()
            } catch {
                throw RistakAPIError.network(error)
            }

            guard let http = response as? HTTPURLResponse else {
                throw RistakAPIError.invalidResponse
            }

            if (200..<300).contains(http.statusCode) {
                // La cuenta pudo cambiar mientras la red respondia. Aunque sea
                // 2xx, entregar datos del tenant anterior permitiria que un VM
                // viejo los escriba en la cache namespaceada de la cuenta nueva.
                guard context.generation == configurationGeneration else {
                    throw CancellationError()
                }
                return data
            }

            let payload = try? decoder.decode(RistakAPIErrorPayload.self, from: data)

            // 503 de arranque/deploy (sin `code`): transitorio → backoff + retry.
            if mayRetry, http.statusCode == 503, payload?.code == nil, attempt < maxStartupRetries {
                attempt += 1
                let delaySeconds = 1.5 * Double(attempt)
                try await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
                try Task.checkCancellation()
                continue
            }

            let error = RistakAPIError.from(status: http.statusCode, payload: payload, rawBody: data)
            // Un 401 que pertenece a una peticion anterior al cambio de sesion
            // no puede tumbar al usuario que acaba de iniciar sesion.
            if context.generation == configurationGeneration {
                fireHooks(for: error, method: method, path: path)
            }
            throw error
        }
    }

    private func requestContext() throws -> RequestContext {
        guard let baseURL else { throw RistakAPIError.notConfigured }
        return RequestContext(
            baseURL: baseURL,
            token: token,
            generation: configurationGeneration
        )
    }

    private func fireHooks(for error: RistakAPIError, method: String, path: String) {
        let normalizedPath = Self.withAPIPrefix(path)
        guard !Self.hookExemptPaths.contains(where: { normalizedPath.hasPrefix($0) }) else { return }

        switch error.kind {
        case .unauthorized, .tokenRevoked:
            onUnauthorized?(error)
        case .licenseBlocked:
            onLicenseBlocked?(error)
        case .featureUnavailable:
            // Silencioso en GET (cargas de pantalla); alerta solo en acciones.
            if method.uppercased() != "GET" {
                onFeatureUnavailable?(error)
            }
        default:
            break
        }
    }

    /// Igual que `withApiPrefix` de RN: antepone `/api` si el path no lo trae.
    static func withAPIPrefix(_ path: String) -> String {
        var normalized = path
        if !normalized.hasPrefix("/") { normalized = "/" + normalized }
        if normalized == "/api" || normalized.hasPrefix("/api/") { return normalized }
        return "/api" + normalized
    }
}

/// Caja para poder encodear `any Encodable` con JSONEncoder.
private struct RistakAnyEncodable: Encodable {
    let value: any Encodable

    init(_ value: any Encodable) {
        self.value = value
    }

    func encode(to encoder: Encoder) throws {
        try value.encode(to: encoder)
    }
}
