import Foundation

/// Estado, números y plantillas de WhatsApp (doc research/10 §2.6).
/// Solo requiere sesión (sin gate de módulo); el mount lleva
/// `requireFeature('whatsapp')` — con licencia sin esa feature los GET fallan
/// silenciosos (403 `feature_not_available`).
enum WhatsAppNumbersService {
    /// `GET /api/whatsapp-api/status` → status completo (números, remitente
    /// default, saldo, resumen de plantillas).
    static func status() async throws -> WhatsAppAPIStatus {
        try await APIClient.shared.get(
            "/api/whatsapp-api/status",
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `POST /api/whatsapp-api/refresh` — re-sincroniza con YCloud y devuelve
    /// el status completo. Puede ser lento (habla con YCloud): timeout amplio,
    /// y si falla conviene conservar el status previo (doc 10 gap 9).
    static func refresh() async throws -> WhatsAppAPIStatus {
        try await APIClient.shared.post(
            "/api/whatsapp-api/refresh",
            body: RistakEmptyJSONBody(),
            timeout: APIClient.mediaTimeout
        )
    }

    /// `POST /api/whatsapp-api/phone-numbers/default` `{ phoneNumberId }` →
    /// status completo actualizado (usarlo para refrescar la pantalla).
    /// Errores 400: «Elige el número que quieres dejar como principal»,
    /// «Ese número de WhatsApp no está conectado».
    static func setDefaultPhoneNumber(id: String) async throws -> WhatsAppAPIStatus {
        try await APIClient.shared.post(
            "/api/whatsapp-api/phone-numbers/default",
            body: WhatsAppDefaultPhoneRequest(phoneNumberId: id)
        )
    }

    /// `GET /api/whatsapp-api/templates` → `{ total, approved, blocked, items }`.
    /// Ajustes llama SIN `status` (todas — hace útil el contador «necesitan
    /// revisión», paridad RN); el composer usa `status: "APPROVED"`.
    /// `limit` 1–200 (default backend 100).
    static func templates(status: String? = nil, limit: Int? = nil) async throws -> WhatsAppTemplatesSummary {
        try await APIClient.shared.get(
            "/api/whatsapp-api/templates",
            query: [
                "status": status,
                "limit": limit.map(String.init),
            ],
            timeout: APIClient.dashboardTimeout
        )
    }
}
