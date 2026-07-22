import Foundation

// Contrato exacto: docs/research/05-message-sending.md.

/// Transporte de salida WhatsApp.
enum WhatsAppSendTransport: String, Encodable, Sendable {
    case api
    case qr
}

/// Plataforma Meta social nativa.
enum MetaSocialPlatform: String, Encodable, Sendable {
    case messenger
    case instagram
}

/// Origen de mensaje manual: los envíos manuales del chat DEBEN mandar
/// `messageOrigin: 'manual_chat'` para saltar el drip anti-bloqueo QR
/// (doc 05 §1.3). Automatizaciones NO deben usarlo.
enum ChatMessageOrigin {
    static let manualChat = "manual_chat"
}

/// Ids idempotentes de cliente: `ios-<tipo>-<uuid>` (dedupe/reconciliación).
enum MessageExternalIdFactory {
    static func make(_ type: String) -> String {
        "ios-\(type)-\(UUID().uuidString.lowercased())"
    }

    static func text() -> String { make("text") }
    static func reaction() -> String { make("reaction") }
    static func location() -> String { make("location") }
    static func image() -> String { make("image") }
    static func video() -> String { make("video") }
    static func audio() -> String { make("audio") }
    static func document() -> String { make("document") }
    static func template() -> String { make("template") }
    static func meta() -> String { make("meta") }
    static func metaAudio() -> String { make("meta-audio") }
    static func comment() -> String { make("comment") }
    static func highLevel() -> String { make("ghl") }
    static func email() -> String { make("email") }
    static func scheduled() -> String { make("scheduled") }
}

// MARK: - Payloads WhatsApp (`/api/whatsapp-api/messages/*`)

/// `POST /messages/text` (doc 05 §2.1).
struct TextMessageSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var text: String
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?
    /// Id LOCAL del mensaje citado.
    var replyToMessageId: String?
    /// wamid/id proveedor del citado.
    var replyToProviderMessageId: String?
    var messageOrigin: String

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        text: String,
        externalId: String? = MessageExternalIdFactory.text(),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil,
        replyToMessageId: String? = nil,
        replyToProviderMessageId: String? = nil,
        messageOrigin: String = ChatMessageOrigin.manualChat
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.text = text
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
        self.replyToMessageId = replyToMessageId
        self.replyToProviderMessageId = replyToProviderMessageId
        self.messageOrigin = messageOrigin
    }
}

/// `POST /messages/reaction` (doc 05 §2.2).
struct ReactionSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var emoji: String
    var targetMessageId: String?
    var targetProviderMessageId: String?
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?
    var messageOrigin: String

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        emoji: String,
        targetMessageId: String? = nil,
        targetProviderMessageId: String? = nil,
        externalId: String? = MessageExternalIdFactory.reaction(),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil,
        messageOrigin: String = ChatMessageOrigin.manualChat
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.emoji = emoji
        self.targetMessageId = targetMessageId
        self.targetProviderMessageId = targetProviderMessageId
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
        self.messageOrigin = messageOrigin
    }
}

/// `POST /messages/location` (doc 05 §2.3).
struct LocationSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var latitude: Double
    var longitude: Double
    var name: String?
    var address: String?
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?
    var messageOrigin: String

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        latitude: Double,
        longitude: Double,
        name: String? = nil,
        address: String? = nil,
        externalId: String? = MessageExternalIdFactory.location(),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil,
        messageOrigin: String = ChatMessageOrigin.manualChat
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.latitude = latitude
        self.longitude = longitude
        self.name = name
        self.address = address
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
        self.messageOrigin = messageOrigin
    }
}

/// `POST /messages/image` (doc 05 §2.4). Media SIEMPRE como data URL base64
/// en JSON (no hay multipart); alternativa `imageUrl` HTTPS pública.
struct ImageMessageSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var imageDataUrl: String?
    var imageUrl: String?
    var imageMediaAssetId: String?
    /// Se recorta a 1024 chars server-side; admite `{{variables}}`.
    var caption: String?
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?
    var messageOrigin: String

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        imageDataUrl: String? = nil,
        imageUrl: String? = nil,
        imageMediaAssetId: String? = nil,
        caption: String? = nil,
        externalId: String? = MessageExternalIdFactory.image(),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil,
        messageOrigin: String = ChatMessageOrigin.manualChat
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.imageDataUrl = imageDataUrl
        self.imageUrl = imageUrl
        self.imageMediaAssetId = imageMediaAssetId
        self.caption = caption
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
        self.messageOrigin = messageOrigin
    }
}

/// `POST /messages/document` (doc 05 §2.5).
struct DocumentMessageSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var documentDataUrl: String?
    var documentUrl: String?
    var documentMediaAssetId: String?
    var filename: String?
    var mimeType: String?
    var caption: String?
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?
    var messageOrigin: String

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        documentDataUrl: String? = nil,
        documentUrl: String? = nil,
        documentMediaAssetId: String? = nil,
        filename: String? = nil,
        mimeType: String? = nil,
        caption: String? = nil,
        externalId: String? = MessageExternalIdFactory.document(),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil,
        messageOrigin: String = ChatMessageOrigin.manualChat
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.documentDataUrl = documentDataUrl
        self.documentUrl = documentUrl
        self.documentMediaAssetId = documentMediaAssetId
        self.filename = filename
        self.mimeType = mimeType
        self.caption = caption
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
        self.messageOrigin = messageOrigin
    }
}

/// `POST /messages/video` (doc 05 §2.6).
struct VideoMessageSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var videoDataUrl: String?
    var videoUrl: String?
    var videoMediaAssetId: String?
    var caption: String?
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?
    var messageOrigin: String

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        videoDataUrl: String? = nil,
        videoUrl: String? = nil,
        videoMediaAssetId: String? = nil,
        caption: String? = nil,
        externalId: String? = MessageExternalIdFactory.video(),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil,
        messageOrigin: String = ChatMessageOrigin.manualChat
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.videoDataUrl = videoDataUrl
        self.videoUrl = videoUrl
        self.videoMediaAssetId = videoMediaAssetId
        self.caption = caption
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
        self.messageOrigin = messageOrigin
    }
}

/// `POST /messages/audio` — notas de voz (doc 05 §2.7). Grabar AAC/M4A y
/// mandar `audio/mp4`; el backend transcodifica a OGG/Opus. Mandar SIEMPRE
/// `voice: true` explícito para notas de voz (gap §10.10) y `durationMs`
/// medido por el cliente (gap §10.15).
struct AudioMessageSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var audioDataUrl: String?
    var audioUrl: String?
    var audioMediaAssetId: String?
    var durationMs: Double?
    var voice: Bool
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?
    var messageOrigin: String

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        audioDataUrl: String? = nil,
        audioUrl: String? = nil,
        audioMediaAssetId: String? = nil,
        durationMs: Double? = nil,
        voice: Bool = true,
        externalId: String? = MessageExternalIdFactory.audio(),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil,
        messageOrigin: String = ChatMessageOrigin.manualChat
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.audioDataUrl = audioDataUrl
        self.audioUrl = audioUrl
        self.audioMediaAssetId = audioMediaAssetId
        self.durationMs = durationMs
        self.voice = voice
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
        self.messageOrigin = messageOrigin
    }
}

/// Botón de mensaje interactivo (máx 3; título máx 20 chars, id máx 256).
struct InteractiveMessageButton: Encodable, Sendable {
    var id: String
    var title: String
}

/// Botón de URL de mensaje interactivo.
struct InteractiveMessageURLButton: Encodable, Sendable {
    var title: String
    var url: String
}

/// `POST /messages/interactive` (doc 05 §2.8 — sin UI en el composer móvil;
/// paridad opcional).
struct InteractiveMessageSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var body: String
    var buttons: [InteractiveMessageButton]?
    var urlButton: InteractiveMessageURLButton?
    var externalId: String?
    var transport: WhatsAppSendTransport?
    var phoneNumberId: String?

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        body: String,
        buttons: [InteractiveMessageButton]? = nil,
        urlButton: InteractiveMessageURLButton? = nil,
        externalId: String? = MessageExternalIdFactory.make("interactive"),
        transport: WhatsAppSendTransport? = .api,
        phoneNumberId: String? = nil
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.body = body
        self.buttons = buttons
        self.urlButton = urlButton
        self.externalId = externalId
        self.transport = transport
        self.phoneNumberId = phoneNumberId
    }
}

/// `POST /templates/send` (doc 05 §2.9). Las plantillas NO validan la ventana
/// de 24 h (son la forma de reabrirla). Si no mandas `variables` ni
/// `components`, el backend construye los defaults con datos del contacto.
struct TemplateSendRequest: Encodable, Sendable {
    var to: String
    var from: String?
    var contactId: String?
    var templateId: String?
    var templateName: String?
    var language: String
    /// `{ "1": "Juan" }` o `["Juan"]`.
    var variables: RistakJSONValue?
    /// Formato Meta components.
    var components: RistakJSONValue?
    var externalId: String?
    var phoneNumberId: String?

    init(
        to: String,
        from: String? = nil,
        contactId: String? = nil,
        templateId: String? = nil,
        templateName: String? = nil,
        language: String,
        variables: RistakJSONValue? = nil,
        components: RistakJSONValue? = nil,
        externalId: String? = MessageExternalIdFactory.template(),
        phoneNumberId: String? = nil
    ) {
        self.to = to
        self.from = from
        self.contactId = contactId
        self.templateId = templateId
        self.templateName = templateName
        self.language = language
        self.variables = variables
        self.components = components
        self.externalId = externalId
        self.phoneNumberId = phoneNumberId
    }
}

// MARK: - Meta social (`/api/whatsapp-api/meta/social/*`)

/// `POST /meta/social/messages/text` (doc 05 §3.1). Texto DM.
struct MetaSocialTextSendRequest: Encodable, Sendable {
    var contactId: String
    var platform: MetaSocialPlatform
    var message: String
    var externalId: String?
    var replyToMessageId: String?
    var replyToProviderMessageId: String?

    init(
        contactId: String,
        platform: MetaSocialPlatform,
        message: String,
        externalId: String? = MessageExternalIdFactory.meta(),
        replyToMessageId: String? = nil,
        replyToProviderMessageId: String? = nil
    ) {
        self.contactId = contactId
        self.platform = platform
        self.message = message
        self.externalId = externalId
        self.replyToMessageId = replyToMessageId
        self.replyToProviderMessageId = replyToProviderMessageId
    }
}

/// `POST /meta/social/messages/audio` (doc 05 §3.2). Nota de voz/audio sin texto.
struct MetaSocialAudioSendRequest: Encodable, Sendable {
    var contactId: String
    var platform: MetaSocialPlatform
    var audioDataUrl: String?
    var audioUrl: String?
    var audioMediaAssetId: String?
    var durationMs: Double?
    var externalId: String?
    var replyToMessageId: String?
    var replyToProviderMessageId: String?

    init(
        contactId: String,
        platform: MetaSocialPlatform,
        audioDataUrl: String? = nil,
        audioUrl: String? = nil,
        audioMediaAssetId: String? = nil,
        durationMs: Double? = nil,
        externalId: String? = MessageExternalIdFactory.metaAudio(),
        replyToMessageId: String? = nil,
        replyToProviderMessageId: String? = nil
    ) {
        self.contactId = contactId
        self.platform = platform
        self.audioDataUrl = audioDataUrl
        self.audioUrl = audioUrl
        self.audioMediaAssetId = audioMediaAssetId
        self.durationMs = durationMs
        self.externalId = externalId
        self.replyToMessageId = replyToMessageId
        self.replyToProviderMessageId = replyToProviderMessageId
    }
}

/// `POST /meta/social/messages/reaction` (doc 05 §3.3). SOLO `❤️`;
/// otro emoji → 400 "Meta solo permite reaccionar con corazón en este canal."
struct MetaSocialReactionSendRequest: Encodable, Sendable {
    var contactId: String
    var platform: MetaSocialPlatform
    var emoji: String
    var targetMessageId: String?
    var targetProviderMessageId: String?
    var externalId: String?

    init(
        contactId: String,
        platform: MetaSocialPlatform,
        emoji: String = "❤️",
        targetMessageId: String? = nil,
        targetProviderMessageId: String? = nil,
        externalId: String? = MessageExternalIdFactory.reaction()
    ) {
        self.contactId = contactId
        self.platform = platform
        self.emoji = emoji
        self.targetMessageId = targetMessageId
        self.targetProviderMessageId = targetProviderMessageId
        self.externalId = externalId
    }
}

/// `POST /meta/social/comments/reply` (doc 05 §3.4).
struct MetaCommentReplyRequest: Encodable, Sendable {
    var contactId: String
    var platform: MetaSocialPlatform
    var message: String
    /// `'public' | 'private'` (default backend: private).
    var replyType: String
    /// Default backend: último comentario inbound del contacto.
    var commentId: String?
    var postId: String?
    var externalId: String?

    init(
        contactId: String,
        platform: MetaSocialPlatform,
        message: String,
        replyType: String = "private",
        commentId: String? = nil,
        postId: String? = nil,
        externalId: String? = MessageExternalIdFactory.comment()
    ) {
        self.contactId = contactId
        self.platform = platform
        self.message = message
        self.replyType = replyType
        self.commentId = commentId
        self.postId = postId
        self.externalId = externalId
    }
}

/// Publicación FB/IG (`GET /meta/social/posts`, doc 05 §3.4).
struct MetaSocialPost: Decodable, Identifiable, Sendable {
    let id: String
    /// `'facebook' | 'instagram'`.
    let platform: String
    let type: String?
    let message: String?
    let imageUrl: String?
    let permalink: String?
    let postedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, platform, type, message, imageUrl, permalink, postedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        platform = container.flexibleString(forKey: .platform) ?? ""
        type = container.flexibleString(forKey: .type)
        message = container.flexibleString(forKey: .message)
        imageUrl = container.flexibleString(forKey: .imageUrl)
        permalink = container.flexibleString(forKey: .permalink)
        postedAt = container.flexibleString(forKey: .postedAt)
    }
}

/// Respuesta de posts — SIN clave `data`: `{ success, posts, total, hasMore }`.
struct MetaSocialPostList: Decodable, Sendable {
    let posts: [MetaSocialPost]
    let total: Int
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case posts, total, hasMore
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        posts = (try? container.decodeIfPresent([MetaSocialPost].self, forKey: .posts)) ?? []
        total = container.flexibleInt(forKey: .total) ?? posts.count
        hasMore = container.flexibleBool(forKey: .hasMore) ?? false
    }
}

// MARK: - HighLevel (`POST /api/highlevel/conversations/messages`, doc 05 §4)

/// Adjunto en data URL para HighLevel (el backend lo hospeda).
struct HighLevelAttachmentDataUrl: Encodable, Sendable {
    var dataUrl: String
    var filename: String?
    var mimeType: String?
    /// `'image' | 'video' | 'audio' | 'document'`.
    var kind: String?

    init(dataUrl: String, filename: String? = nil, mimeType: String? = nil, kind: String? = nil) {
        self.dataUrl = dataUrl
        self.filename = filename
        self.mimeType = mimeType
        self.kind = kind
    }
}

struct HighLevelMessageSendRequest: Encodable, Sendable {
    var contactId: String
    /// `'whatsapp_api' | 'sms_qr' | 'messenger' | 'instagram' | 'email' | 'webchat'`.
    var channel: String
    var message: String?
    /// URLs públicas ya hospedadas.
    var attachments: [String]?
    /// IDs emitidos por `/media/upload`; el backend los valida contra el tenant.
    var attachmentMediaAssetIds: [String]?
    var attachmentDataUrls: [HighLevelAttachmentDataUrl]?
    var audioDataUrl: String?
    var audioUrl: String?
    var audioMediaAssetId: String?
    var durationMs: Double?
    var fromNumber: String?
    var toNumber: String?
    var conversationProviderId: String?
    var externalId: String?
    /// Solo channel=email.
    var subject: String?
    var html: String?

    init(
        contactId: String,
        channel: String,
        message: String? = nil,
        attachments: [String]? = nil,
        attachmentMediaAssetIds: [String]? = nil,
        attachmentDataUrls: [HighLevelAttachmentDataUrl]? = nil,
        audioDataUrl: String? = nil,
        audioUrl: String? = nil,
        audioMediaAssetId: String? = nil,
        durationMs: Double? = nil,
        fromNumber: String? = nil,
        toNumber: String? = nil,
        conversationProviderId: String? = nil,
        externalId: String? = MessageExternalIdFactory.highLevel(),
        subject: String? = nil,
        html: String? = nil
    ) {
        self.contactId = contactId
        self.channel = channel
        self.message = message
        self.attachments = attachments
        self.attachmentMediaAssetIds = attachmentMediaAssetIds
        self.attachmentDataUrls = attachmentDataUrls
        self.audioDataUrl = audioDataUrl
        self.audioUrl = audioUrl
        self.audioMediaAssetId = audioMediaAssetId
        self.durationMs = durationMs
        self.fromNumber = fromNumber
        self.toNumber = toNumber
        self.conversationProviderId = conversationProviderId
        self.externalId = externalId
        self.subject = subject
        self.html = html
    }
}

// MARK: - Correo SMTP propio (`POST /api/email/send`, doc 05 §5)

struct EmailSendRequest: Encodable, Sendable {
    var contactId: String?
    var to: String?
    var subject: String
    var text: String?
    var html: String?
    var replyTo: String?
    var externalId: String?
    var includeSignature: Bool

    init(
        contactId: String? = nil,
        to: String? = nil,
        subject: String,
        text: String? = nil,
        html: String? = nil,
        replyTo: String? = nil,
        externalId: String? = MessageExternalIdFactory.email(),
        includeSignature: Bool = true
    ) {
        self.contactId = contactId
        self.to = to
        self.subject = subject
        self.text = text
        self.html = html
        self.replyTo = replyTo
        self.externalId = externalId
        self.includeSignature = includeSignature
    }
}

// MARK: - Respuestas de envío

/// Eco de media enviado en la respuesta (`image|video|audio|document|localMedia`).
struct SentMediaEcho: Decodable, Sendable {
    let link: String?
    let url: String?
    let mediaUrl: String?
    let publicUrl: String?
    let mimeType: String?
    let filename: String?
    let caption: String?
    let durationMs: Double?
    let voice: Bool?
    let size: Double?

    enum CodingKeys: String, CodingKey {
        case link, url, mediaUrl, publicUrl
        case mimeType, mimetype
        case filename, fileName
        case caption, durationMs, voice, ptt, size
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        link = container.flexibleString(forKey: .link)
        url = container.flexibleString(forKey: .url)
        mediaUrl = container.flexibleString(forKey: .mediaUrl)
        publicUrl = container.flexibleString(forKey: .publicUrl)
        mimeType = container.flexibleString(forKey: .mimeType) ?? container.flexibleString(forKey: .mimetype)
        filename = container.flexibleString(forKey: .filename) ?? container.flexibleString(forKey: .fileName)
        caption = container.flexibleString(forKey: .caption)
        durationMs = container.flexibleDouble(forKey: .durationMs)
        voice = container.flexibleBool(forKey: .voice) ?? container.flexibleBool(forKey: .ptt)
        size = container.flexibleDouble(forKey: .size)
    }

    /// Primera URL usable para pintar el preview del globo.
    var bestUrl: String? {
        for candidate in [mediaUrl, publicUrl, link, url] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return nil
    }
}

/// Eco de ubicación enviada.
struct SentLocationEcho: Decodable, Sendable {
    let latitude: Double?
    let longitude: Double?
    let name: String?
    let address: String?
    let url: String?

    enum CodingKeys: String, CodingKey {
        case latitude, longitude, name, address, url
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        latitude = container.flexibleDouble(forKey: .latitude)
        longitude = container.flexibleDouble(forKey: .longitude)
        name = container.flexibleString(forKey: .name)
        address = container.flexibleString(forKey: .address)
        url = container.flexibleString(forKey: .url)
    }
}

/// Estado semántico del resultado. Un HTTP 2xx sólo dice que el backend pudo
/// procesar la solicitud; el proveedor todavía puede dejarla pendiente o
/// rechazarla dentro del mismo payload.
enum ChatSendDeliveryDisposition: Equatable {
    case failed
    case pending
    case settled

    static func resolve(status: String?, hasError: Bool = false) -> Self {
        if hasError { return .failed }
        let normalized = (status ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")

        if ["error", "failed", "failure", "undelivered", "bounced", "rejected"].contains(normalized) {
            return .failed
        }
        if ["pending", "queued", "sending", "processing", "accepted"].contains(normalized)
            || normalized.hasPrefix("enviando") {
            return .pending
        }
        return .settled
    }

    var shouldRetainRetryPayload: Bool {
        self == .failed || self == .pending
    }
}

/// Respuesta común de TODOS los envíos (doc 05 §2 y §4): mensaje del
/// proveedor + extras de fallback QR / fallback WhatsApp→SMS de HighLevel.
struct MessageSendResult: Decodable, Sendable {
    let id: String?
    /// Id remoto usado por HighLevel Conversations.
    let messageId: String?
    let wamid: String?
    let remoteMessageId: String?
    /// Id de la fila local persistida — usar para reconciliar el globo optimista.
    let localMessageId: String?
    let status: String?
    /// Transporte REAL usado (`'api' | 'qr'` o `ghl_*`).
    let transport: String?
    let fallback: Bool
    let fallbackFrom: String?
    let fallbackReason: String?
    let routingReason: String?
    // HighLevel:
    let channel: String?
    let requestedChannel: String?
    let channelLabel: String?
    let requestedChannelLabel: String?
    let fallbackApplied: Bool
    let replyWindowOpen: Bool?
    let replyWindowSource: String?
    let lastInboundAt: String?
    let contactId: String?
    let highLevelContactId: String?
    // Meta:
    let platform: String?
    let provider: String?
    // Ecos de contenido:
    let image: SentMediaEcho?
    let video: SentMediaEcho?
    let audio: SentMediaEcho?
    let document: SentMediaEcho?
    let localMedia: SentMediaEcho?
    let location: SentLocationEcho?

    enum CodingKeys: String, CodingKey {
        case id, messageId, wamid, remoteMessageId, localMessageId, status, transport
        case fallback, fallbackFrom, fallbackReason, routingReason
        case channel, requestedChannel, channelLabel, requestedChannelLabel
        case fallbackApplied, replyWindowOpen, replyWindowSource, lastInboundAt
        case contactId, highLevelContactId, platform, provider
        case image, video, audio, document, localMedia, location
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        messageId = container.flexibleString(forKey: .messageId)
        wamid = container.flexibleString(forKey: .wamid)
        remoteMessageId = container.flexibleString(forKey: .remoteMessageId)
        localMessageId = container.flexibleString(forKey: .localMessageId)
        status = container.flexibleString(forKey: .status)
        transport = container.flexibleString(forKey: .transport)
        fallback = container.flexibleBool(forKey: .fallback) ?? false
        fallbackFrom = container.flexibleString(forKey: .fallbackFrom)
        fallbackReason = container.flexibleString(forKey: .fallbackReason)
        routingReason = container.flexibleString(forKey: .routingReason)
        channel = container.flexibleString(forKey: .channel)
        requestedChannel = container.flexibleString(forKey: .requestedChannel)
        channelLabel = container.flexibleString(forKey: .channelLabel)
        requestedChannelLabel = container.flexibleString(forKey: .requestedChannelLabel)
        fallbackApplied = container.flexibleBool(forKey: .fallbackApplied) ?? false
        replyWindowOpen = container.flexibleBool(forKey: .replyWindowOpen)
        replyWindowSource = container.flexibleString(forKey: .replyWindowSource)
        lastInboundAt = container.flexibleString(forKey: .lastInboundAt)
        contactId = container.flexibleString(forKey: .contactId)
        highLevelContactId = container.flexibleString(forKey: .highLevelContactId)
        platform = container.flexibleString(forKey: .platform)
        provider = container.flexibleString(forKey: .provider)
        image = try? container.decodeIfPresent(SentMediaEcho.self, forKey: .image)
        video = try? container.decodeIfPresent(SentMediaEcho.self, forKey: .video)
        audio = try? container.decodeIfPresent(SentMediaEcho.self, forKey: .audio)
        document = try? container.decodeIfPresent(SentMediaEcho.self, forKey: .document)
        localMedia = try? container.decodeIfPresent(SentMediaEcho.self, forKey: .localMedia)
        location = try? container.decodeIfPresent(SentLocationEcho.self, forKey: .location)
    }

    /// Subtítulo del globo cuando hubo fallback (RN lee
    /// `routingReason || fallbackReason`).
    var resolvedRoutingReason: String? {
        if let routingReason, !routingReason.isEmpty { return routingReason }
        if let fallbackReason, !fallbackReason.isEmpty { return fallbackReason }
        return nil
    }

    var deliveryDisposition: ChatSendDeliveryDisposition {
        ChatSendDeliveryDisposition.resolve(status: status)
    }

    var resolvedProviderMessageId: String? {
        for candidate in [wamid, remoteMessageId, messageId, id] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return nil
    }
}

/// Reglas de la ventana de 24 h de WhatsApp API (doc 05 §1.1). Cuando el
/// backend rechaza con 400 y una de estas razones, el cliente debe ofrecer
/// PLANTILLAS (flujo "400-con-razón-en-español").
enum WhatsAppReplyWindowRules {
    /// Ventana cerrada.
    static let closedReason = "La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas."
    /// Ventana desconocida (sin inbound registrado).
    static let unknownReason = "No hay una respuesta reciente del cliente registrada; WhatsApp API solo permite mensajes libres dentro de la ventana de 24 horas."

    static let windowDuration: TimeInterval = 24 * 60 * 60

    /// ¿El error de envío es un bloqueo por ventana de 24 h?
    static func isReplyWindowError(_ error: Error) -> Bool {
        guard let apiError = error as? RistakAPIError, apiError.status == 400 else { return false }
        let message = apiError.message
        return message == closedReason || message == unknownReason
            || (message.contains("24 horas") && message.localizedCaseInsensitiveContains("plantilla"))
    }

    /// Preflight cliente: ¿la ventana está abierta dado el último inbound?
    static func isWindowOpen(lastInboundDate: Date?, now: Date = Date()) -> Bool {
        guard let lastInboundDate else { return false }
        return now.timeIntervalSince(lastInboundDate) < windowDuration
    }

    /// Selección de transporte estricta: la ventana de conversación nunca
    /// convierte al QR en canal primario. QR sólo aplica cuando la API oficial
    /// de ese número no está disponible.
    static func resolveTransport(apiAvailable: Bool, qrReady: Bool) -> WhatsAppSendTransport {
        qrReady && !apiAvailable ? .qr : .api
    }

    static func requiresOfficialTemplate(apiAvailable: Bool, replyWindowOpen: Bool) -> Bool {
        apiAvailable && !replyWindowOpen
    }
}

// NOTA plantillas (doc 05 §2.9): el modelo `WhatsAppTemplate` y el resumen
// `WhatsAppTemplatesSummary` viven en Core/Models/SettingsModels.swift
// (compartidos con Ajustes); `TemplatesService` los reutiliza. Solo
// `isApproved` se puede enviar.

// MARK: - Agente conversacional (doc 05 §6)

/// Acciones de `POST /api/conversational-agent/states/:contactId`.
enum ConversationAgentAction: String, Encodable, Sendable {
    case pause
    case resume
    case takeOver = "take_over"
    case skip
    case activate
    case clearSignal = "clear_signal"
}

/// Estado del agente conversacional por contacto (doc 05 §6.1).
struct ConversationAgentState: Decodable, Sendable, Identifiable {
    let id: String?
    let contactId: String
    let agentId: String?
    let agentName: String?
    /// `'active'|'paused'|'human'|'skipped'|'completed'|'discarded'`.
    let status: String
    let pausedUntilAt: String?
    let signal: String?
    let signalReason: String?
    let signalSummary: String?
    let signalAt: String?
    let lastInboundMessageId: String?
    let lastAnsweredInboundMessageId: String?
    let lastReplyAt: String?
    let followUpBaseMessageId: String?
    let followUpSentCount: Int?
    let followUpLastSentAt: String?
    let activatedAt: String?
    /// `'manual' | 'automatic'`.
    let activationSource: String?
    let activatedBy: String?
    let updatedBy: String?
    let agentEnabled: Bool?
    let agentHideAttendedNotifications: Bool?
    let closingContext: RistakJSONValue?
    let updatedAt: String?
    let contactName: String?
    let contactPhone: String?

    enum CodingKeys: String, CodingKey {
        case id, contactId, agentId, agentName, status, pausedUntilAt
        case signal, signalReason, signalSummary, signalAt
        case lastInboundMessageId, lastAnsweredInboundMessageId, lastReplyAt
        case followUpBaseMessageId, followUpSentCount, followUpLastSentAt
        case activatedAt, activationSource, activatedBy, updatedBy
        case agentEnabled, agentHideAttendedNotifications
        case closingContext, updatedAt, contactName, contactPhone
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        contactId = container.flexibleString(forKey: .contactId) ?? ""
        agentId = container.flexibleString(forKey: .agentId)
        agentName = container.flexibleString(forKey: .agentName)
        status = container.flexibleString(forKey: .status) ?? ""
        pausedUntilAt = container.flexibleString(forKey: .pausedUntilAt)
        signal = container.flexibleString(forKey: .signal)
        signalReason = container.flexibleString(forKey: .signalReason)
        signalSummary = container.flexibleString(forKey: .signalSummary)
        signalAt = container.flexibleString(forKey: .signalAt)
        lastInboundMessageId = container.flexibleString(forKey: .lastInboundMessageId)
        lastAnsweredInboundMessageId = container.flexibleString(forKey: .lastAnsweredInboundMessageId)
        lastReplyAt = container.flexibleString(forKey: .lastReplyAt)
        followUpBaseMessageId = container.flexibleString(forKey: .followUpBaseMessageId)
        followUpSentCount = container.flexibleInt(forKey: .followUpSentCount)
        followUpLastSentAt = container.flexibleString(forKey: .followUpLastSentAt)
        activatedAt = container.flexibleString(forKey: .activatedAt)
        activationSource = container.flexibleString(forKey: .activationSource)
        activatedBy = container.flexibleString(forKey: .activatedBy)
        updatedBy = container.flexibleString(forKey: .updatedBy)
        agentEnabled = container.flexibleBool(forKey: .agentEnabled)
        agentHideAttendedNotifications = container.flexibleBool(forKey: .agentHideAttendedNotifications)
        closingContext = try? container.decodeIfPresent(RistakJSONValue.self, forKey: .closingContext)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        contactName = container.flexibleString(forKey: .contactName)
        contactPhone = container.flexibleString(forKey: .contactPhone)
    }

    /// Estados con señal pendiente (para filas prioritarias, doc 03 §4.2.4).
    var hasPendingSignal: Bool {
        guard let signal, !signal.isEmpty else { return false }
        return !["human", "skipped", "discarded"].contains(status.lowercased())
    }

    /// La fila todavía referencia a un agente configurado. Se mantiene separada
    /// de la asignación viva para conservar avisos terminales sin volver a pintar
    /// el robot ni habilitar controles del agente.
    var referencesExistingAgent: Bool {
        guard let agentId,
              !agentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if let agentName,
           !agentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        return agentEnabled != nil
    }

    /// Fila ligada a un agente REALMENTE asignado y que aún existe. Una
    /// asignación viva solo puede estar `active` o `paused`; `human`, `skipped`,
    /// `completed` y `discarded` conservan historial, pero el agente ya salió del
    /// chat.
    var isAssignedExistingAgent: Bool {
        ["active", "paused"].contains(status.lowercased()) && referencesExistingAgent
    }

    var isPausedAssignment: Bool {
        isAssignedExistingAgent && status.lowercased() == "paused"
    }

    /// El backend conserva un estado por canal para claims y entregas, pero la
    /// UI controla agentes, no filas. Un mismo agentId activo en WhatsApp y SMS
    /// debe aparecer una sola vez; si difieren, el estado activo manda al pausado.
    static func uniqueAssignedStates(from states: [ConversationAgentState]) -> [ConversationAgentState] {
        var result: [ConversationAgentState] = []
        var indexByAgentID: [String: Int] = [:]

        for state in states where state.isAssignedExistingAgent {
            let agentID = (state.agentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !agentID.isEmpty else { continue }

            if let index = indexByAgentID[agentID] {
                let current = result[index]
                let currentIsActive = current.status.lowercased() == "active"
                let candidateIsActive = state.status.lowercased() == "active"
                let candidateIsNewer = (state.updatedAt ?? "") > (current.updatedAt ?? "")
                if (!currentIsActive && candidateIsActive) ||
                    (currentIsActive == candidateIsActive && candidateIsNewer) {
                    result[index] = state
                }
                continue
            }

            indexByAgentID[agentID] = result.count
            result.append(state)
        }

        return result
    }
}
