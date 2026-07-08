import Foundation

// Contrato exacto: docs/research/04-conversation-thread.md.
// Port fiel de `mobile/src/format.ts` (`buildMessagesFromJourney`,
// `mergeChatMessagesById` y helpers) con las correcciones del audit:
// - id estable con cadena de candidatos y huella djb2 (NUNCA índice del array),
// - `errorReason` con la lista completa de /movil,
// - set de direcciones outbound completo de /movil.

/// Evento crudo del journey (`GET /api/contacts/:id/journey`).
struct JourneyEvent: Decodable, Sendable {
    let type: String
    let date: String?
    let data: [String: RistakJSONValue]

    enum CodingKeys: String, CodingKey {
        case type, date, data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = container.flexibleString(forKey: .type) ?? ""
        date = container.flexibleString(forKey: .date)
        if let object = try? container.decodeIfPresent([String: RistakJSONValue].self, forKey: .data) {
            data = object
        } else {
            data = [:]
        }
    }
}

/// Dirección normalizada de un mensaje.
enum ChatMessageDirection: String, Sendable, Equatable {
    case inbound
    case outbound
    case system
}

/// Adjunto de un mensaje de chat (doc 04 §3).
struct ChatAttachment: Sendable, Equatable {
    enum Kind: String, Sendable {
        case image, video, audio, document, file
    }

    var type: Kind
    var url: String?
    var dataUrl: String?
    var name: String?
    var mimeType: String?
    var isGif: Bool
    var durationMs: Double?
    var size: Double?
    var caption: String?

    init(
        type: Kind,
        url: String? = nil,
        dataUrl: String? = nil,
        name: String? = nil,
        mimeType: String? = nil,
        isGif: Bool = false,
        durationMs: Double? = nil,
        size: Double? = nil,
        caption: String? = nil
    ) {
        self.type = type
        self.url = url
        self.dataUrl = dataUrl
        self.name = name
        self.mimeType = mimeType
        self.isGif = isGif
        self.durationMs = durationMs
        self.size = size
        self.caption = caption
    }
}

/// Ubicación compartida en un mensaje.
struct ChatLocation: Sendable, Equatable {
    var latitude: Double
    var longitude: Double
    var name: String?
    var address: String?
    var url: String?

    init(latitude: Double, longitude: Double, name: String? = nil, address: String? = nil, url: String? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.name = name
        self.address = address
        self.url = url
    }

    static func googleMapsURL(latitude: Double, longitude: Double) -> String {
        let raw = "\(latitude),\(longitude)"
        let encoded = raw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? raw
        return "https://www.google.com/maps?q=\(encoded)"
    }
}

/// Reacción fusionada en su mensaje objetivo.
struct ChatMessageReaction: Sendable, Equatable, Identifiable {
    var id: String
    var emoji: String
    var direction: ChatMessageDirection?
}

/// Detalle de correo (doc 04 §3 `emailDetails`).
struct ChatEmailDetails: Sendable, Equatable {
    var subject: String
    var fromEmail: String
    var toEmail: String
    var ccEmail: String?
    var bccEmail: String?
    var replyTo: String
    var status: String
    var transport: String
    var body: String
    var bodyHtml: String?
}

/// Vista previa de link / cobro (doc 04 §7.5).
struct ChatLinkPreview: Sendable, Equatable {
    var kind: String?
    var title: String?
    var subtitle: String?
    var amountLabel: String?
    var providerLabel: String?
    var url: String?

    init(kind: String? = nil, title: String? = nil, subtitle: String? = nil, amountLabel: String? = nil, providerLabel: String? = nil, url: String? = nil) {
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.amountLabel = amountLabel
        self.providerLabel = providerLabel
        self.url = url
    }
}

/// Estado de palomitas de un mensaje saliente. Sets normalizados de `/movil`
/// (superset — audit doc 04 §7.2): las palomitas se derivan SOLO de `status`
/// (el journey NO trae `deliveredAt`/`readAt`).
enum ChatMessageReceiptStatus: String, Sendable {
    case failed
    case pending
    case read
    case delivered
    case sent
}

/// Modelo de mensaje del hilo (port de `mobile/src/types.ts:160-220`).
struct ChatMessage: Sendable, Equatable, Identifiable {
    /// Estable entre polls/páginas — ver `ChatJourneyParser.stableMessageId`.
    var id: String
    var contactId: String
    /// Timestamp crudo del backend (ISO o SQL); clave de orden.
    var date: String
    var direction: ChatMessageDirection
    var text: String
    var channel: String
    var status: String?
    var transport: String?
    var errorReason: String?
    var providerMessageId: String?
    var sentAt: String?
    var deliveredAt: String?
    var readAt: String?
    var scheduledAt: String?
    var scheduledMessageId: String?
    var messageType: String?
    var businessPhone: String?
    var businessPhoneNumberId: String?
    var routingReason: String?
    var replyToMessageId: String?
    var replyToProviderMessageId: String?
    var reactionEmoji: String?
    var reactionTargetMessageId: String?
    var reactionTargetProviderMessageId: String?
    var reactions: [ChatMessageReaction]
    var attachment: ChatAttachment?
    var location: ChatLocation?
    var isComment: Bool
    /// `'public' | 'private'` para respuestas a comentarios.
    var commentReplyMode: String?
    var linkPreview: ChatLinkPreview?
    var paymentPreview: ChatLinkPreview?
    var emailDetails: ChatEmailDetails?
    /// Solo mensajes optimistas locales.
    var pending: Bool
    var failed: Bool

    init(
        id: String,
        contactId: String,
        date: String,
        direction: ChatMessageDirection,
        text: String,
        channel: String,
        status: String? = nil,
        transport: String? = nil,
        errorReason: String? = nil,
        providerMessageId: String? = nil,
        sentAt: String? = nil,
        deliveredAt: String? = nil,
        readAt: String? = nil,
        scheduledAt: String? = nil,
        scheduledMessageId: String? = nil,
        messageType: String? = nil,
        businessPhone: String? = nil,
        businessPhoneNumberId: String? = nil,
        routingReason: String? = nil,
        replyToMessageId: String? = nil,
        replyToProviderMessageId: String? = nil,
        reactionEmoji: String? = nil,
        reactionTargetMessageId: String? = nil,
        reactionTargetProviderMessageId: String? = nil,
        reactions: [ChatMessageReaction] = [],
        attachment: ChatAttachment? = nil,
        location: ChatLocation? = nil,
        isComment: Bool = false,
        commentReplyMode: String? = nil,
        linkPreview: ChatLinkPreview? = nil,
        paymentPreview: ChatLinkPreview? = nil,
        emailDetails: ChatEmailDetails? = nil,
        pending: Bool = false,
        failed: Bool = false
    ) {
        self.id = id
        self.contactId = contactId
        self.date = date
        self.direction = direction
        self.text = text
        self.channel = channel
        self.status = status
        self.transport = transport
        self.errorReason = errorReason
        self.providerMessageId = providerMessageId
        self.sentAt = sentAt
        self.deliveredAt = deliveredAt
        self.readAt = readAt
        self.scheduledAt = scheduledAt
        self.scheduledMessageId = scheduledMessageId
        self.messageType = messageType
        self.businessPhone = businessPhone
        self.businessPhoneNumberId = businessPhoneNumberId
        self.routingReason = routingReason
        self.replyToMessageId = replyToMessageId
        self.replyToProviderMessageId = replyToProviderMessageId
        self.reactionEmoji = reactionEmoji
        self.reactionTargetMessageId = reactionTargetMessageId
        self.reactionTargetProviderMessageId = reactionTargetProviderMessageId
        self.reactions = reactions
        self.attachment = attachment
        self.location = location
        self.isComment = isComment
        self.commentReplyMode = commentReplyMode
        self.linkPreview = linkPreview
        self.paymentPreview = paymentPreview
        self.emailDetails = emailDetails
        self.pending = pending
        self.failed = failed
    }

    /// Fecha parseada (para orden/agrupación). Inválida → nil.
    var parsedDate: Date? {
        RistakDateParsing.date(fromISO: date)
    }

    /// Id que ven los proveedores (wamid/mid) o el local.
    var providerOrLocalId: String {
        if let providerMessageId, !providerMessageId.isEmpty { return providerMessageId }
        return id
    }

    /// ¿Es una burbuja de mensaje programado? (RN `isScheduledMessage`).
    var isScheduled: Bool {
        if let scheduledAt, !scheduledAt.isEmpty { return true }
        if let scheduledMessageId, !scheduledMessageId.isEmpty { return true }
        return (status ?? "").lowercased() == "scheduled"
    }

    /// Últimas 3 reacciones visibles (doc 04 §5).
    var visibleReactions: [ChatMessageReaction] {
        Array(reactions.suffix(3))
    }

    /// Palomitas para mensajes salientes, con los sets normalizados de /movil.
    var receiptStatus: ChatMessageReceiptStatus {
        let normalized = (status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if failed || ["error", "failed", "undelivered", "rejected"].contains(normalized)
            || (errorReason?.isEmpty == false) {
            return .failed
        }
        if pending || ["pending", "queued", "sending"].contains(normalized) || normalized.hasPrefix("enviando") {
            return .pending
        }
        if (readAt?.isEmpty == false) || ["read", "seen", "opened", "played"].contains(normalized) {
            return .read
        }
        if (deliveredAt?.isEmpty == false) || ["delivered", "delivery_ack"].contains(normalized) {
            return .delivered
        }
        return .sent
    }
}

// MARK: - Parser del journey (port de format.ts)

enum ChatJourneyParser {
    /// Tipos de mensaje soportados como globo.
    static let supportedMessageEventTypes: Set<String> = ["whatsapp_message", "meta_message", "email_message"]

    /// Construye los mensajes del hilo a partir de los eventos del journey.
    /// (`buildMessagesFromJourney`, format.ts:920-1009 + audit doc 04.)
    static func buildMessages(contactId: String, events: [JourneyEvent]) -> [ChatMessage] {
        var messages: [ChatMessage] = []
        messages.reserveCapacity(events.count)
        for event in events {
            guard let date = event.date, !date.isEmpty else { continue }
            if let message = parseEvent(event, date: date, contactId: contactId) {
                messages.append(message)
            }
        }
        return mergeById(messages)
    }

    private static func parseEvent(_ event: JourneyEvent, date: String, contactId: String) -> ChatMessage? {
        let data = event.data

        if event.type == "appointment_confirmation" {
            let title = readString(data, ["title"])
            let id = readStringOrNumber(data, ["id", "appointment_id"])
                ?? "appointment-confirmation-\(date)-\(djb2Base36(title))"
            return ChatMessage(
                id: id,
                contactId: contactId,
                date: date,
                direction: .system,
                text: title.isEmpty ? "Cita confirmada" : "Cita confirmada: \(title)",
                channel: event.type,
                status: "confirmed"
            )
        }

        guard supportedMessageEventTypes.contains(event.type) else { return nil }

        let messageType = readString(data, ["message_type", "messageType", "type"])
        let status = readString(data, ["status"])
        let emailDetails = event.type == "email_message" ? buildEmailDetails(data, status: status) : nil
        let attachment = mediaAttachment(from: data)
        let location = journeyLocation(from: data)
        let rawText: String
        if let emailDetails {
            rawText = emailMessageText(subject: emailDetails.subject, body: emailDetails.body)
        } else {
            rawText = readString(data, ["message_text", "message", "text", "body", "subject", "caption"])
        }
        let postDeleted = readBool(data["post_deleted"]) || readBool(data["postDeleted"])
            || readBool(data["post_removed"]) || readBool(data["postRemoved"])
            || readBool(data["post_unavailable"]) || readBool(data["postUnavailable"])

        var text = cleanRedundantRoutingText(
            cleanLocationText(
                cleanAttachmentText(rawText, attachment: attachment),
                location: location
            )
        )
        if text.isEmpty {
            text = commentFallbackText(messageType: messageType, status: status, postDeleted: postDeleted)
        }
        if text.isEmpty, attachment == nil, location == nil {
            text = mediaFallback(from: data)
        }

        if text.isEmpty, messageType.isEmpty, attachment == nil, location == nil, emailDetails == nil {
            return nil
        }

        let direction = normalizeDirection(readString(data, ["direction"]))
        let channel = readString(data, ["transport", "social_platform", "source"])
        let resolvedChannel = channel.isEmpty ? event.type : channel
        let id = stableMessageId(
            data: data,
            eventType: event.type,
            date: date,
            direction: direction,
            text: text,
            attachment: attachment,
            messageType: messageType
        )
        let normalizedType = messageType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        return ChatMessage(
            id: id,
            contactId: contactId,
            date: date,
            direction: direction,
            text: text,
            channel: resolvedChannel,
            status: status.isEmpty ? nil : status,
            transport: resolvedChannel,
            errorReason: nonEmpty(readString(data, [
                // Lista completa de /movil (audit doc 04 §3.1.12).
                "error_reason", "errorReason", "error", "message_error",
                "error_message", "errorMessage", "failure_reason", "failureReason",
                "reason", "error_code", "errorCode",
            ])),
            providerMessageId: nonEmpty(readString(data, ["provider_message_id", "providerMessageId", "whatsapp_message_id", "meta_message_id"])),
            sentAt: nonEmpty(messageTimestamp(data, ["sent_at", "sentAt", "message_sent_at", "messageSentAt", "created_at", "createdAt", "timestamp"])) ?? date,
            deliveredAt: nonEmpty(messageTimestamp(data, ["delivered_at", "deliveredAt", "delivery_at", "deliveryAt", "message_delivered_at", "messageDeliveredAt"])),
            readAt: nonEmpty(messageTimestamp(data, ["read_at", "readAt", "seen_at", "seenAt", "message_read_at", "messageReadAt", "played_at", "playedAt"])),
            messageType: messageType.isEmpty ? nil : messageType,
            businessPhone: nonEmpty(readString(data, ["business_phone", "businessPhone"])),
            businessPhoneNumberId: nonEmpty(readString(data, ["business_phone_number_id", "businessPhoneNumberId"])),
            routingReason: nonEmpty(cleanRedundantRoutingText(readString(data, ["routing_reason", "routingReason", "fallbackReason"]))),
            replyToMessageId: nonEmpty(readString(data, ["reply_to_message_id", "replyToMessageId"])),
            replyToProviderMessageId: nonEmpty(readString(data, ["reply_to_provider_message_id", "replyToProviderMessageId"])),
            reactionEmoji: nonEmpty(readString(data, ["reaction_emoji", "reactionEmoji"])),
            reactionTargetMessageId: nonEmpty(readString(data, ["reaction_target_message_id", "reactionTargetMessageId"])),
            reactionTargetProviderMessageId: nonEmpty(readString(data, ["reaction_target_provider_message_id", "reactionTargetProviderMessageId"])),
            attachment: attachment,
            location: location,
            isComment: isCommentMessageType(messageType),
            commentReplyMode: normalizedType == "comment_reply_public"
                ? "public"
                : (normalizedType == "comment_reply_private" ? "private" : nil),
            emailDetails: emailDetails
        )
    }

    // MARK: Merge + reacciones (`mergeChatMessagesById`, format.ts:880-918)

    static func mergeById(_ messages: [ChatMessage]) -> [ChatMessage] {
        // Dedup por id (último gana) conservando orden de primera aparición.
        var order: [String] = []
        var byLocalId: [String: ChatMessage] = [:]
        for message in messages where !message.id.isEmpty {
            if byLocalId[message.id] == nil { order.append(message.id) }
            byLocalId[message.id] = message
        }

        var byProviderId: [String: String] = [:] // providerId → id local
        for id in order {
            guard let message = byLocalId[id] else { continue }
            byProviderId[message.providerOrLocalId] = message.id
        }

        var visibleIds: [String] = []
        for id in order {
            guard let message = byLocalId[id] else { continue }
            let type = (message.messageType ?? "").lowercased()
            if type == "reaction", let emoji = message.reactionEmoji, !emoji.isEmpty {
                var targetId: String?
                if let localTarget = message.reactionTargetMessageId, byLocalId[localTarget] != nil {
                    targetId = localTarget
                } else if let providerTarget = message.reactionTargetProviderMessageId,
                          let mapped = byProviderId[providerTarget] {
                    targetId = mapped
                }
                if let targetId, var target = byLocalId[targetId] {
                    target.reactions.removeAll { $0.id == message.id }
                    target.reactions.append(
                        ChatMessageReaction(id: message.id, emoji: emoji, direction: message.direction)
                    )
                    byLocalId[targetId] = target
                    byProviderId[target.providerOrLocalId] = target.id
                    continue
                }
                // Objetivo fuera de la ventana cargada → se pinta como globo normal.
            }
            visibleIds.append(id)
        }

        let visible = visibleIds.compactMap { byLocalId[$0] }
        return visible.sorted { left, right in
            let leftDate = left.parsedDate ?? Date(timeIntervalSince1970: 0)
            let rightDate = right.parsedDate ?? Date(timeIntervalSince1970: 0)
            return leftDate < rightDate
        }
    }

    // MARK: Burbujas programadas (RN `buildScheduledMessages`, doc 04 §4.2)

    /// Estados que ya no se pintan como burbuja programada.
    private static let scheduledHiddenStatuses: Set<String> = ["cancelled", "canceled", "sent", "failed"]

    static func buildScheduledMessages(contactId: String, items: [ScheduledChatMessage]) -> [ChatMessage] {
        items.compactMap { item in
            let scheduledAt = item.scheduledAt.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !scheduledAt.isEmpty else { return nil }
            let status = item.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !scheduledHiddenStatuses.contains(status) else { return nil }
            let identity = item.id.isEmpty ? item.externalId : item.id
            let channel = !item.channel.isEmpty ? item.channel : (!item.transport.isEmpty ? item.transport : "whatsapp_api")
            return ChatMessage(
                id: "scheduled-\(identity)",
                contactId: contactId,
                date: scheduledAt,
                direction: .outbound,
                text: item.text.isEmpty ? "(mensaje programado)" : item.text,
                channel: channel,
                status: "scheduled",
                transport: item.transport.isEmpty ? "scheduled" : item.transport,
                providerMessageId: item.externalId.isEmpty ? nil : item.externalId,
                scheduledAt: scheduledAt,
                scheduledMessageId: item.id.isEmpty ? nil : item.id
            )
        }
    }

    /// Countdown del timer flotante de programados (RN
    /// `formatNativeScheduledCountdown`): `<60 min → "Nm"`, `<24 h → "Nh"`,
    /// si no `"Nd"` (ceil, mínimo 0).
    static func scheduledCountdownLabel(until target: Date, now: Date = Date()) -> String {
        let seconds = max(0, target.timeIntervalSince(now))
        let minutes = max(0, Int(ceil(seconds / 60)))
        if minutes < 60 { return "\(minutes)m" }
        let hours = max(0, Int(ceil(seconds / 3600)))
        if hours < 24 { return "\(hours)h" }
        let days = max(0, Int(ceil(seconds / 86400)))
        return "\(days)d"
    }

    // MARK: Id estable (doc 04 §3.1.11 — nunca usar índice del array)

    static func stableMessageId(
        data: [String: RistakJSONValue],
        eventType: String,
        date: String,
        direction: ChatMessageDirection,
        text: String,
        attachment: ChatAttachment?,
        messageType: String
    ) -> String {
        if let id = nonEmpty(readString(data, [
            "whatsapp_api_message_id",
            "whatsapp_message_id",
            "meta_social_message_id",
            "meta_message_id",
            "email_message_id",
        ])) {
            return id
        }
        // `attribution_record_id` es INTEGER: se convierte a string con prefijo
        // `attr-` para no chocar con ids numéricos de Meta.
        if let attributionId = readStringOrNumber(data, ["attribution_record_id"]) {
            return "attr-\(attributionId)"
        }
        let attachmentIdentity = attachment?.url ?? attachment?.name ?? ""
        let fingerprint = djb2Base36("\(text)|\(attachmentIdentity)|\(messageType)")
        return "\(eventType)-\(date)-\(direction.rawValue)-\(fingerprint)"
    }

    /// Hash djb2 en base36 (huella sintética de último recurso).
    static func djb2Base36(_ value: String) -> String {
        var hash: UInt32 = 5381
        for byte in value.utf8 {
            hash = (hash &<< 5) &+ hash &+ UInt32(byte)
        }
        return String(hash, radix: 36)
    }

    // MARK: Lecturas tolerantes (readString/readNumber/readBoolean de format.ts)

    static func readString(_ data: [String: RistakJSONValue], _ keys: [String]) -> String {
        for key in keys {
            if case .string(let value)? = data[key] {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return ""
    }

    /// Como `readString` pero acepta números (ids INTEGER).
    static func readStringOrNumber(_ data: [String: RistakJSONValue], _ keys: [String]) -> String? {
        for key in keys {
            switch data[key] {
            case .string(let value):
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            case .number(let value):
                if value == value.rounded(), abs(value) < 1e15 {
                    return String(Int64(value))
                }
                return String(value)
            default:
                continue
            }
        }
        return nil
    }

    static func readNumber(_ data: [String: RistakJSONValue], _ keys: [String]) -> Double? {
        for key in keys {
            switch data[key] {
            case .number(let value) where value.isFinite:
                return value
            case .string(let value):
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                if let number = Double(trimmed), number.isFinite { return number }
            default:
                continue
            }
        }
        return nil
    }

    static func readBool(_ value: RistakJSONValue?) -> Bool {
        switch value {
        case .bool(let bool): return bool
        case .number(let number): return number == 1
        case .string(let string):
            let normalized = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return ["1", "true", "yes", "si", "sí"].contains(normalized)
        default:
            return false
        }
    }

    static func pickNestedRecord(_ data: [String: RistakJSONValue], _ keys: [String]) -> [String: RistakJSONValue]? {
        for key in keys {
            if case .object(let object)? = data[key] { return object }
        }
        return nil
    }

    /// Timestamp normalizado a ISO (acepta string parseable o epoch numérico).
    static func messageTimestamp(_ data: [String: RistakJSONValue], _ keys: [String]) -> String {
        for key in keys {
            switch data[key] {
            case .string(let value):
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                if let date = RistakDateParsing.date(fromISO: trimmed) {
                    return RistakDateParsing.isoString(from: date)
                }
            case .number(let value):
                if let date = RistakDateParsing.date(fromEpoch: value) {
                    return RistakDateParsing.isoString(from: date)
                }
            default:
                continue
            }
        }
        return ""
    }

    static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    // MARK: Attachment (`getJourneyMediaAttachment`, format.ts:667-686)

    static func mediaAttachment(from data: [String: RistakJSONValue]) -> ChatAttachment? {
        var source = data
        if let nested = pickNestedRecord(data, ["media", "attachment", "file", "document", "image", "video", "audio"]) {
            source.merge(nested) { _, nestedValue in nestedValue }
        }
        let messageType = readString(source, ["message_type", "messageType", "type"])
        let mimeType = readString(source, ["media_mime_type", "mediaMimeType", "mimeType", "mime_type", "mimetype"])
        let name = readString(source, ["media_filename", "mediaFilename", "filename", "fileName", "name"])
        let mediaId = readString(source, ["media_id", "mediaId", "id"])
        let url = pickMediaUrl(source)
        guard let type = attachmentType(messageType: messageType, mimeType: mimeType, filename: name, mediaUrl: url) else {
            return nil
        }
        guard !url.isEmpty || !mediaId.isEmpty else { return nil }
        let probe = [messageType, mimeType, name, url].joined(separator: " ").lowercased()
        return ChatAttachment(
            type: type,
            url: url.isEmpty ? nil : url,
            name: attachmentFallbackName(type: type, name: name, mediaId: mediaId),
            mimeType: mimeType.isEmpty ? nil : mimeType,
            isGif: type == .image && probe.contains("gif"),
            durationMs: readNumber(source, ["durationMs", "duration_ms", "audio_duration_ms", "media_duration_ms"])
        )
    }

    static func pickMediaUrl(_ data: [String: RistakJSONValue]) -> String {
        readString(data, [
            "media_url", "mediaUrl", "media_link", "mediaLink",
            "image_url", "imageUrl", "video_url", "videoUrl",
            "audio_url", "audioUrl", "document_url", "documentUrl",
            "file_url", "fileUrl", "url", "link", "publicUrl", "public_url",
        ])
    }

    static func attachmentType(messageType: String, mimeType: String, filename: String, mediaUrl: String) -> ChatAttachment.Kind? {
        let probe = [messageType, mimeType, filename, mediaUrl]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()
        guard !probe.isEmpty else { return nil }
        if probe.contains("image") || probe.contains("photo") || probeMatchesExtension(probe, ["png", "jpg", "jpeg", "webp", "gif"]) {
            return .image
        }
        if probe.contains("video") || probeMatchesExtension(probe, ["mp4", "mov", "m4v", "webm"]) {
            return .video
        }
        if probe.contains("audio") || probe.contains("voice") || probeMatchesExtension(probe, ["mp3", "m4a", "ogg", "wav", "aac"]) {
            return .audio
        }
        if probe.contains("document") || probe.contains("file") || probeMatchesExtension(probe, ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt"]) {
            return .document
        }
        return nil
    }

    /// Equivalente a la regex `\.(ext)(\?|$)` del probe TS.
    private static func probeMatchesExtension(_ probe: String, _ extensions: [String]) -> Bool {
        for ext in extensions {
            let needle = ".\(ext)"
            var searchRange = probe.startIndex..<probe.endIndex
            while let range = probe.range(of: needle, range: searchRange) {
                let after = range.upperBound
                if after == probe.endIndex || probe[after] == "?" {
                    return true
                }
                searchRange = range.upperBound..<probe.endIndex
            }
        }
        return false
    }

    static func attachmentFallbackName(type: ChatAttachment.Kind, name: String, mediaId: String = "") -> String {
        if !name.isEmpty { return name }
        if !mediaId.isEmpty { return mediaId }
        switch type {
        case .image: return "Foto"
        case .video: return "Video"
        case .audio: return "Audio"
        case .document, .file: return "Documento"
        }
    }

    // MARK: Location (`getJourneyLocation`, format.ts:711-735)

    static func journeyLocation(from data: [String: RistakJSONValue]) -> ChatLocation? {
        var direct: [String: RistakJSONValue] = [:]
        direct["latitude"] = data["location_latitude"] ?? data["locationLatitude"] ?? data["latitude"] ?? data["lat"]
        direct["longitude"] = data["location_longitude"] ?? data["locationLongitude"] ?? data["longitude"] ?? data["lng"] ?? data["lon"]
        direct["name"] = data["location_name"] ?? data["locationName"] ?? data["name"]
        direct["address"] = data["location_address"] ?? data["locationAddress"] ?? data["address"]
        direct["url"] = data["location_url"] ?? data["locationUrl"] ?? data["url"]
        if let location = normalizeLocationValue(direct) { return location }

        var candidates: [RistakJSONValue?] = [data["location"], data["locationMessage"]]
        for parentKey in ["whatsappMessage", "whatsappInboundMessage", "message", "response", "request"] {
            if case .object(let parent)? = data[parentKey] {
                candidates.append(parent["location"])
            }
        }
        for candidate in candidates {
            if case .object(let object)? = candidate, let location = normalizeLocationValue(object) {
                return location
            }
        }
        return nil
    }

    static func normalizeLocationValue(_ object: [String: RistakJSONValue]) -> ChatLocation? {
        guard
            let latitude = readNumber(object, ["latitude", "lat", "degreesLatitude", "degrees_latitude"]),
            let longitude = readNumber(object, ["longitude", "lng", "lon", "degreesLongitude", "degrees_longitude"])
        else { return nil }
        let name = nonEmpty(readString(object, ["name", "title"]))
        let address = nonEmpty(readString(object, ["address", "description"]))
        let url = nonEmpty(readString(object, ["url", "href"]))
        return ChatLocation(
            latitude: latitude,
            longitude: longitude,
            name: name,
            address: address,
            url: url ?? ChatLocation.googleMapsURL(latitude: latitude, longitude: longitude)
        )
    }

    // MARK: Limpiezas de texto (format.ts:737-777)

    static func mediaFallback(from data: [String: RistakJSONValue]) -> String {
        let type = readString(data, ["message_type", "type"]).lowercased()
        let filename = readString(data, ["media_filename", "filename", "fileName"])
        if !filename.isEmpty { return filename }
        if type.contains("image") || type.contains("photo") { return "Foto" }
        if type.contains("video") { return "Video" }
        if type.contains("audio") || type.contains("voice") { return "Audio" }
        if type.contains("document") || type.contains("file") { return "Documento" }
        return "Mensaje"
    }

    static func cleanAttachmentText(_ text: String, attachment: ChatAttachment?) -> String {
        guard let attachment else { return text }
        let normalized = collapseWhitespace(text).lowercased()
        if normalized.isEmpty { return "" }
        let fallback = attachmentFallbackName(type: attachment.type, name: attachment.name ?? "").lowercased()
        if normalized == fallback || ["foto", "video", "audio", "documento", "archivo"].contains(normalized) {
            return ""
        }
        return text
    }

    static func cleanLocationText(_ text: String, location: ChatLocation?) -> String {
        guard location != nil else { return text }
        let normalized = collapseWhitespace(text).lowercased()
        if normalized.isEmpty || ["ubicacion", "ubicación", "location"].contains(normalized) {
            return ""
        }
        return text
    }

    /// Descartar frases redundantes de ruteo ("Capturado desde…", format.ts:763-777).
    static func cleanRedundantRoutingText(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        let normalized = collapseWhitespace(text).lowercased()
        let redundant: Set<String> = [
            "capturado desde la sesión de whatsapp web.",
            "capturado desde la sesion de whatsapp web.",
            "capturado desde la sesión api.",
            "capturado desde la sesion api.",
            "capturado desde la api.",
            "capturado desde whatsapp api.",
        ]
        return redundant.contains(normalized) ? "" : text
    }

    private static func collapseWhitespace(_ value: String) -> String {
        value
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    // MARK: Comentarios (format.ts:862-874)

    static func isCommentMessageType(_ messageType: String) -> Bool {
        let normalized = messageType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["comment", "comment_reply_public", "comment_reply_private"].contains(normalized)
    }

    static func commentFallbackText(messageType: String, status: String, postDeleted: Bool) -> String {
        let normalizedType = messageType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedStatus = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isCommentMessageType(normalizedType) else { return "" }
        if postDeleted || ["removed", "deleted", "delete", "remove", "hide", "hidden"].contains(normalizedStatus) {
            return "Comentario eliminado"
        }
        if normalizedType == "comment_reply_public" { return "Respuesta pública al comentario" }
        if normalizedType == "comment_reply_private" { return "Respuesta por privado al comentario" }
        return "Comentario sin texto"
    }

    // MARK: Email (format.ts:779-853)

    static func normalizeEmailBodyText(_ value: String) -> String {
        var text = value.replacingOccurrences(of: "\r\n", with: "\n")
        text = text.replacingOccurrences(of: "\r", with: "\n")
        // Colapsar espacios/tabs horizontales sin tocar saltos de línea.
        text = text.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func htmlToPlainEmailText(_ html: String) -> String {
        let value = html.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return "" }
        var text = value
        text = text.replacingOccurrences(of: "<style[\\s\\S]*?</style>", with: " ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<script[\\s\\S]*?</script>", with: " ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "</(p|div|li|tr|h[1-6])>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "&nbsp;", with: " ", options: .caseInsensitive)
        text = text.replacingOccurrences(of: "&amp;", with: "&", options: .caseInsensitive)
        text = text.replacingOccurrences(of: "&lt;", with: "<", options: .caseInsensitive)
        text = text.replacingOccurrences(of: "&gt;", with: ">", options: .caseInsensitive)
        text = text.replacingOccurrences(of: "&quot;", with: "\"", options: .caseInsensitive)
        text = text.replacingOccurrences(of: "&#39;", with: "'", options: .caseInsensitive)
        return normalizeEmailBodyText(text)
    }

    static func emailMessageText(subject: String, body: String) -> String {
        let cleanSubject = collapseWhitespace(subject)
        let cleanBody = normalizeEmailBodyText(body)
        if !cleanSubject.isEmpty && !cleanBody.isEmpty { return "\(cleanSubject)\n\(cleanBody)" }
        if !cleanSubject.isEmpty { return cleanSubject }
        if !cleanBody.isEmpty { return cleanBody }
        return "Correo electrónico"
    }

    static func buildEmailDetails(_ data: [String: RistakJSONValue], status: String) -> ChatEmailDetails? {
        let bodyHtml = readString(data, ["html_body", "htmlBody", "html", "body_html", "bodyHtml"])
        var body = normalizeEmailBodyText(readString(data, [
            "message_text", "messageText", "message", "body", "text",
            "message_body", "messageBody", "content",
        ]))
        if body.isEmpty {
            body = htmlToPlainEmailText(bodyHtml)
        }

        let details = ChatEmailDetails(
            subject: readString(data, ["subject", "asunto"]),
            fromEmail: readString(data, ["from_email", "fromEmail", "from", "sender", "sender_email", "senderEmail"]),
            toEmail: readString(data, ["to_email", "toEmail", "to", "recipient", "recipients", "recipient_email", "recipientEmail"]),
            ccEmail: nonEmpty(readString(data, ["cc_email", "ccEmail", "cc"])),
            bccEmail: nonEmpty(readString(data, ["bcc_email", "bccEmail", "bcc"])),
            replyTo: readString(data, ["reply_to", "replyTo"]),
            status: !status.isEmpty ? status : readString(data, ["status", "message_status", "messageStatus"]),
            transport: nonEmpty(readString(data, ["transport", "channel", "provider"])) ?? "email",
            body: body,
            bodyHtml: bodyHtml.isEmpty ? nil : bodyHtml
        )

        let hasContent = !details.subject.isEmpty || !details.fromEmail.isEmpty || !details.toEmail.isEmpty
            || details.ccEmail != nil || details.bccEmail != nil || !details.replyTo.isEmpty
            || !details.body.isEmpty || details.bodyHtml != nil
        return hasContent ? details : nil
    }

    // MARK: Dirección

    /// `normalizeDirection` + set outbound COMPLETO de /movil (audit doc 04 §10.14).
    static func normalizeDirection(_ value: String) -> ChatMessageDirection {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "system" { return .system }
        if ChatContact.outboundDirections.contains(normalized) { return .outbound }
        return .inbound
    }
}
