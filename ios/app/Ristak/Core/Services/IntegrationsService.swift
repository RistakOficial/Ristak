import Foundation

/// Estado de integraciones y licencia (docs research/08 §5.2 y 13 §2.5).
enum IntegrationsService {
    /// `GET /api/integrations/status` — objeto RAÍZ pelado (sin envelope).
    /// Solo requiere sesión.
    static func status() async throws -> IntegrationsStatus {
        try await APIClient.shared.get(
            "/api/integrations/status",
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `GET /api/license/status` — plan/features frescos. Consultarlo al abrir
    /// Pagos (el `user.licenseFeatures` cacheado puede quedar viejo, doc 13
    /// gap 6). Un estado bloqueado NO llega aquí: llega como 403
    /// `license_blocked` en cualquier request.
    static func licenseStatus() async throws -> RistakLicenseStatus {
        try await APIClient.shared.get("/api/license/status")
    }

    /// Matriz de capacidades de Pagos (regla `resolveMobilePaymentAccess` de
    /// RN): lee licencia + integraciones EN PARALELO con catch individual;
    /// si ambas fallan → solo pago único offline.
    static func paymentCapabilities() async -> PaymentCapabilities {
        async let integrationsTask = status()
        async let licenseTask = licenseStatus()
        let integrations = try? await integrationsTask
        let license = try? await licenseTask
        return PaymentCapabilities.resolve(integrations: integrations, license: license)
    }
}
