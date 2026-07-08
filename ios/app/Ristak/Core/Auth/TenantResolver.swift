import Foundation

/// Tenant resuelto por el portal instalador central.
struct ResolvedTenant: Sendable, Equatable {
    let clientID: String
    let installationID: String
    let name: String
    let email: String
    let status: String
    /// Origin normalizado de la instalación (`https://cliente.onrender.com`).
    let appURL: URL
}

/// Errores tipados del resolve de tenant (códigos verificados contra el repo
/// del Installer — doc research/02, Audit resolutions #1).
enum TenantResolverError: LocalizedError, Sendable {
    /// Identificador local vacío/corto (< 3 caracteres tras trim).
    case identifierRequired
    /// 404 `tenant_not_found`.
    case tenantNotFound(String)
    /// 403 `client_inactive`.
    case clientInactive(String)
    /// 404 `installation_not_ready`.
    case installationNotReady(String)
    /// 429 `rate_limited` (40 req / 15 min por IP).
    case rateLimited(String)
    /// Respuesta sin `app_url` válido u otro fallo del portal.
    case invalidResponse(String)
    /// Error de red hablando con el portal.
    case network

    var errorDescription: String? {
        switch self {
        case .identifierRequired:
            return "Escribe tu correo de Ristak."
        case .tenantNotFound(let message),
             .clientInactive(let message),
             .installationNotReady(let message),
             .rateLimited(let message),
             .invalidResponse(let message):
            return message
        case .network:
            return "Sin conexión con Ristak. Revisa tu internet e intenta de nuevo."
        }
    }
}

/// Resuelve la instalación (backend) de una empresa a partir del correo del
/// usuario contra el portal central: `POST https://www.ristak.com/api/mobile/resolve`.
struct TenantResolver: Sendable {
    static let defaultInstallerBaseURL = URL(string: "https://www.ristak.com")!

    var installerBaseURL: URL

    init(installerBaseURL: URL = TenantResolver.defaultInstallerBaseURL) {
        self.installerBaseURL = installerBaseURL
    }

    func resolve(identifier: String) async throws -> ResolvedTenant {
        let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { throw TenantResolverError.identifierRequired }

        var request = URLRequest(
            url: installerBaseURL.appendingPathComponent("api/mobile/resolve"),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 15
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(InstallerResolveBody(identifier: trimmed))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw TenantResolverError.network
        }

        guard let http = response as? HTTPURLResponse else {
            throw TenantResolverError.invalidResponse(Self.fallbackMessage)
        }

        let payload = try? JSONDecoder().decode(InstallerTenantResponse.self, from: data)

        guard (200..<300).contains(http.statusCode), payload?.success != false else {
            throw Self.mapError(status: http.statusCode, payload: payload)
        }

        guard
            let tenant = payload?.tenant,
            let rawURL = tenant.appURL,
            let appURL = Self.cleanBaseURL(rawURL)
        else {
            throw TenantResolverError.invalidResponse(payload?.message ?? Self.fallbackMessage)
        }

        return ResolvedTenant(
            clientID: tenant.clientID ?? "",
            installationID: tenant.installationID ?? "",
            name: tenant.name ?? "",
            email: tenant.email ?? "",
            status: tenant.status ?? "",
            appURL: appURL
        )
    }

    // MARK: - Helpers

    static let fallbackMessage = "No encontré una app activa para ese correo."

    private static func mapError(status: Int, payload: InstallerTenantResponse?) -> TenantResolverError {
        let code = payload?.code
        let message = payload?.message

        switch code {
        case "identifier_required":
            return .invalidResponse(message ?? "Escribe el correo o código de tu empresa.")
        case "tenant_not_found":
            return .tenantNotFound(message ?? "No encontré una app activa para esos datos.")
        case "client_inactive":
            return .clientInactive(message ?? "Esta cuenta no está activa.")
        case "installation_not_ready":
            return .installationNotReady(message ?? "Esta cuenta todavía no tiene una app lista.")
        case "rate_limited":
            return .rateLimited(message ?? "Demasiados intentos. Espera unos minutos e intenta de nuevo.")
        default:
            if status == 429 {
                return .rateLimited(message ?? "Demasiados intentos. Espera unos minutos e intenta de nuevo.")
            }
            return .invalidResponse(message ?? fallbackMessage)
        }
    }

    /// Normaliza una URL a origin (solo `http:`/`https:`, sin path, sin slash
    /// final) — paridad con `cleanBaseUrl` de RN/web.
    static func cleanBaseURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let components = URLComponents(string: trimmed) else { return nil }
        guard
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host,
            !host.isEmpty
        else { return nil }

        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = components.port
        return origin.url
    }
}

// MARK: - Shapes del portal

private struct InstallerResolveBody: Encodable {
    let identifier: String
}

private struct InstallerTenantResponse: Decodable {
    let success: Bool?
    let message: String?
    let code: String?
    let tenant: InstallerTenantPayload?

    enum CodingKeys: String, CodingKey {
        case success, message, code, tenant
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        message = container.flexibleString(forKey: .message)
        code = container.flexibleString(forKey: .code)
        tenant = try? container.decodeIfPresent(InstallerTenantPayload.self, forKey: .tenant)
    }
}

private struct InstallerTenantPayload: Decodable {
    let clientID: String?
    let installationID: String?
    let name: String?
    let email: String?
    let appURL: String?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case name, email, status
        case clientID = "client_id"
        case installationID = "installation_id"
        case appURL = "app_url"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        clientID = container.flexibleString(forKey: .clientID)
        installationID = container.flexibleString(forKey: .installationID)
        name = container.flexibleString(forKey: .name)
        email = container.flexibleString(forKey: .email)
        appURL = container.flexibleString(forKey: .appURL)
        status = container.flexibleString(forKey: .status)
    }
}
