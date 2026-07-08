import Foundation

/// Plantillas WhatsApp (`GET /api/whatsapp-api/templates`, doc 05 §2.9).
/// Reutiliza los modelos compartidos `WhatsAppTemplate` /
/// `WhatsAppTemplatesSummary` (Core/Models/SettingsModels.swift). Fallback:
/// si el endpoint de plantillas falla, se intenta leer `status.templates`
/// de `GET /api/whatsapp-api/status` (mismo shape `{ total, approved,
/// blocked, items }`). Solo `APPROVED` se puede enviar.
struct TemplatesService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Lista de plantillas con fallback al snapshot del status.
    func fetchTemplates(status: String? = nil, limit: Int? = nil) async throws -> WhatsAppTemplatesSummary {
        do {
            return try await client.get(
                "/whatsapp-api/templates",
                query: [
                    "status": status,
                    "limit": limit.map(String.init),
                ]
            )
        } catch {
            if let fallback = try? await fetchTemplatesFromStatus(), !fallback.items.isEmpty {
                return fallback
            }
            throw error
        }
    }

    /// Solo las plantillas que se pueden enviar (`status == "APPROVED"`).
    func fetchSendableTemplates() async throws -> [WhatsAppTemplate] {
        try await fetchTemplates().items.filter(\.isApproved)
    }

    /// Snapshot `templates` embebido en `GET /api/whatsapp-api/status`.
    func fetchTemplatesFromStatus() async throws -> WhatsAppTemplatesSummary? {
        let snapshot: WhatsAppStatusTemplatesSnapshot = try await client.get(
            "/whatsapp-api/status",
            timeout: APIClient.dashboardTimeout
        )
        return snapshot.templates
    }
}

/// Vista mínima del status de WhatsApp para el fallback de plantillas
/// (el status completo lo modela el módulo de Ajustes).
struct WhatsAppStatusTemplatesSnapshot: Decodable, Sendable {
    let templates: WhatsAppTemplatesSummary?

    enum CodingKeys: String, CodingKey {
        case templates
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        templates = try? container.decodeIfPresent(WhatsAppTemplatesSummary.self, forKey: .templates)
    }
}
