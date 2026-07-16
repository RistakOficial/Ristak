import Foundation

/// Journey / hilo de conversación (`GET /api/contacts/:id/conversation`, doc 04).
/// - Hilo de chat: `chatMessagesOnly=true&includeBusinessMessages=true&
///   refreshExternalStatuses=false&messageLimit=100` + cursor `beforeMessageDate`.
/// - Journey completo (markers de pagos/citas + panel Info):
///   `includeBusinessMessages=true&refreshExternalStatuses=false`.
struct JourneyService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// `CHAT_CONVERSATION_MESSAGE_LIMIT` de RN (App.tsx:734).
    static let defaultMessageLimit = 100

    /// Eventos de mensajes del hilo (página más reciente anterior a
    /// `beforeMessageDate` si se manda; orden ascendente).
    func fetchConversationEvents(
        contactId: String,
        limit: Int = JourneyService.defaultMessageLimit,
        beforeMessageDate: String? = nil
    ) async throws -> [JourneyEvent] {
        let query: [String: String?] = [
            "includeBusinessMessages": "true",
            "refreshExternalStatuses": "false",
            "chatMessagesOnly": "true",
            "messageLimit": String(limit),
            "beforeMessageDate": beforeMessageDate,
        ]
        do {
            // Contrato dedicado de chat. Hoy comparte el parser del journey en
            // backend, pero mantiene el hilo fuera de la ruta pesada de
            // atribución y permite optimizarlo sin alterar Contacto > Historial.
            return try await client.get(
                "/contacts/\(contactId)/conversation",
                query: query
            )
        } catch let error as RistakAPIError where Self.canUseLegacyConversationFallback(error) {
            // La app móvil puede hablar con instalaciones que aún no publican
            // la ruta dedicada. Un 404 de contrato vuelve al journey anterior;
            // auth, licencia, red y 5xx nunca se esconden con otro request.
            return try await client.get(
                "/contacts/\(contactId)/journey",
                query: query
            )
        }
    }

    static func canUseLegacyConversationFallback(_ error: RistakAPIError) -> Bool {
        error.status == 404 || error.kind == .notFound
    }

    /// Página de mensajes ya parseados con `buildMessagesFromJourney`.
    /// `hasOlder` se infiere igual que RN: página llena ⇒ probablemente hay más.
    func fetchConversationMessages(
        contactId: String,
        limit: Int = JourneyService.defaultMessageLimit,
        beforeMessageDate: String? = nil
    ) async throws -> ChatConversationPage {
        let events = try await fetchConversationEvents(
            contactId: contactId,
            limit: limit,
            beforeMessageDate: beforeMessageDate
        )
        let appBaseURL = await client.currentBaseURL
        let messages = ChatJourneyParser.buildMessages(contactId: contactId, events: events, appBaseURL: appBaseURL)
        return ChatConversationPage(
            messages: messages,
            hasOlderMessages: messages.count >= limit
        )
    }

    func currentBaseURL() async -> URL? {
        await client.currentBaseURL
    }

    /// Query estable del read-path ligero de pagos/citas. Mantenerlo separado del
    /// journey completo evita volver a descargar mensajes, atribución y sesiones
    /// únicamente para insertar tres tipos de marker en el hilo.
    static func chatActivityQuery(
        limit: Int = JourneyService.defaultMessageLimit
    ) -> [String: String?] {
        [
            "chatActivityOnly": "true",
            "messageLimit": String(max(1, limit)),
        ]
    }

    /// Solo activity markers de pagos/citas. El backend resuelve sus tres lecturas
    /// en paralelo y corta antes de construir el journey completo.
    func fetchChatActivity(
        contactId: String,
        limit: Int = JourneyService.defaultMessageLimit
    ) async throws -> [JourneyEvent] {
        try await client.get(
            "/contacts/\(contactId)/journey",
            query: Self.chatActivityQuery(limit: limit)
        )
    }

    /// Fecha del mensaje más viejo cargado para paginar hacia atrás
    /// (excluye programados y mensajes `system`, RN
    /// `getOldestNativeConversationMessageDate`).
    static func oldestMessageDate(in messages: [ChatMessage]) -> String? {
        var oldest: (date: Date, raw: String)?
        for message in messages {
            guard !message.isScheduled, message.direction != .system else { continue }
            guard let parsed = message.parsedDate else { continue }
            if oldest == nil || parsed < oldest!.date {
                oldest = (parsed, message.date)
            }
        }
        return oldest?.raw
    }

    /// Merge de una página antigua con lo ya cargado (prepend + dedupe por id
    /// + reacciones re-fusionadas + orden ascendente).
    static func mergeOlderPage(existing: [ChatMessage], older: [ChatMessage]) -> [ChatMessage] {
        ChatJourneyParser.mergeById(older + existing)
    }
}

/// Página del hilo ya parseada.
struct ChatConversationPage: Sendable {
    let messages: [ChatMessage]
    let hasOlderMessages: Bool
}
