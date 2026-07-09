import Foundation

/// Caché instantánea (SWR, Round 6 #4) del módulo Ajustes.
///
/// Cada subpanel de Ajustes abre AL INSTANTE con lo último que el usuario vio y
/// luego revalida contra la red. Como los modelos de Core (`WhatsAppAPIStatus`,
/// `WhatsAppTemplatesSummary`, `AIAgentConfigStatus`, `RistakCalendar`,
/// `ContactCustomFieldDefinition`) son `Decodable` con `init(from:)` TOLERANTE
/// pero NO `Encodable` (y no debemos tocar Core), guardamos un DTO local
/// `Encodable` cuyo JSON de salida reproduce EXACTAMENTE el contrato del backend
/// (mismos `CodingKeys`, snake_case donde toca). Así:
///
/// - `store(SettingsWhatsAppStatusSnapshot(status), for:)` escribe el JSON.
/// - `value(WhatsAppAPIStatus.self, for:)` lo re-decodifica con el MISMO decoder
///   tolerante que usa el fetch en vivo → el render cacheado es indistinguible
///   del fresco.
///
/// El DTO solo se CODIFICA (nunca se decodifica de vuelta), así que no necesita
/// simetría: basta con que sus claves coincidan con las que lee Core. Los campos
/// que la UI de Ajustes no pinta se omiten (Core los tolera como `nil`/default),
/// manteniendo el snapshot pequeño.
enum SettingsCacheKey {
    static let whatsappStatus = "settings:whatsapp:status"
    static let templates = "settings:whatsapp:templates"
    static let aiAgent = "settings:ai-agent:config"
    static let customFields = "settings:contacts:custom-fields"
    static let calendars = "settings:calendars:active"

    /// Topes de tamaño antes de escribir (la caché no capa por sí sola).
    static let maxPhoneNumbers = 50
    static let maxTemplates = 200
    static let maxCustomFields = 300
    static let maxCalendars = 100
}

// MARK: - WhatsApp: status completo

/// Snapshot del status de WhatsApp (números, remitente, saldo). Reproduce el
/// contrato de `GET /whatsapp-api/status` que lee `WhatsAppAPIStatus.init(from:)`.
/// Omite `templates` a propósito: en Ajustes las plantillas se cargan aparte.
struct SettingsWhatsAppStatusSnapshot: Encodable {
    let provider: String?
    let activeProvider: String?
    let source: String?
    let connected: Bool
    let configured: Bool
    let status: String?
    let credentials: Credentials?
    let sender: Sender?
    let phoneNumbers: [PhoneNumber]
    let selectedPhone: PhoneNumber?
    let needsDefaultSelection: Bool
    let balance: Balance?

    enum CodingKeys: String, CodingKey {
        case provider, activeProvider, source, connected, configured, status
        case credentials, sender, phoneNumbers, selectedPhone
        case needsDefaultSelection, balance
    }

    struct Credentials: Encodable {
        let apiKeyMasked: String?
        let hasApiKey: Bool
    }

    struct Sender: Encodable {
        let phone: String?
        let phoneNumberId: String?
        let wabaId: String?
    }

    struct Balance: Encodable {
        let amount: Double
        let currency: String?
        let updatedAt: String?

        enum CodingKeys: String, CodingKey {
            case amount, currency
            case updatedAt = "updated_at"
        }
    }

    struct Availability: Encodable {
        let apiAvailable: Bool
        let apiReason: String?
        let qrReady: Bool
        let available: Bool

        init(_ availability: WhatsAppPhoneAvailability) {
            apiAvailable = availability.apiAvailable
            apiReason = availability.apiReason
            qrReady = availability.qrReady
            available = availability.available
        }
    }

    struct PhoneNumber: Encodable {
        let id: String
        let wabaId: String?
        let phoneNumber: String?
        let displayPhoneNumber: String?
        let verifiedName: String?
        let provider: String?
        let profilePictureUrl: String?
        let qualityRating: String?
        let messagingLimit: String?
        let status: String?
        let label: String?
        let isDefaultSender: Bool
        let apiSendEnabled: Bool
        let qrSendEnabled: Bool
        let qrStatus: String?
        let qrConnectedPhone: String?
        let updatedAt: String?
        let availability: Availability?

        enum CodingKeys: String, CodingKey {
            case id
            case wabaId = "waba_id"
            case phoneNumber = "phone_number"
            case displayPhoneNumber = "display_phone_number"
            case verifiedName = "verified_name"
            case provider
            case profilePictureUrl = "profile_picture_url"
            case qualityRating = "quality_rating"
            case messagingLimit = "messaging_limit"
            case status, label
            case isDefaultSender = "is_default_sender"
            case apiSendEnabled = "api_send_enabled"
            case qrSendEnabled = "qr_send_enabled"
            case qrStatus = "qr_status"
            case qrConnectedPhone = "qr_connected_phone"
            case updatedAt = "updated_at"
            case availability
        }

        init(_ number: WhatsAppPhoneNumber) {
            id = number.id
            wabaId = number.wabaId
            phoneNumber = number.phoneNumber
            displayPhoneNumber = number.displayPhoneNumber
            verifiedName = number.verifiedName
            provider = number.provider
            profilePictureUrl = number.profilePictureUrl
            qualityRating = number.qualityRating
            messagingLimit = number.messagingLimit
            status = number.status
            label = number.label
            isDefaultSender = number.isDefaultSender
            apiSendEnabled = number.apiSendEnabled
            qrSendEnabled = number.qrSendEnabled
            qrStatus = number.qrStatus
            qrConnectedPhone = number.qrConnectedPhone
            updatedAt = number.updatedAt
            availability = number.availability.map(Availability.init)
        }
    }

    init(_ status: WhatsAppAPIStatus) {
        provider = status.provider
        activeProvider = status.activeProvider
        source = status.source
        connected = status.connected
        configured = status.configured
        self.status = status.status
        credentials = status.credentials.map {
            Credentials(apiKeyMasked: $0.apiKeyMasked, hasApiKey: $0.hasApiKey)
        }
        sender = status.sender.map {
            Sender(phone: $0.phone, phoneNumberId: $0.phoneNumberId, wabaId: $0.wabaId)
        }
        phoneNumbers = status.phoneNumbers
            .prefix(SettingsCacheKey.maxPhoneNumbers)
            .map(PhoneNumber.init)
        selectedPhone = status.selectedPhone.map(PhoneNumber.init)
        needsDefaultSelection = status.needsDefaultSelection
        balance = status.balance.map {
            Balance(amount: $0.amount, currency: $0.currency, updatedAt: $0.updatedAt)
        }
    }
}

// MARK: - WhatsApp: plantillas

/// Snapshot del resumen de plantillas. Reproduce `{ total, approved, blocked,
/// items }` que lee `WhatsAppTemplatesSummary.init(from:)`.
struct SettingsTemplatesSnapshot: Encodable {
    let total: Int
    let approved: Int
    let blocked: Int
    let items: [Template]

    struct Component: Encodable {
        let type: String?
        let text: String?
    }

    struct Template: Encodable {
        let id: String
        let officialTemplateId: String?
        let wabaId: String?
        let name: String
        let officialName: String?
        let localTemplateId: String?
        let language: String?
        let category: String?
        let status: String?
        let qualityRating: String?
        let reason: String?
        let statusUpdateEvent: String?
        let disableDate: String?
        let components: [Component]
        let createdAt: String?
        let updatedAt: String?

        enum CodingKeys: String, CodingKey {
            case id
            case officialTemplateId = "official_template_id"
            case wabaId = "waba_id"
            case name
            case officialName = "official_name"
            case localTemplateId = "local_template_id"
            case language, category, status
            case qualityRating = "quality_rating"
            case reason
            case statusUpdateEvent = "status_update_event"
            case disableDate = "disable_date"
            case components
            case createdAt = "created_at"
            case updatedAt = "updated_at"
        }

        init(_ template: WhatsAppTemplate) {
            id = template.id
            officialTemplateId = template.officialTemplateId
            wabaId = template.wabaId
            name = template.name
            officialName = template.officialName
            localTemplateId = template.localTemplateId
            language = template.language
            category = template.category
            status = template.status
            qualityRating = template.qualityRating
            reason = template.reason
            statusUpdateEvent = template.statusUpdateEvent
            disableDate = template.disableDate
            components = template.components.map { Component(type: $0.type, text: $0.text) }
            createdAt = template.createdAt
            updatedAt = template.updatedAt
        }
    }

    init(_ summary: WhatsAppTemplatesSummary) {
        total = summary.total
        approved = summary.approved
        blocked = summary.blocked
        items = summary.items
            .prefix(SettingsCacheKey.maxTemplates)
            .map(Template.init)
    }
}

// MARK: - Agente AI

/// Snapshot de la config del agente. Reproduce el contrato de
/// `GET /ai-agent/config` que lee `AIAgentConfigStatus.init(from:)`
/// (todas las claves camelCase). Omite `businessProfile`: la UI no lo pinta.
struct SettingsAgentSnapshot: Encodable {
    let configured: Bool
    let credentialStatus: String?
    let needsReconnect: Bool
    let connectionIssue: String?
    let connectionIssueCode: String?
    let model: String?
    let tokenPreview: String?
    let businessContext: String
    let responseStyle: String?
    let recommendationMode: String?
    let webSearchEnabled: Bool
    let updatedAt: String?

    init(_ status: AIAgentConfigStatus) {
        configured = status.configured
        credentialStatus = status.credentialStatus
        needsReconnect = status.needsReconnect
        connectionIssue = status.connectionIssue
        connectionIssueCode = status.connectionIssueCode
        model = status.model
        tokenPreview = status.tokenPreview
        businessContext = status.businessContext
        responseStyle = status.responseStyle
        recommendationMode = status.recommendationMode
        webSearchEnabled = status.webSearchEnabled
        updatedAt = status.updatedAt
    }
}

// MARK: - Campos personalizados

/// Snapshot de un campo personalizado (subset que pinta el catálogo de Ajustes:
/// etiqueta, tipo, llave y carpeta). Claves camelCase = `CodingKeys` de Core.
struct SettingsCustomFieldSnapshot: Encodable {
    let definitionId: String
    let key: String
    let fieldKey: String
    let label: String
    let name: String
    let description: String
    let dataType: String
    let folderId: String
    let folderName: String
    let archived: Bool

    init(_ field: ContactCustomFieldDefinition) {
        definitionId = field.definitionId
        key = field.key
        fieldKey = field.fieldKey
        label = field.label
        name = field.name
        description = field.description
        dataType = field.dataType
        folderId = field.folderId
        folderName = field.folderName
        archived = field.archived
    }
}

// MARK: - Calendarios (para el selector de notificaciones)

/// Snapshot mínimo de un calendario activo (id, nombre, color). Claves camelCase
/// = `CodingKeys` de `RistakCalendar`.
struct SettingsCalendarSnapshot: Encodable {
    let id: String
    let name: String
    let eventColor: String
    let isActive: Bool

    init(_ calendar: RistakCalendar) {
        id = calendar.id
        name = calendar.name
        eventColor = calendar.eventColor
        isActive = calendar.isActive
    }
}
