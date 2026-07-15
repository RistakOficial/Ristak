import Foundation

/// Actividad minima compartida entre el hilo y la bandeja. Permite promover
/// una fila en el mismo frame del envio/evento SSE sin esperar a que termine
/// `GET /contacts/chats`; esa consulta queda como reconciliacion autoritativa.
struct ChatInboxActivity: Sendable, Equatable {
    let contactID: String
    let messageID: String
    let text: String?
    let messageType: String
    let channel: String
    let transport: String
    let direction: String
    let timestamp: String
    let businessPhone: String?
    let businessPhoneNumberID: String?
    let isNew: Bool
    /// El hilo de este contacto esta visible, asi que un mensaje entrante no
    /// debe encender un contador local de no leidos.
    let conversationIsVisible: Bool

    var deduplicationKey: String {
        if !messageID.isEmpty { return "message:\(messageID)" }
        return [contactID, direction, timestamp, messageType, transport]
            .joined(separator: "|")
    }

    init(message: ChatMessage, conversationIsVisible: Bool = true) {
        contactID = message.contactId
        messageID = message.id
        text = message.displayText
        messageType = message.messageType ?? (message.attachment?.type.rawValue ?? "text")
        channel = message.channel
        transport = message.transport ?? message.channel
        direction = message.direction == .outbound ? "outbound" : "inbound"
        timestamp = message.date
        businessPhone = message.businessPhone
        businessPhoneNumberID = message.businessPhoneNumberId
        isNew = true
        self.conversationIsVisible = conversationIsVisible
    }

    init(event: ChatMessageRealtimeEvent, conversationIsVisible: Bool = false) {
        contactID = event.contactId
        messageID = event.messageId
        // El evento deliberadamente no transporta el cuerpo. Para mensajes
        // nuevos se limpia el preview viejo y la fila muestra su label de tipo
        // (Mensaje de WhatsApp, Foto, Audio...) hasta la reconciliacion REST.
        text = event.isNew ? "" : nil
        messageType = event.messageType
        channel = event.channel
        transport = event.transport
        direction = event.direction
        timestamp = event.messageTimestamp.isEmpty ? event.receivedAt : event.messageTimestamp
        businessPhone = nil
        businessPhoneNumberID = nil
        isNew = event.isNew
        self.conversationIsVisible = conversationIsVisible
    }

    /// La bandeja y el hilo pueden observar el mismo mensaje. Si cualquiera lo
    /// vio con el hilo abierto, esa señal más fuerte debe ganar al coalescer el
    /// evento para no encender un no-leído falso.
    func withConversationVisible() -> ChatInboxActivity {
        guard !conversationIsVisible else { return self }
        return ChatInboxActivity(copying: self, conversationIsVisible: true)
    }

    private init(copying source: ChatInboxActivity, conversationIsVisible: Bool) {
        contactID = source.contactID
        messageID = source.messageID
        text = source.text
        messageType = source.messageType
        channel = source.channel
        transport = source.transport
        direction = source.direction
        timestamp = source.timestamp
        businessPhone = source.businessPhone
        businessPhoneNumberID = source.businessPhoneNumberID
        isNew = source.isNew
        self.conversationIsVisible = conversationIsVisible
    }
}
