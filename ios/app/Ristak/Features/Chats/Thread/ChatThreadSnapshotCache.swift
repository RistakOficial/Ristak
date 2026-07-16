import Foundation

/// Caché instantánea del hilo (Round 6 #4): guarda los últimos N mensajes del
/// servidor por contacto bajo `chat:thread:<contactId>` en `RistakSnapshotCache`
/// para reabrir un chat mostrando los mensajes previos AL INSTANTE, y luego
/// revalidar (merge identity-preserving con ids estables).
///
/// `ChatMessage` (modelo de Core) NO es `Codable` porque se CONSTRUYE con el
/// parser del journey. Por eso serializamos con un DTO local `Codable` que
/// preserva TODOS los campos del mensaje (round-trip fiel): así un poll que
/// devuelve lo mismo que lo cacheado es un no-op de render (sin flash).
enum ChatThreadSnapshotCache {
    /// Tope de mensajes cacheados por hilo (los más recientes).
    static let maxMessages = 100

    /// Permiso monotónico reservado ANTES de iniciar un request. Dos cargas del
    /// mismo hilo pueden terminar fuera de orden; una respuesta antigua sólo
    /// puede persistir mientras ninguna respuesta más nueva haya hecho commit.
    struct WritePermit: Sendable {
        fileprivate let namespace: RistakSnapshotCache.NamespaceToken
        fileprivate let contactID: String
        fileprivate let version: UInt64
    }

    private struct WriteLane {
        var nextVersion: UInt64 = 0
        var committedVersion: UInt64 = 0
    }

    @MainActor private static var writeLaneNamespace: RistakSnapshotCache.NamespaceToken?
    @MainActor private static var writeLanes: [String: WriteLane] = [:]

    /// Los data URLs son el fallback legacy de transporte, no un formato de
    /// caché. Persistirlos duplica archivos en base64 y puede convertir 100
    /// mensajes en decenas o cientos de MB. URLs normales se conservan por
    /// compatibilidad con respuestas antiguas que usaron ese campo.
    nonisolated static func persistableMediaURL(_ rawValue: String?) -> String? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.lowercased().hasPrefix("data:") else { return nil }
        return rawValue
    }

    nonisolated static func persistableDataURL(_ rawValue: String?) -> String? {
        persistableMediaURL(rawValue)
    }

    // MARK: - API

    @MainActor
    static func load(contactID: String) -> [ChatMessage] {
        guard let data = RistakSnapshotCache.shared.rawData(for: ChatSnapshotKey.thread(contactID)),
              let dtos = try? JSONDecoder().decode([ThreadMessageDTO].self, from: data) else {
            return []
        }
        return dtos.map(\.message)
    }

    @MainActor
    static func lastUpdatedAt(contactID: String) -> Date? {
        RistakSnapshotCache.shared.value(
            Date.self,
            for: ChatSnapshotKey.threadUpdatedAt(contactID)
        )
    }

    /// Reserva el orden de una futura respuesta. `ifCurrent` evita que una
    /// tarea de la cuenta anterior siquiera obtenga turno en la cuenta actual.
    @MainActor
    static func beginWrite(
        contactID: String,
        ifCurrent expectedNamespace: RistakSnapshotCache.NamespaceToken? = nil
    ) -> WritePermit? {
        guard let namespace = RistakSnapshotCache.shared.namespaceToken(),
              expectedNamespace == nil || expectedNamespace == namespace,
              RistakSnapshotCache.shared.isCurrent(namespace) else { return nil }

        if writeLaneNamespace != namespace {
            writeLaneNamespace = namespace
            writeLanes.removeAll(keepingCapacity: true)
        }
        var lane = writeLanes[contactID] ?? WriteLane()
        lane.nextVersion &+= 1
        writeLanes[contactID] = lane
        return WritePermit(
            namespace: namespace,
            contactID: contactID,
            version: lane.nextVersion
        )
    }

    @MainActor
    static func save(
        _ messages: [ChatMessage],
        contactID: String,
        using suppliedPermit: WritePermit? = nil
    ) {
        // Construir los DTOs en main es barato (copia de valores). El encode de
        // hasta 100 mensajes (con adjuntos/reacciones/email) sí pesa, así que se
        // hace fuera del hilo principal para no provocar un stall al llegar cada
        // mensaje nuevo; luego se vuelve a main para escribir en la caché.
        guard let permit = suppliedPermit ?? beginWrite(contactID: contactID),
              permit.contactID == contactID else { return }
        let capped = messages.suffix(maxMessages).map(ThreadMessageDTO.init)
        Task.detached(priority: .utility) {
            let encoder = JSONEncoder()
            guard let data = try? encoder.encode(capped),
                  let timestamp = try? encoder.encode(Date()) else { return }
            await MainActor.run {
                _ = commitEncoded(
                    messagesData: data,
                    timestampData: timestamp,
                    using: permit
                )
            }
        }
    }

    /// Variante awaitable para precarga activa/background. El método no retorna
    /// hasta que la memoria ya contiene el hilo; con `flushToDisk` tampoco retorna
    /// hasta que el rename atómico de los snapshots terminó.
    @MainActor
    static func savePrepared(
        _ messages: [ChatMessage],
        contactID: String,
        flushToDisk: Bool,
        using permit: WritePermit
    ) async -> Bool {
        guard permit.contactID == contactID else { return false }
        let capped = messages.suffix(maxMessages).map(ThreadMessageDTO.init)
        guard RistakSnapshotCache.shared.isCurrent(permit.namespace) else { return false }
        let encoded = await Task.detached(priority: .utility) { () -> (Data, Data)? in
            let encoder = JSONEncoder()
            guard let messagesData = try? encoder.encode(capped),
                  let timestampData = try? encoder.encode(Date()) else { return nil }
            return (messagesData, timestampData)
        }.value
        guard !Task.isCancelled, let encoded else { return false }

        guard commitEncoded(
            messagesData: encoded.0,
            timestampData: encoded.1,
            using: permit
        ) else { return false }
        if flushToDisk {
            await RistakSnapshotCache.shared.flushPendingWrites()
            guard RistakSnapshotCache.shared.isCurrent(permit.namespace) else { return false }
        }
        return true
    }

    /// Commit indivisible desde MainActor: valida cuenta + versión antes de
    /// tocar memoria. Reservar una versión nueva no invalida una vieja por sí
    /// solo (el request nuevo podría fallar); únicamente un commit más nuevo la
    /// vuelve obsoleta.
    @MainActor
    private static func commitEncoded(
        messagesData: Data,
        timestampData: Data,
        using permit: WritePermit
    ) -> Bool {
        guard RistakSnapshotCache.shared.isCurrent(permit.namespace),
              writeLaneNamespace == permit.namespace,
              var lane = writeLanes[permit.contactID],
              permit.version <= lane.nextVersion,
              permit.version > lane.committedVersion else { return false }

        let storedMessages = RistakSnapshotCache.shared.storeRaw(
            messagesData,
            for: ChatSnapshotKey.thread(permit.contactID),
            ifCurrent: permit.namespace
        )
        let storedTimestamp = RistakSnapshotCache.shared.storeRaw(
            timestampData,
            for: ChatSnapshotKey.threadUpdatedAt(permit.contactID),
            ifCurrent: permit.namespace
        )
        guard storedMessages, storedTimestamp else { return false }
        lane.committedVersion = permit.version
        writeLanes[permit.contactID] = lane
        return true
    }

    // MARK: - Markers de actividad (pagos/citas)

    @MainActor
    static func loadMarkers(contactID: String) -> [ConversationActivityMarker] {
        guard let data = RistakSnapshotCache.shared.rawData(for: ChatSnapshotKey.threadMarkers(contactID)),
              let dtos = try? JSONDecoder().decode([ActivityMarkerDTO].self, from: data) else {
            return []
        }
        return dtos.map(\.marker)
    }

    @MainActor
    static func saveMarkers(_ markers: [ConversationActivityMarker], contactID: String) {
        let dtos = markers.map(ActivityMarkerDTO.init)
        let key = ChatSnapshotKey.threadMarkers(contactID)
        guard let namespace = RistakSnapshotCache.shared.namespaceToken() else { return }
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(dtos) else { return }
            await RistakSnapshotCache.shared.storeRaw(data, for: key, ifCurrent: namespace)
        }
    }

    // MARK: - Estado del agente conversacional (robot del header)

    /// Estado del agente cacheado para pintar el robot del header al instante.
    /// Decodifica `[ConversationAgentState].self` DIRECTO del JSON guardado por
    /// el DTO (round-trip por el `init(from:)` tolerante del modelo real).
    @MainActor
    static func load(agentStatesContactID contactID: String) -> [ConversationAgentState] {
        guard let data = RistakSnapshotCache.shared.rawData(for: ChatSnapshotKey.threadAgentStates(contactID)),
              let states = try? JSONDecoder().decode([ConversationAgentState].self, from: data) else {
            return []
        }
        return states
    }

    /// Guarda el estado RAW del agente (sin filtrar) del contacto. El encode se
    /// hace fuera de main para no provocar un stall en cada refresco.
    @MainActor
    static func save(_ states: [ConversationAgentState], contactID: String) {
        let dtos = states.map(AgentStateDTO.init)
        let key = ChatSnapshotKey.threadAgentStates(contactID)
        guard let namespace = RistakSnapshotCache.shared.namespaceToken() else { return }
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(dtos) else { return }
            await RistakSnapshotCache.shared.storeRaw(data, for: key, ifCurrent: namespace)
        }
    }
}

// MARK: - DTO Codable del estado del agente (espejo fiel de ConversationAgentState)

/// `ConversationAgentState` es Decodable-only (init(from:) tolerante, sin
/// `encode(to:)` simétrico). Este DTO ENCODEA con las MISMAS claves que
/// `ConversationAgentState.CodingKeys` (nombres por defecto), de modo que al
/// recargar decodificamos `[ConversationAgentState].self` DIRECTO del JSON
/// guardado — round-trip fiel por su `init(from:)`, sin tocar el modelo de Core.
/// `closingContext` es `RistakJSONValue?` (Codable simétrico): hoy no pinta UI,
/// pero incluirlo cuesta cero y deja el espejo completo.
private struct AgentStateDTO: Codable, Sendable {
    var id: String?
    var contactId: String
    var agentId: String?
    var agentName: String?
    var status: String
    var pausedUntilAt: String?
    var signal: String?
    var signalReason: String?
    var signalSummary: String?
    var signalAt: String?
    var lastInboundMessageId: String?
    var lastAnsweredInboundMessageId: String?
    var lastReplyAt: String?
    var followUpBaseMessageId: String?
    var followUpSentCount: Int?
    var followUpLastSentAt: String?
    var activatedAt: String?
    var activationSource: String?
    var activatedBy: String?
    var updatedBy: String?
    var agentEnabled: Bool?
    var agentHideAttendedNotifications: Bool?
    var closingContext: RistakJSONValue?
    var updatedAt: String?
    var contactName: String?
    var contactPhone: String?

    init(_ state: ConversationAgentState) {
        id = state.id
        contactId = state.contactId
        agentId = state.agentId
        agentName = state.agentName
        status = state.status
        pausedUntilAt = state.pausedUntilAt
        signal = state.signal
        signalReason = state.signalReason
        signalSummary = state.signalSummary
        signalAt = state.signalAt
        lastInboundMessageId = state.lastInboundMessageId
        lastAnsweredInboundMessageId = state.lastAnsweredInboundMessageId
        lastReplyAt = state.lastReplyAt
        followUpBaseMessageId = state.followUpBaseMessageId
        followUpSentCount = state.followUpSentCount
        followUpLastSentAt = state.followUpLastSentAt
        activatedAt = state.activatedAt
        activationSource = state.activationSource
        activatedBy = state.activatedBy
        updatedBy = state.updatedBy
        agentEnabled = state.agentEnabled
        agentHideAttendedNotifications = state.agentHideAttendedNotifications
        closingContext = state.closingContext
        updatedAt = state.updatedAt
        contactName = state.contactName
        contactPhone = state.contactPhone
    }
}

// MARK: - DTO Codable de marker de actividad

private struct ActivityMarkerDTO: Codable, Sendable {
    var id: String
    var kind: String
    var title: String
    var subtitle: String
    var amountLabel: String?
    var date: String

    init(_ marker: ConversationActivityMarker) {
        id = marker.id
        kind = marker.kind.rawValue
        title = marker.title
        subtitle = marker.subtitle
        amountLabel = marker.amountLabel
        date = marker.date
    }

    var marker: ConversationActivityMarker {
        ConversationActivityMarker(
            id: id,
            kind: ConversationActivityMarker.Kind(rawValue: kind) ?? .payment,
            title: title,
            subtitle: subtitle,
            amountLabel: amountLabel,
            date: date
        )
    }
}

// MARK: - DTOs Codable (espejo fiel de ChatMessage)

private struct ThreadMessageDTO: Codable, Sendable {
    var id: String
    var contactId: String
    var date: String
    var direction: String
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
    var sentByAgent: Bool?
    var agentId: String?
    var replyToMessageId: String?
    var replyToProviderMessageId: String?
    var reactionEmoji: String?
    var reactionTargetMessageId: String?
    var reactionTargetProviderMessageId: String?
    var reactions: [ReactionDTO]
    var attachment: AttachmentDTO?
    var location: LocationDTO?
    var isComment: Bool
    var commentReplyMode: String?
    var linkPreview: LinkPreviewDTO?
    var paymentPreview: LinkPreviewDTO?
    var emailDetails: EmailDetailsDTO?

    init(_ message: ChatMessage) {
        id = message.id
        contactId = message.contactId
        date = message.date
        direction = message.direction.rawValue
        text = message.text
        channel = message.channel
        status = message.status
        transport = message.transport
        errorReason = message.errorReason
        providerMessageId = message.providerMessageId
        sentAt = message.sentAt
        deliveredAt = message.deliveredAt
        readAt = message.readAt
        scheduledAt = message.scheduledAt
        scheduledMessageId = message.scheduledMessageId
        messageType = message.messageType
        businessPhone = message.businessPhone
        businessPhoneNumberId = message.businessPhoneNumberId
        routingReason = message.routingReason
        sentByAgent = message.sentByAgent
        agentId = message.agentId
        replyToMessageId = message.replyToMessageId
        replyToProviderMessageId = message.replyToProviderMessageId
        reactionEmoji = message.reactionEmoji
        reactionTargetMessageId = message.reactionTargetMessageId
        reactionTargetProviderMessageId = message.reactionTargetProviderMessageId
        reactions = message.reactions.map(ReactionDTO.init)
        attachment = message.attachment.map(AttachmentDTO.init)
        location = message.location.map(LocationDTO.init)
        isComment = message.isComment
        commentReplyMode = message.commentReplyMode
        linkPreview = message.linkPreview.map(LinkPreviewDTO.init)
        paymentPreview = message.paymentPreview.map(LinkPreviewDTO.init)
        emailDetails = message.emailDetails.map(EmailDetailsDTO.init)
    }

    /// Reconstruye el `ChatMessage`. Los mensajes cacheados son SIEMPRE del
    /// servidor (nunca optimistas), así que `pending`/`failed` quedan en falso.
    var message: ChatMessage {
        ChatMessage(
            id: id,
            contactId: contactId,
            date: date,
            direction: ChatMessageDirection(rawValue: direction) ?? .inbound,
            text: text,
            channel: channel,
            status: status,
            transport: transport,
            errorReason: errorReason,
            providerMessageId: providerMessageId,
            sentAt: sentAt,
            deliveredAt: deliveredAt,
            readAt: readAt,
            scheduledAt: scheduledAt,
            scheduledMessageId: scheduledMessageId,
            messageType: messageType,
            businessPhone: businessPhone,
            businessPhoneNumberId: businessPhoneNumberId,
            routingReason: routingReason,
            sentByAgent: sentByAgent == true,
            agentId: agentId,
            replyToMessageId: replyToMessageId,
            replyToProviderMessageId: replyToProviderMessageId,
            reactionEmoji: reactionEmoji,
            reactionTargetMessageId: reactionTargetMessageId,
            reactionTargetProviderMessageId: reactionTargetProviderMessageId,
            reactions: reactions.map(\.reaction),
            attachment: attachment?.attachment,
            location: location?.location,
            isComment: isComment,
            commentReplyMode: commentReplyMode,
            linkPreview: linkPreview?.linkPreview,
            paymentPreview: paymentPreview?.linkPreview,
            emailDetails: emailDetails?.details,
            pending: false,
            failed: false
        )
    }
}

private struct ReactionDTO: Codable, Sendable {
    var id: String
    var emoji: String
    var direction: String?

    init(_ reaction: ChatMessageReaction) {
        id = reaction.id
        emoji = reaction.emoji
        direction = reaction.direction?.rawValue
    }

    var reaction: ChatMessageReaction {
        ChatMessageReaction(
            id: id,
            emoji: emoji,
            direction: direction.flatMap(ChatMessageDirection.init(rawValue:))
        )
    }
}

private struct AttachmentDTO: Codable, Sendable {
    var type: String
    var url: String?
    var dataUrl: String?
    var name: String?
    var mimeType: String?
    var isGif: Bool
    var durationMs: Double?
    var size: Double?
    var caption: String?

    init(_ attachment: ChatAttachment) {
        type = attachment.type.rawValue
        url = ChatThreadSnapshotCache.persistableMediaURL(attachment.url)
        dataUrl = ChatThreadSnapshotCache.persistableDataURL(attachment.dataUrl)
        name = attachment.name
        mimeType = attachment.mimeType
        isGif = attachment.isGif
        durationMs = attachment.durationMs
        size = attachment.size
        caption = attachment.caption
    }

    var attachment: ChatAttachment {
        ChatAttachment(
            type: ChatAttachment.Kind(rawValue: type) ?? .file,
            url: url,
            dataUrl: dataUrl,
            name: name,
            mimeType: mimeType,
            isGif: isGif,
            durationMs: durationMs,
            size: size,
            caption: caption
        )
    }
}

private struct LocationDTO: Codable, Sendable {
    var latitude: Double
    var longitude: Double
    var name: String?
    var address: String?
    var url: String?

    init(_ location: ChatLocation) {
        latitude = location.latitude
        longitude = location.longitude
        name = location.name
        address = location.address
        url = location.url
    }

    var location: ChatLocation {
        ChatLocation(latitude: latitude, longitude: longitude, name: name, address: address, url: url)
    }
}

private struct LinkPreviewDTO: Codable, Sendable {
    var kind: String?
    var title: String?
    var subtitle: String?
    var amountLabel: String?
    var providerLabel: String?
    var url: String?

    init(_ preview: ChatLinkPreview) {
        kind = preview.kind
        title = preview.title
        subtitle = preview.subtitle
        amountLabel = preview.amountLabel
        providerLabel = preview.providerLabel
        url = preview.url
    }

    var linkPreview: ChatLinkPreview {
        ChatLinkPreview(
            kind: kind,
            title: title,
            subtitle: subtitle,
            amountLabel: amountLabel,
            providerLabel: providerLabel,
            url: url
        )
    }
}

private struct EmailDetailsDTO: Codable, Sendable {
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

    init(_ details: ChatEmailDetails) {
        subject = details.subject
        fromEmail = details.fromEmail
        toEmail = details.toEmail
        ccEmail = details.ccEmail
        bccEmail = details.bccEmail
        replyTo = details.replyTo
        status = details.status
        transport = details.transport
        body = details.body
        bodyHtml = details.bodyHtml
    }

    var details: ChatEmailDetails {
        ChatEmailDetails(
            subject: subject,
            fromEmail: fromEmail,
            toEmail: toEmail,
            ccEmail: ccEmail,
            bccEmail: bccEmail,
            replyTo: replyTo,
            status: status,
            transport: transport,
            body: body,
            bodyHtml: bodyHtml
        )
    }
}
