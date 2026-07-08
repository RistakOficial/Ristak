import Foundation

// Contrato exacto: docs/research/06-contact-info.md.

/// Teléfono de un contacto (`buildContactPhonesForResponse`).
struct ContactPhoneNumber: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let phone: String
    let label: String
    let isPrimary: Bool
    let source: String
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, phone, label
        case isPrimary
        case isPrimarySnake = "is_primary"
        case source, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        phone = container.flexibleString(forKey: .phone) ?? ""
        id = container.flexibleString(forKey: .id) ?? phone
        label = container.flexibleString(forKey: .label) ?? ""
        isPrimary = container.flexibleBool(forKey: .isPrimary)
            ?? container.flexibleBool(forKey: .isPrimarySnake)
            ?? false
        source = container.flexibleString(forKey: .source) ?? ""
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
    }
}

/// Opción de un campo personalizado de tipo selección.
struct ContactFieldOption: Decodable, Sendable, Equatable {
    let label: String
    let value: String

    enum CodingKeys: String, CodingKey {
        case label, value
    }

    init(from decoder: Decoder) throws {
        // Puede llegar como objeto `{label, value}` o como string suelto.
        if let container = try? decoder.container(keyedBy: CodingKeys.self) {
            let labelValue = container.flexibleString(forKey: .label)
            let rawValue = container.flexibleString(forKey: .value)
            if labelValue != nil || rawValue != nil {
                label = labelValue ?? rawValue ?? ""
                value = rawValue ?? labelValue ?? ""
                return
            }
        }
        let single = try? decoder.singleValueContainer().decode(String.self)
        label = single ?? ""
        value = single ?? ""
    }
}

/// Valor de un campo personalizado EN un contacto (doc 06 §1.3, forma normalizada).
struct ContactCustomFieldValue: Decodable, Sendable, Equatable {
    let id: String
    let definitionId: String
    let key: String
    let fieldKey: String
    let label: String
    let name: String
    let dataType: String?
    let value: RistakJSONValue?
    let options: [ContactFieldOption]
    let model: String?
    let syncTarget: String?
    let sourceType: String?

    enum CodingKeys: String, CodingKey {
        case id, definitionId, key, fieldKey, label, name, dataType
        case value, options, model, syncTarget, sourceType
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        definitionId = container.flexibleString(forKey: .definitionId) ?? ""
        key = container.flexibleString(forKey: .key) ?? ""
        fieldKey = container.flexibleString(forKey: .fieldKey) ?? key
        label = container.flexibleString(forKey: .label) ?? ""
        name = container.flexibleString(forKey: .name) ?? label
        dataType = container.flexibleString(forKey: .dataType)
        value = try? container.decodeIfPresent(RistakJSONValue.self, forKey: .value)
        options = (try? container.decodeIfPresent([ContactFieldOption].self, forKey: .options)) ?? []
        model = container.flexibleString(forKey: .model)
        syncTarget = container.flexibleString(forKey: .syncTarget)
        sourceType = container.flexibleString(forKey: .sourceType)
    }
}

/// Forma canónica para ESCRIBIR un valor de campo personalizado
/// (`PUT /contacts/:id { customFields: [...] }`, doc 06 §1.3).
struct ContactCustomFieldWrite: Encodable, Sendable {
    var definitionId: String?
    var key: String
    var fieldKey: String
    var label: String
    var dataType: String?
    var value: RistakJSONValue

    init(definitionId: String? = nil, key: String, fieldKey: String? = nil, label: String, dataType: String? = nil, value: RistakJSONValue) {
        self.definitionId = definitionId
        self.key = key
        self.fieldKey = fieldKey ?? key
        self.label = label
        self.dataType = dataType
        self.value = value
    }
}

/// Definición de campo personalizado (doc 06 §1.4).
struct ContactCustomFieldDefinition: Decodable, Identifiable, Sendable, Equatable {
    let definitionId: String
    let key: String
    let fieldKey: String
    let label: String
    let name: String
    let description: String
    let dataType: String
    let options: [ContactFieldOption]
    let folderId: String
    let folderName: String
    let fieldGroup: String
    let syncTarget: String
    let sourceType: String
    let archived: Bool
    let system: Bool
    let systemManaged: Bool
    let locked: Bool
    let editable: Bool
    let deletable: Bool
    let createdAt: String?
    let updatedAt: String?

    var id: String { definitionId.isEmpty ? key : definitionId }

    enum CodingKeys: String, CodingKey {
        case definitionId, key, fieldKey, label, name, description, dataType
        case options, folderId, folderName, fieldGroup, syncTarget, sourceType
        case archived, system, systemManaged, locked, editable, deletable
        case createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        definitionId = container.flexibleString(forKey: .definitionId) ?? ""
        key = container.flexibleString(forKey: .key) ?? ""
        fieldKey = container.flexibleString(forKey: .fieldKey) ?? key
        label = container.flexibleString(forKey: .label) ?? ""
        name = container.flexibleString(forKey: .name) ?? label
        description = container.flexibleString(forKey: .description) ?? ""
        dataType = Self.normalizeDataType(container.flexibleString(forKey: .dataType))
        options = (try? container.decodeIfPresent([ContactFieldOption].self, forKey: .options)) ?? []
        folderId = container.flexibleString(forKey: .folderId) ?? ""
        folderName = container.flexibleString(forKey: .folderName) ?? ""
        fieldGroup = container.flexibleString(forKey: .fieldGroup) ?? "general"
        syncTarget = container.flexibleString(forKey: .syncTarget) ?? "local"
        sourceType = container.flexibleString(forKey: .sourceType) ?? ""
        archived = container.flexibleBool(forKey: .archived) ?? false
        system = container.flexibleBool(forKey: .system) ?? false
        systemManaged = container.flexibleBool(forKey: .systemManaged) ?? system
        locked = container.flexibleBool(forKey: .locked) ?? false
        editable = container.flexibleBool(forKey: .editable) ?? true
        deletable = container.flexibleBool(forKey: .deletable) ?? true
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
    }

    /// Alias legacy → tipo canónico (doc 06 §1.4 y §6.14).
    static func normalizeDataType(_ raw: String?) -> String {
        let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "", "string", "short_text", "plain_text": return "text"
        case "long_text", "paragraph": return "textarea"
        case "select": return "dropdown"
        case "multiselect": return "checkboxes"
        default: return value
        }
    }
}

/// Pago embebido en `GET /contacts/:id` (fila cruda snake_case de `payments`).
struct ContactEmbeddedPayment: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let amount: Double
    let currency: String?
    let status: String
    let paymentDate: String?
    let createdAt: String?
    let title: String?
    let description: String?
    let concept: String?
    let type: String?
    let paymentProvider: String?
    let paymentMethod: String?

    enum CodingKeys: String, CodingKey {
        case id, amount, currency, status
        case paymentDate = "payment_date"
        case date
        case createdAt = "created_at"
        case title, description, concept, type
        case paymentProvider = "payment_provider"
        case paymentMethod = "payment_method"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? UUID().uuidString
        amount = container.flexibleDouble(forKey: .amount) ?? 0
        currency = container.flexibleString(forKey: .currency)
        status = container.flexibleString(forKey: .status) ?? ""
        paymentDate = container.flexibleString(forKey: .paymentDate)
            ?? container.flexibleString(forKey: .date)
        createdAt = container.flexibleString(forKey: .createdAt)
        title = container.flexibleString(forKey: .title)
        description = container.flexibleString(forKey: .description)
        concept = container.flexibleString(forKey: .concept)
        type = container.flexibleString(forKey: .type)
        paymentProvider = container.flexibleString(forKey: .paymentProvider)
        paymentMethod = container.flexibleString(forKey: .paymentMethod)
    }
}

/// Cita embebida en `GET /contacts/:id` (fila cruda snake_case).
struct ContactEmbeddedAppointment: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let title: String?
    let status: String
    let startTime: String?
    let endTime: String?
    let address: String?
    let notes: String?
    let calendarId: String?

    enum CodingKeys: String, CodingKey {
        case id, title, status, address, notes
        case startTime = "start_time"
        case endTime = "end_time"
        case calendarId = "calendar_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? UUID().uuidString
        title = container.flexibleString(forKey: .title)
        status = container.flexibleString(forKey: .status) ?? ""
        startTime = container.flexibleString(forKey: .startTime)
        endTime = container.flexibleString(forKey: .endTime)
        address = container.flexibleString(forKey: .address)
        notes = container.flexibleString(forKey: .notes)
        calendarId = container.flexibleString(forKey: .calendarId)
    }
}

/// Atribución Meta resuelta (doc 06 §1.1 `metaAttribution`).
struct ContactMetaAttribution: Decodable, Sendable, Equatable {
    let source: String?
    let matchType: String?
    let campaignId: String?
    let campaignName: String?
    let adsetId: String?
    let adsetName: String?
    let adId: String?
    let adName: String?
    let creativeThumbnailUrl: String?
    let creativeImageUrl: String?
    let creativeVideoUrl: String?
    let creativePreviewUrl: String?
    let date: String?

    enum CodingKeys: String, CodingKey {
        case source, matchType, campaignId, campaignName, adsetId, adsetName
        case adId, adName, creativeThumbnailUrl, creativeImageUrl
        case creativeVideoUrl, creativePreviewUrl, date
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = container.flexibleString(forKey: .source)
        matchType = container.flexibleString(forKey: .matchType)
        campaignId = container.flexibleString(forKey: .campaignId)
        campaignName = container.flexibleString(forKey: .campaignName)
        adsetId = container.flexibleString(forKey: .adsetId)
        adsetName = container.flexibleString(forKey: .adsetName)
        adId = container.flexibleString(forKey: .adId)
        adName = container.flexibleString(forKey: .adName)
        creativeThumbnailUrl = container.flexibleString(forKey: .creativeThumbnailUrl)
        creativeImageUrl = container.flexibleString(forKey: .creativeImageUrl)
        creativeVideoUrl = container.flexibleString(forKey: .creativeVideoUrl)
        creativePreviewUrl = container.flexibleString(forKey: .creativePreviewUrl)
        date = container.flexibleString(forKey: .date)
    }
}

/// Primera sesión de tracking (doc 06 §1.1 `firstSession`, snake_case).
struct ContactFirstSession: Decodable, Sendable, Equatable {
    let startedAt: String?
    let pageUrl: String?
    let landingPage: String?
    let referrerUrl: String?
    let utmSource: String?
    let utmMedium: String?
    let utmCampaign: String?
    let utmContent: String?
    let utmTerm: String?
    let sourcePlatform: String?
    let siteSourceName: String?
    let campaignName: String?
    let adsetName: String?
    let adName: String?
    let adId: String?
    let deviceType: String?
    let browser: String?
    let os: String?
    let placement: String?
    let geoCity: String?
    let geoRegion: String?
    let geoCountry: String?

    enum CodingKeys: String, CodingKey {
        case startedAt = "started_at"
        case pageUrl = "page_url"
        case landingPage = "landing_page"
        case referrerUrl = "referrer_url"
        case utmSource = "utm_source"
        case utmMedium = "utm_medium"
        case utmCampaign = "utm_campaign"
        case utmContent = "utm_content"
        case utmTerm = "utm_term"
        case sourcePlatform = "source_platform"
        case siteSourceName = "site_source_name"
        case campaignName = "campaign_name"
        case adsetName = "adset_name"
        case adName = "ad_name"
        case adId = "ad_id"
        case deviceType = "device_type"
        case browser, os, placement
        case geoCity = "geo_city"
        case geoRegion = "geo_region"
        case geoCountry = "geo_country"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        startedAt = container.flexibleString(forKey: .startedAt)
        pageUrl = container.flexibleString(forKey: .pageUrl)
        landingPage = container.flexibleString(forKey: .landingPage)
        referrerUrl = container.flexibleString(forKey: .referrerUrl)
        utmSource = container.flexibleString(forKey: .utmSource)
        utmMedium = container.flexibleString(forKey: .utmMedium)
        utmCampaign = container.flexibleString(forKey: .utmCampaign)
        utmContent = container.flexibleString(forKey: .utmContent)
        utmTerm = container.flexibleString(forKey: .utmTerm)
        sourcePlatform = container.flexibleString(forKey: .sourcePlatform)
        siteSourceName = container.flexibleString(forKey: .siteSourceName)
        campaignName = container.flexibleString(forKey: .campaignName)
        adsetName = container.flexibleString(forKey: .adsetName)
        adName = container.flexibleString(forKey: .adName)
        adId = container.flexibleString(forKey: .adId)
        deviceType = container.flexibleString(forKey: .deviceType)
        browser = container.flexibleString(forKey: .browser)
        os = container.flexibleString(forKey: .os)
        placement = container.flexibleString(forKey: .placement)
        geoCity = container.flexibleString(forKey: .geoCity)
        geoRegion = container.flexibleString(forKey: .geoRegion)
        geoCountry = container.flexibleString(forKey: .geoCountry)
    }
}

/// Ficha completa del contacto — `GET /api/contacts/:id` (forma "mapeada",
/// doc 06 §1.1). ⚠️ El PUT devuelve otra forma (fila cruda snake_case);
/// tras actualizar hay que re-fetch (patrón implementado en `ContactsService`).
struct ContactDetail: Decodable, Identifiable, Sendable {
    let id: String
    let createdAt: String?
    let name: String
    let email: String
    let phone: String
    let ltv: Double
    let status: String
    let lastPurchase: String?
    let purchases: Int
    let successfulPaymentsCount: Int
    let source: String?
    let adName: String?
    let adId: String?
    let campaignId: String?
    let campaignName: String?
    let adsetId: String?
    let adsetName: String?
    let preferredWhatsAppPhoneNumberId: String
    let profilePhotoUrl: String?
    let phones: [ContactPhoneNumber]
    let customFields: [ContactCustomFieldValue]
    let tags: [String]
    let notes: String
    let payments: [ContactEmbeddedPayment]
    let appointments: [ContactEmbeddedAppointment]
    let firstAppointmentDate: String?
    let nextAppointmentDate: String?
    let hasAppointments: Bool
    let hasShowedAppointment: Bool
    let hasAttendedAppointment: Bool
    let hasUpcomingConfirmedAppointmentBadge: Bool
    let attributionUrl: String?
    let attributionSessionSource: String?
    let attributionMedium: String?
    let attributionCtwaClid: String?
    let whatsappAttributionPlatform: String?
    let metaAttribution: ContactMetaAttribution?
    let firstSession: ContactFirstSession?

    enum CodingKeys: String, CodingKey {
        case id, createdAt, name, email, phone, ltv, status, lastPurchase
        case purchases, successfulPaymentsCount, source
        case adName = "ad_name"
        case adId = "ad_id"
        case campaignId = "campaign_id"
        case campaignName = "campaign_name"
        case adsetId = "adset_id"
        case adsetName = "adset_name"
        case preferredWhatsAppPhoneNumberId
        case profilePhotoUrl, phones, phoneNumbers, customFields, tags, notes
        case payments, appointments
        case firstAppointmentDate, nextAppointmentDate
        case hasAppointments, hasShowedAppointment, hasAttendedAppointment
        case hasUpcomingConfirmedAppointmentBadge
        case attributionUrl = "attribution_url"
        case attributionSessionSource = "attribution_session_source"
        case attributionMedium = "attribution_medium"
        case attributionCtwaClid = "attribution_ctwa_clid"
        case whatsappAttributionPlatform
        case metaAttribution, firstSession
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        createdAt = container.flexibleString(forKey: .createdAt)
        name = container.flexibleString(forKey: .name) ?? ""
        email = container.flexibleString(forKey: .email) ?? ""
        phone = container.flexibleString(forKey: .phone) ?? ""
        ltv = container.flexibleDouble(forKey: .ltv) ?? 0
        status = container.flexibleString(forKey: .status) ?? "lead"
        lastPurchase = container.flexibleString(forKey: .lastPurchase)
        purchases = container.flexibleInt(forKey: .purchases) ?? 0
        successfulPaymentsCount = container.flexibleInt(forKey: .successfulPaymentsCount) ?? purchases
        source = container.flexibleString(forKey: .source)
        adName = container.flexibleString(forKey: .adName)
        adId = container.flexibleString(forKey: .adId)
        campaignId = container.flexibleString(forKey: .campaignId)
        campaignName = container.flexibleString(forKey: .campaignName)
        adsetId = container.flexibleString(forKey: .adsetId)
        adsetName = container.flexibleString(forKey: .adsetName)
        preferredWhatsAppPhoneNumberId = container.flexibleString(forKey: .preferredWhatsAppPhoneNumberId) ?? ""
        profilePhotoUrl = container.flexibleString(forKey: .profilePhotoUrl)
        let phonesValue = (try? container.decodeIfPresent([ContactPhoneNumber].self, forKey: .phones))
            ?? (try? container.decodeIfPresent([ContactPhoneNumber].self, forKey: .phoneNumbers))
        phones = phonesValue ?? []
        customFields = (try? container.decodeIfPresent([ContactCustomFieldValue].self, forKey: .customFields)) ?? []
        tags = (try? container.decodeIfPresent([String].self, forKey: .tags)) ?? []
        notes = container.flexibleString(forKey: .notes) ?? ""
        payments = (try? container.decodeIfPresent([ContactEmbeddedPayment].self, forKey: .payments)) ?? []
        appointments = (try? container.decodeIfPresent([ContactEmbeddedAppointment].self, forKey: .appointments)) ?? []
        firstAppointmentDate = container.flexibleString(forKey: .firstAppointmentDate)
        nextAppointmentDate = container.flexibleString(forKey: .nextAppointmentDate)
        hasAppointments = container.flexibleBool(forKey: .hasAppointments) ?? false
        hasShowedAppointment = container.flexibleBool(forKey: .hasShowedAppointment) ?? false
        hasAttendedAppointment = container.flexibleBool(forKey: .hasAttendedAppointment) ?? hasShowedAppointment
        hasUpcomingConfirmedAppointmentBadge = container.flexibleBool(forKey: .hasUpcomingConfirmedAppointmentBadge) ?? false
        attributionUrl = container.flexibleString(forKey: .attributionUrl)
        attributionSessionSource = container.flexibleString(forKey: .attributionSessionSource)
        attributionMedium = container.flexibleString(forKey: .attributionMedium)
        attributionCtwaClid = container.flexibleString(forKey: .attributionCtwaClid)
        whatsappAttributionPlatform = container.flexibleString(forKey: .whatsappAttributionPlatform)
        metaAttribution = try? container.decodeIfPresent(ContactMetaAttribution.self, forKey: .metaAttribution)
        firstSession = try? container.decodeIfPresent(ContactFirstSession.self, forKey: .firstSession)
    }
}

/// Body de `PUT /api/contacts/:id` (doc 06 §2.1). Solo se serializan los
/// campos presentes (nil = no tocar).
struct ContactUpdateRequest: Encodable, Sendable {
    var fullName: String?
    var email: String?
    var phone: String?
    var source: String?
    var attributionAdName: String?
    var attributionAdId: String?
    /// REEMPLAZA el set completo de etiquetas (IDs o nombres).
    var tags: [String]?
    var customFields: [ContactCustomFieldWrite]?
    var preferredWhatsAppPhoneNumberId: String?
    /// `'manual' | 'contingency'`.
    var routingSource: String?
    var routingReason: String?
    /// Autoriza la fusión al chocar teléfono (CNT-001). Solo teléfono fusiona
    /// de verdad; email NO (audit doc 06).
    var confirmMerge: Bool?

    enum CodingKeys: String, CodingKey {
        case fullName = "full_name"
        case email, phone, source
        case attributionAdName = "attribution_ad_name"
        case attributionAdId = "attribution_ad_id"
        case tags, customFields
        case preferredWhatsAppPhoneNumberId
        case routingSource, routingReason, confirmMerge
    }

    init(
        fullName: String? = nil,
        email: String? = nil,
        phone: String? = nil,
        source: String? = nil,
        attributionAdName: String? = nil,
        attributionAdId: String? = nil,
        tags: [String]? = nil,
        customFields: [ContactCustomFieldWrite]? = nil,
        preferredWhatsAppPhoneNumberId: String? = nil,
        routingSource: String? = nil,
        routingReason: String? = nil,
        confirmMerge: Bool? = nil
    ) {
        self.fullName = fullName
        self.email = email
        self.phone = phone
        self.source = source
        self.attributionAdName = attributionAdName
        self.attributionAdId = attributionAdId
        self.tags = tags
        self.customFields = customFields
        self.preferredWhatsAppPhoneNumberId = preferredWhatsAppPhoneNumberId
        self.routingSource = routingSource
        self.routingReason = routingReason
        self.confirmMerge = confirmMerge
    }
}

/// Body de `POST /api/contacts` (doc 06 §2.1).
struct ContactCreateRequest: Encodable, Sendable {
    var name: String?
    var firstName: String?
    var lastName: String?
    var email: String?
    var phone: String?
    var source: String?

    enum CodingKeys: String, CodingKey {
        case name
        case firstName = "first_name"
        case lastName = "last_name"
        case email, phone, source
    }

    init(name: String? = nil, firstName: String? = nil, lastName: String? = nil, email: String? = nil, phone: String? = nil, source: String? = nil) {
        self.name = name
        self.firstName = firstName
        self.lastName = lastName
        self.email = email
        self.phone = phone
        self.source = source
    }
}

/// Perfil social vinculado (`GET /contacts/:id/linked-social`, doc 06 §1.7).
/// ⚠️ Respuesta SIN clave `data`: `{ success, profiles, linked }`.
struct ContactLinkedSocialProfile: Decodable, Sendable, Equatable {
    let contactId: String?
    let platform: String
    let platformLabel: String
    /// `'dm' | 'comment'`.
    let kind: String
    let name: String?
    let username: String?
    let photo: String?
    let metaUserId: String?

    enum CodingKeys: String, CodingKey {
        case contactId, platform, platformLabel, kind, name, username, photo, metaUserId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contactId = container.flexibleString(forKey: .contactId)
        platform = container.flexibleString(forKey: .platform) ?? ""
        platformLabel = container.flexibleString(forKey: .platformLabel) ?? ""
        kind = container.flexibleString(forKey: .kind) ?? "dm"
        name = container.flexibleString(forKey: .name)
        username = container.flexibleString(forKey: .username)
        photo = container.flexibleString(forKey: .photo)
        metaUserId = container.flexibleString(forKey: .metaUserId)
    }
}

struct ContactLinkedSocialResult: Decodable, Sendable {
    let profiles: [ContactLinkedSocialProfile]
    /// Otros contactos de la misma persona no fusionados.
    let linked: [ContactLinkedSocialProfile]

    enum CodingKeys: String, CodingKey {
        case profiles, linked
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        profiles = (try? container.decodeIfPresent([ContactLinkedSocialProfile].self, forKey: .profiles)) ?? []
        linked = (try? container.decodeIfPresent([ContactLinkedSocialProfile].self, forKey: .linked)) ?? []
    }
}

/// Filtro de contactos ocultos (`GET /api/hidden-contacts`, doc 03 §1.6).
/// La bandeja NO los gestiona: el server ya excluye. POST/DELETE son admin-only.
/// Nota: un contacto oculto también responde 404 en `GET /contacts/:id` —
/// la navegación debe tolerar 404 de contactos en caché.
struct HiddenContactFilter: Decodable, Identifiable, Sendable {
    let id: String
    let filterText: String
    /// `'contains' | 'exact'`.
    let matchType: String
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, filterText, matchType, createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        filterText = container.flexibleString(forKey: .filterText) ?? ""
        matchType = container.flexibleString(forKey: .matchType) ?? "contains"
        createdAt = container.flexibleString(forKey: .createdAt)
    }
}
