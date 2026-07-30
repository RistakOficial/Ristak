import Foundation

// MARK: - WhatsApp API: números (doc 10 §2.6)

/// Disponibilidad calculada por request de un número de WhatsApp.
struct WhatsAppPhoneAvailability: Decodable, Sendable, Equatable {
    let apiAvailable: Bool
    let apiReason: String?
    let qrReady: Bool
    let available: Bool

    enum CodingKeys: String, CodingKey {
        case apiAvailable, apiReason, qrReady, available
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        apiAvailable = container.flexibleBool(forKey: .apiAvailable) ?? false
        apiReason = container.flexibleString(forKey: .apiReason)
        qrReady = container.flexibleBool(forKey: .qrReady) ?? false
        available = container.flexibleBool(forKey: .available) ?? false
    }
}

/// `WhatsAppApiPhoneNumber` — fila DB en snake_case (doc 10 §2.6).
struct WhatsAppPhoneNumber: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let wabaId: String?
    let phoneNumber: String?
    let displayPhoneNumber: String?
    let verifiedName: String?
    /// `'ycloud' | 'meta_direct' | 'qr'`.
    let provider: String?
    let profilePictureUrl: String?
    let qualityRating: String?
    let messagingLimit: String?
    /// Ej. `CONNECTED`, `QR_ONLY`.
    let status: String?
    /// Alias editable.
    let label: String?
    let isDefaultSender: Bool
    let apiSendEnabled: Bool
    let qrSendEnabled: Bool
    /// `connected`, `disconnected`, …
    let qrStatus: String?
    let qrConnectedPhone: String?
    let updatedAt: String?
    let availability: WhatsAppPhoneAvailability?

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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        wabaId = container.flexibleString(forKey: .wabaId)
        phoneNumber = container.flexibleString(forKey: .phoneNumber)
        displayPhoneNumber = container.flexibleString(forKey: .displayPhoneNumber)
        verifiedName = container.flexibleString(forKey: .verifiedName)
        provider = container.flexibleString(forKey: .provider)
        profilePictureUrl = container.flexibleString(forKey: .profilePictureUrl)
        qualityRating = container.flexibleString(forKey: .qualityRating)
        messagingLimit = container.flexibleString(forKey: .messagingLimit)
        status = container.flexibleString(forKey: .status)
        label = container.flexibleString(forKey: .label)
        // 0/1 numérico en DB → Bool.
        isDefaultSender = container.flexibleBool(forKey: .isDefaultSender) ?? false
        apiSendEnabled = container.flexibleBool(forKey: .apiSendEnabled) ?? false
        qrSendEnabled = container.flexibleBool(forKey: .qrSendEnabled) ?? false
        qrStatus = container.flexibleString(forKey: .qrStatus)
        qrConnectedPhone = container.flexibleString(forKey: .qrConnectedPhone)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        availability = try? container.decodeIfPresent(WhatsAppPhoneAvailability.self, forKey: .availability)
    }

    /// Título de la fila: `label || verified_name || número || 'WhatsApp'`.
    var displayTitle: String {
        for candidate in [label, verifiedName, displayPhoneNumber, phoneNumber] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return "WhatsApp"
    }

    var isQRConnected: Bool { qrStatus == "connected" }
}

/// Credenciales enmascaradas del status.
struct WhatsAppAPICredentials: Decodable, Sendable, Equatable {
    let apiKeyMasked: String?
    let hasApiKey: Bool

    enum CodingKeys: String, CodingKey {
        case apiKeyMasked, hasApiKey
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        apiKeyMasked = container.flexibleString(forKey: .apiKeyMasked)
        hasApiKey = container.flexibleBool(forKey: .hasApiKey) ?? false
    }
}

/// Remitente default del status.
struct WhatsAppAPISender: Decodable, Sendable, Equatable {
    let phone: String?
    let phoneNumberId: String?
    let wabaId: String?

    enum CodingKeys: String, CodingKey {
        case phone, phoneNumberId, wabaId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        phone = container.flexibleString(forKey: .phone)
        phoneNumberId = container.flexibleString(forKey: .phoneNumberId)
        wabaId = container.flexibleString(forKey: .wabaId)
    }
}

/// Saldo YCloud.
struct WhatsAppAPIBalance: Decodable, Sendable, Equatable {
    let amount: Double
    let currency: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case amount, currency
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        amount = container.flexibleDouble(forKey: .amount) ?? 0
        currency = container.flexibleString(forKey: .currency)
        updatedAt = container.flexibleString(forKey: .updatedAt)
    }
}

// MARK: - WhatsApp API: plantillas (doc 10 §2.6)

/// Componente de plantilla (el preview usa el `text` del tipo `BODY`).
struct WhatsAppTemplateComponent: Decodable, Sendable, Equatable {
    let type: String?
    let text: String?

    enum CodingKeys: String, CodingKey {
        case type, text
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = container.flexibleString(forKey: .type)
        text = container.flexibleString(forKey: .text)
    }
}

/// `WhatsAppApiTemplate` (`mapTemplateRow`).
struct WhatsAppTemplate: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let officialTemplateId: String?
    let wabaId: String?
    /// Nombre para mostrar (prefiere el local).
    let name: String
    /// Nombre real en Meta.
    let officialName: String?
    let localTemplateId: String?
    /// Ej. `es_MX`.
    let language: String?
    let category: String?
    /// `APPROVED`, `PENDING`, `IN_REVIEW`, `IN_APPEAL`, `REJECTED`, `PAUSED`, `DISABLED`, …
    let status: String?
    let qualityRating: String?
    /// Motivo de rechazo/bloqueo.
    let reason: String?
    let statusUpdateEvent: String?
    let disableDate: String?
    let components: [WhatsAppTemplateComponent]
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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        officialTemplateId = container.flexibleString(forKey: .officialTemplateId)
        wabaId = container.flexibleString(forKey: .wabaId)
        name = container.flexibleString(forKey: .name) ?? ""
        officialName = container.flexibleString(forKey: .officialName)
        localTemplateId = container.flexibleString(forKey: .localTemplateId)
        language = container.flexibleString(forKey: .language)
        category = container.flexibleString(forKey: .category)
        status = container.flexibleString(forKey: .status)
        qualityRating = container.flexibleString(forKey: .qualityRating)
        reason = container.flexibleString(forKey: .reason)
        statusUpdateEvent = container.flexibleString(forKey: .statusUpdateEvent)
        disableDate = container.flexibleString(forKey: .disableDate)
        components = (try? container.decodeIfPresent([WhatsAppTemplateComponent].self, forKey: .components)) ?? []
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
    }

    /// Estados bloqueados: `{REJECTED, PAUSED, DISABLED}` (doc 10 §4.9).
    static let blockedStatuses: Set<String> = ["REJECTED", "PAUSED", "DISABLED"]

    var normalizedStatus: String {
        (status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    var isApproved: Bool { normalizedStatus == "APPROVED" }
    var isBlocked: Bool { Self.blockedStatuses.contains(normalizedStatus) }

    /// Etiquetas ES exactas (doc 10 §4.9).
    var statusLabel: String {
        switch normalizedStatus {
        case "APPROVED": return "Aprobada"
        case "PENDING", "IN_REVIEW": return "En revisión"
        case "REJECTED": return "Rechazada"
        case "PAUSED", "DISABLED": return "Bloqueada"
        case "", "UNKNOWN": return "Sin estado"
        default: return normalizedStatus
        }
    }

    /// Preview: texto del componente `BODY`, si no `reason`, si no fallback.
    var previewText: String {
        if let body = components.first(where: { ($0.type ?? "").uppercased() == "BODY" })?.text,
           !body.isEmpty {
            return body
        }
        if let reason, !reason.isEmpty { return reason }
        return "Sin vista previa."
    }

    /// Detalle de bloqueo cuando `isBlocked`.
    var blockDetail: String {
        if let reason, !reason.isEmpty { return reason }
        if let statusUpdateEvent, !statusUpdateEvent.isEmpty { return statusUpdateEvent }
        return "Meta no permite usar esta plantilla por ahora."
    }
}

/// Resumen de plantillas (`templates` del status y respuesta de `/templates`).
struct WhatsAppTemplatesSummary: Decodable, Sendable, Equatable {
    let total: Int
    let approved: Int
    let blocked: Int
    let items: [WhatsAppTemplate]

    enum CodingKeys: String, CodingKey {
        case total, approved, blocked, items
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        total = container.flexibleInt(forKey: .total) ?? 0
        approved = container.flexibleInt(forKey: .approved) ?? 0
        blocked = container.flexibleInt(forKey: .blocked) ?? 0
        items = (try? container.decodeIfPresent([WhatsAppTemplate].self, forKey: .items)) ?? []
    }
}

// MARK: - WhatsApp API: status completo (subset usado por Ajustes/Analíticas)

/// `GET /api/whatsapp-api/status` → `data` (doc 10 §2.6).
struct WhatsAppAPIStatus: Decodable, Sendable, Equatable {
    /// `'ycloud'` fijo.
    let provider: String?
    let activeProvider: String?
    let source: String?
    /// `enabled && hasApiKey`.
    let connected: Bool
    /// `hasApiKey`.
    let configured: Bool
    /// `'connected' | 'needs_phone' | 'disabled' | 'disconnected'`.
    let status: String?
    let credentials: WhatsAppAPICredentials?
    let sender: WhatsAppAPISender?
    /// Orden: default primero, luego `updated_at` desc.
    let phoneNumbers: [WhatsAppPhoneNumber]
    let selectedPhone: WhatsAppPhoneNumber?
    /// `true` si hay >1 número y ninguno default.
    let needsDefaultSelection: Bool
    let balance: WhatsAppAPIBalance?
    let templates: WhatsAppTemplatesSummary?

    enum CodingKeys: String, CodingKey {
        case provider, activeProvider, source, connected, configured, status
        case credentials, sender, phoneNumbers, selectedPhone
        case needsDefaultSelection, balance, templates
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = container.flexibleString(forKey: .provider)
        activeProvider = container.flexibleString(forKey: .activeProvider)
        source = container.flexibleString(forKey: .source)
        connected = container.flexibleBool(forKey: .connected) ?? false
        configured = container.flexibleBool(forKey: .configured) ?? false
        status = container.flexibleString(forKey: .status)
        credentials = try? container.decodeIfPresent(WhatsAppAPICredentials.self, forKey: .credentials)
        sender = try? container.decodeIfPresent(WhatsAppAPISender.self, forKey: .sender)
        phoneNumbers = (try? container.decodeIfPresent([WhatsAppPhoneNumber].self, forKey: .phoneNumbers)) ?? []
        selectedPhone = try? container.decodeIfPresent(WhatsAppPhoneNumber.self, forKey: .selectedPhone)
        needsDefaultSelection = container.flexibleBool(forKey: .needsDefaultSelection) ?? false
        balance = try? container.decodeIfPresent(WhatsAppAPIBalance.self, forKey: .balance)
        templates = try? container.decodeIfPresent(WhatsAppTemplatesSummary.self, forKey: .templates)
    }
}

/// Body de `POST /api/whatsapp-api/phone-numbers/default`.
struct WhatsAppDefaultPhoneRequest: Encodable, Sendable {
    let phoneNumberId: String
}

// MARK: - Errores 409 de OpenAI (doc 10 §4.4)

extension RistakAPIError {
    /// 409 con `code: OPENAI_CREDENTIAL_RECONNECT_REQUIRED` — la credencial
    /// guardada ya no desencripta: pedir «Reconecta OpenAI…».
    var needsOpenAIReconnect: Bool {
        status == 409 && code == "OPENAI_CREDENTIAL_RECONNECT_REQUIRED"
    }

    /// 409 en endpoints del agente AI = falta configurar/reconectar OpenAI
    /// (`needsOpenAIConfig`/`needsReconnect` en el body; el `code` empieza con
    /// `OPENAI`). Sin OpenAI listo, dictado y pulido no funcionan.
    var isOpenAIConfigurationIssue: Bool {
        status == 409 && (code?.hasPrefix("OPENAI") ?? true)
    }
}
