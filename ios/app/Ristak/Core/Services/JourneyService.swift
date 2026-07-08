import Foundation

/// Journey / hilo de conversación (`GET /api/contacts/:id/journey`, doc 04).
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
        try await client.get(
            "/contacts/\(contactId)/journey",
            query: [
                "includeBusinessMessages": "true",
                "refreshExternalStatuses": "false",
                "chatMessagesOnly": "true",
                "messageLimit": String(limit),
                "beforeMessageDate": beforeMessageDate,
            ]
        )
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
        let messages = ChatJourneyParser.buildMessages(contactId: contactId, events: events)
        return ChatConversationPage(
            messages: messages,
            hasOlderMessages: messages.count >= limit
        )
    }

    /// Journey completo sin filtrar (activity markers + Info del contacto).
    /// ⚠️ Puede ser pesado en contactos muy activos: throttle recomendado
    /// (gap doc 04 §10.18).
    func fetchFullJourney(contactId: String) async throws -> [JourneyEvent] {
        try await client.get(
            "/contacts/\(contactId)/journey",
            query: [
                "includeBusinessMessages": "true",
                "refreshExternalStatuses": "false",
            ]
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
