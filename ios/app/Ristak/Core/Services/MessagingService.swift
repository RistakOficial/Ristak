import Foundation

/// Envío de mensajes salientes (doc 05): WhatsApp API/QR, Meta social nativo,
/// respuestas a comentarios, HighLevel Conversations y correo SMTP propio.
/// Todos los envíos manuales llevan `messageOrigin: 'manual_chat'` (los
/// requests ya lo traen por default). Los errores llegan como `RistakAPIError`
/// con el mensaje en español del backend; si
/// `WhatsAppReplyWindowRules.isReplyWindowError(error)` la UI debe ofrecer
/// plantillas.
struct MessagingService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    // MARK: WhatsApp (`/api/whatsapp-api/messages/*`)

    /// `POST /messages/text`.
    func sendText(_ request: TextMessageSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/text", body: request)
    }

    /// `POST /messages/reaction`. Solo a mensajes inbound con
    /// `providerMessageId`; `transport` = el del mensaje objetivo.
    func sendReaction(_ request: ReactionSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/reaction", body: request)
    }

    /// `POST /messages/location`.
    func sendLocation(_ request: LocationSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/location", body: request)
    }

    /// `POST /messages/image` — data URL base64 (timeout de media).
    func sendImage(_ request: ImageMessageSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/image", body: request, timeout: APIClient.mediaTimeout)
    }

    /// `POST /messages/document`.
    func sendDocument(_ request: DocumentMessageSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/document", body: request, timeout: APIClient.mediaTimeout)
    }

    /// `POST /messages/video` — el backend transcodifica con ffmpeg; puede
    /// tardar >10 s (timeout de media).
    func sendVideo(_ request: VideoMessageSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/video", body: request, timeout: APIClient.mediaTimeout)
    }

    /// `POST /messages/audio` — notas de voz (AAC/m4a como `audio/mp4`; el
    /// backend transcodifica a OGG/Opus).
    func sendAudio(_ request: AudioMessageSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/audio", body: request, timeout: APIClient.mediaTimeout)
    }

    /// `POST /messages/interactive` (botones; sin UI en el composer móvil).
    func sendInteractive(_ request: InteractiveMessageSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/messages/interactive", body: request)
    }

    /// `POST /templates/send`. No valida ventana de 24 h.
    func sendTemplate(_ request: TemplateSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/templates/send", body: request)
    }

    // MARK: Meta social nativo (`/api/whatsapp-api/meta/social/*`)

    /// `POST /meta/social/messages/text` — DM Messenger/Instagram.
    func sendMetaSocialText(_ request: MetaSocialTextSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/meta/social/messages/text", body: request)
    }

    /// `POST /meta/social/messages/audio` — nota de voz/audio sin texto.
    func sendMetaSocialAudio(_ request: MetaSocialAudioSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/meta/social/messages/audio", body: request, timeout: APIClient.mediaTimeout)
    }

    /// `POST /meta/social/messages/reaction` — SOLO ❤️.
    func sendMetaSocialReaction(_ request: MetaSocialReactionSendRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/meta/social/messages/reaction", body: request)
    }

    /// `POST /meta/social/comments/reply` — responder comentarios FB/IG
    /// (público en Instagram = solo texto).
    func sendCommentReply(_ request: MetaCommentReplyRequest) async throws -> MessageSendResult {
        try await client.post("/whatsapp-api/meta/social/comments/reply", body: request)
    }

    /// `GET /meta/social/posts` — publicaciones para selectores.
    func fetchMetaSocialPosts(
        platform: String? = nil,
        search: String? = nil,
        limit: Int? = nil,
        offset: Int? = nil,
        refresh: Bool = false
    ) async throws -> MetaSocialPostList {
        try await client.get(
            "/whatsapp-api/meta/social/posts",
            query: [
                "platform": platform,
                "search": search,
                "limit": limit.map(String.init),
                "offset": offset.map(String.init),
                "refresh": refresh ? "true" : nil,
            ]
        )
    }

    // MARK: HighLevel (`POST /api/highlevel/conversations/messages`, doc 05 §4)

    /// Canal de respaldo (SMS, adjuntos a Messenger/IG, email GHL, webchat).
    /// La respuesta puede reportar fallback WhatsApp→SMS
    /// (`fallbackApplied`, `channel != requestedChannel`).
    func sendHighLevelMessage(_ request: HighLevelMessageSendRequest) async throws -> MessageSendResult {
        try await client.post("/highlevel/conversations/messages", body: request, timeout: APIClient.mediaTimeout)
    }

    // MARK: Correo SMTP propio (`POST /api/email/send`, doc 05 §5)

    /// El composer móvil actual NO envía correos (bloqueado con «Disponible
    /// desde la vista completa de chats.») — endpoint disponible para paridad
    /// de escritorio/iPad si producto lo habilita.
    func sendEmail(_ request: EmailSendRequest) async throws -> MessageSendResult {
        try await client.post("/email/send", body: request)
    }
}
