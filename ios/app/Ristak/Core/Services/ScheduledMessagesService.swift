import Foundation

/// Mensajes programados (`/api/whatsapp-api/messages/scheduled*`, docs 04 §4 /
/// 05 §2.10). Solo texto y plantillas se pueden programar; editar = POST con
/// el mismo `id` (no hay PATCH). `scheduledAt` SIEMPRE UTC ISO; el backend
/// valida futuro (≥ now+10 s) en la TZ del negocio.
struct ScheduledMessagesService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// `GET /messages/scheduled?contactId=` — solo estados
    /// `scheduled|sending|error`, orden `scheduled_at` asc. El fetch es
    /// AUTORITATIVO: burbujas `scheduled-*` que ya no vengan se retiran.
    func fetchScheduledMessages(contactId: String) async throws -> [ScheduledChatMessage] {
        try await client.get(
            "/whatsapp-api/messages/scheduled",
            query: ["contactId": contactId]
        )
    }

    /// `POST /messages/scheduled` — crear o EDITAR (upsert por `id`).
    @discardableResult
    func upsert(_ request: ScheduledMessageUpsertRequest) async throws -> ScheduledChatMessage {
        try await client.post("/whatsapp-api/messages/scheduled", body: request)
    }

    /// `DELETE /messages/scheduled/:id` — cancela (status → `cancelled`).
    /// Solo estados `scheduled|error`; 404 "No se encontró un mensaje
    /// programado que se pueda eliminar." si no existe.
    @discardableResult
    func cancel(id: String, contactId: String? = nil) async throws -> ScheduledChatMessage {
        try await client.delete(
            "/whatsapp-api/messages/scheduled/\(id)",
            query: ["contactId": contactId]
        )
    }
}
