import Foundation

// Contrato exacto: docs/research/04-conversation-thread.md §4 y
// docs/research/05-message-sending.md §2.10.

/// Mensaje programado (`scheduledChatMessagesService.js:112-140`, shape exacto).
struct ScheduledChatMessage: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let contactId: String
    /// `'whatsapp_api' | 'highlevel'`.
    let provider: String
    /// whatsapp: `'api'|'qr'`; highlevel: `'ghl_whatsapp'|'ghl_sms'|'ghl_messenger'|'ghl_instagram'`.
    let channel: String
    let transport: String
    /// `'text' | 'template'`.
    let messageType: String
    let text: String
    let templateId: String
    let templateName: String
    let templateLanguage: String
    let templateComponents: RistakJSONValue?
    let templateVariables: RistakJSONValue?
    let toPhone: String
    let fromPhone: String
    let businessPhoneNumberId: String
    /// UTC ISO.
    let scheduledAt: String
    /// `'scheduled'|'sending'|'sent'|'error'|'cancelled'`.
    let status: String
    let externalId: String
    let sentMessageId: String
    let attempts: Int
    let errorMessage: String
    let createdAt: String?
    let updatedAt: String?
    let sentAt: String?

    enum CodingKeys: String, CodingKey {
        case id, contactId, provider, channel, transport, messageType, text
        case templateId, templateName, templateLanguage
        case templateComponents, templateVariables
        case toPhone, fromPhone, businessPhoneNumberId
        case scheduledAt, status, externalId, sentMessageId
        case attempts, errorMessage, createdAt, updatedAt, sentAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        contactId = container.flexibleString(forKey: .contactId) ?? ""
        provider = container.flexibleString(forKey: .provider) ?? "whatsapp_api"
        channel = container.flexibleString(forKey: .channel) ?? ""
        transport = container.flexibleString(forKey: .transport) ?? ""
        messageType = container.flexibleString(forKey: .messageType) ?? "text"
        text = container.flexibleString(forKey: .text) ?? ""
        templateId = container.flexibleString(forKey: .templateId) ?? ""
        templateName = container.flexibleString(forKey: .templateName) ?? ""
        templateLanguage = container.flexibleString(forKey: .templateLanguage) ?? ""
        templateComponents = try? container.decodeIfPresent(RistakJSONValue.self, forKey: .templateComponents)
        templateVariables = try? container.decodeIfPresent(RistakJSONValue.self, forKey: .templateVariables)
        toPhone = container.flexibleString(forKey: .toPhone) ?? ""
        fromPhone = container.flexibleString(forKey: .fromPhone) ?? ""
        businessPhoneNumberId = container.flexibleString(forKey: .businessPhoneNumberId) ?? ""
        scheduledAt = container.flexibleString(forKey: .scheduledAt) ?? ""
        status = container.flexibleString(forKey: .status) ?? "scheduled"
        externalId = container.flexibleString(forKey: .externalId) ?? ""
        sentMessageId = container.flexibleString(forKey: .sentMessageId) ?? ""
        attempts = container.flexibleInt(forKey: .attempts) ?? 0
        errorMessage = container.flexibleString(forKey: .errorMessage) ?? ""
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        sentAt = container.flexibleString(forKey: .sentAt)
    }
}

/// Body de `POST /api/whatsapp-api/messages/scheduled` (upsert: mandar `id`
/// para EDITAR una programación existente; no hay PATCH).
struct ScheduledMessageUpsertRequest: Encodable, Sendable {
    /// Presente = editar; ausente = crear.
    var id: String?
    var contactId: String
    /// `'whatsapp_api' | 'highlevel'`.
    var provider: String
    /// Solo provider=highlevel: `'whatsapp_api'|'sms_qr'|'messenger'|'instagram'`.
    var channel: String?
    /// Solo provider=whatsapp_api: `'api' | 'qr'`.
    var transport: String?
    /// `'text' | 'template'`.
    var messageType: String
    var text: String
    var templateId: String?
    var templateName: String?
    var templateLanguage: String?
    var templateComponents: RistakJSONValue?
    var templateVariables: RistakJSONValue?
    var toPhone: String?
    /// Requerido si provider=whatsapp_api.
    var fromPhone: String?
    var businessPhoneNumberId: String?
    /// SIEMPRE UTC ISO (el backend valida futuro ≥ now+10 s en TZ del negocio).
    var scheduledAt: String
    var externalId: String?

    init(
        id: String? = nil,
        contactId: String,
        provider: String = "whatsapp_api",
        channel: String? = nil,
        transport: String? = nil,
        messageType: String = "text",
        text: String,
        templateId: String? = nil,
        templateName: String? = nil,
        templateLanguage: String? = nil,
        templateComponents: RistakJSONValue? = nil,
        templateVariables: RistakJSONValue? = nil,
        toPhone: String? = nil,
        fromPhone: String? = nil,
        businessPhoneNumberId: String? = nil,
        scheduledAt: String,
        externalId: String? = nil
    ) {
        self.id = id
        self.contactId = contactId
        self.provider = provider
        self.channel = channel
        self.transport = transport
        self.messageType = messageType
        self.text = text
        self.templateId = templateId
        self.templateName = templateName
        self.templateLanguage = templateLanguage
        self.templateComponents = templateComponents
        self.templateVariables = templateVariables
        self.toPhone = toPhone
        self.fromPhone = fromPhone
        self.businessPhoneNumberId = businessPhoneNumberId
        self.scheduledAt = scheduledAt
        self.externalId = externalId
    }
}
