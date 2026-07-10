import Foundation

/// Bandeja de conversaciones (`/api/contacts/chats*`, doc 03).
/// Reglas duras: paginación 50 (clamp servidor ≤100) sin total —
/// `hasMore = count >= limit`; con filtro de numero mandar
/// `businessPhoneNumberId` Y `businessPhone`. La hidratacion remota de avatares
/// solo se usa en arranque/paginacion: polls y SSE deben ser consultas ligeras.
struct ChatsService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Page size por defecto de la bandeja (paridad web/RN).
    static let defaultPageSize = 50

    /// `GET /api/contacts/chats`. Devuelve la página cruda de filas.
    func fetchChats(
        query: String = "",
        limit: Int = ChatsService.defaultPageSize,
        offset: Int = 0,
        businessPhoneNumberId: String? = nil,
        businessPhone: String? = nil,
        warmProfilePictures: Bool = true
    ) async throws -> [ChatContact] {
        try await client.get(
            "/contacts/chats",
            query: [
                "q": query.isEmpty ? nil : query,
                "limit": String(limit),
                "offset": String(offset),
                "businessPhoneNumberId": businessPhoneNumberId,
                "businessPhone": businessPhone,
                "warmProfilePictures": warmProfilePictures ? "true" : "false",
            ]
        )
    }

    /// Página con `hasMore` ya inferido (no hay total del server).
    func fetchChatsPage(
        query: String = "",
        limit: Int = ChatsService.defaultPageSize,
        offset: Int = 0,
        businessPhoneNumberId: String? = nil,
        businessPhone: String? = nil,
        warmProfilePictures: Bool = true
    ) async throws -> ChatInboxPage {
        let contacts = try await fetchChats(
            query: query,
            limit: limit,
            offset: offset,
            businessPhoneNumberId: businessPhoneNumberId,
            businessPhone: businessPhone,
            warmProfilePictures: warmProfilePictures
        )
        return ChatInboxPage(
            contacts: contacts,
            hasMore: ChatInboxPaginator.hasMore(batchCount: contacts.count, limit: limit)
        )
    }

    /// `POST /api/contacts/chats/:id/read` — marca leído para el usuario y
    /// encola el "visto" real del proveedor en background (no bloquear la UI;
    /// al abrir un chat: optimista a 0 + este POST fire-and-forget).
    @discardableResult
    func markChatRead(contactId: String) async throws -> ChatMarkReadResult {
        try await client.post("/contacts/chats/\(contactId)/read", body: RistakEmptyBody())
    }

    /// `POST /api/contacts/chats/read` (bulk). NOTA: el bulk NO dispara vistos
    /// de proveedor (solo el endpoint individual).
    @discardableResult
    func markChatsRead(contactIds: [String]) async throws -> ChatBulkMarkReadResult {
        try await client.post("/contacts/chats/read", body: ChatBulkReadRequestBody(contactIds: contactIds))
    }
}

/// Body vacío `{}` (el id de contacto va en la URL).
struct RistakEmptyBody: Encodable, Sendable {
    init() {}
}

/// Body del bulk read: `{ "contactIds": [...] }`.
struct ChatBulkReadRequestBody: Encodable, Sendable {
    let contactIds: [String]
}
