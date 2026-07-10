import Foundation

/// Fila de conversación de la bandeja (`GET /api/contacts/chats`) y también
/// resultado de `GET /api/contacts/search` (misma forma sin los campos
/// `lastMessage*`, que aquí decodifican con defaults vacíos).
/// Contrato exacto: docs/research/03-chats-inbox.md §1.1.
struct ChatContact: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let createdAt: String?
    let name: String
    let email: String
    let phone: String
    let matchedPhone: String?
    let ltv: Double
    /// `"lead" | "appointment" | "customer"`.
    let status: String
    let lastPurchase: String?
    let purchases: Int
    let successfulPaymentsCount: Int
    let hasAppointments: Bool
    let hasShowedAppointment: Bool
    let hasAttendedAppointment: Bool
    let hasUpcomingConfirmedAppointmentBadge: Bool
    let source: String?
    /// Mutable para poder conservar avatares ya hidratados al mergear páginas.
    var profilePhotoUrl: String?
    let adName: String?
    let adId: String?
    let preferredWhatsAppPhoneNumberId: String
    let phones: [ContactPhoneNumber]
    let customFields: [ContactCustomFieldValue]
    let tags: [String]
    let socialProfileName: String?
    let socialUsername: String?
    let notes: String
    /// Mutables porque la bandeja aplica actividad local/SSE al instante y
    /// luego la reconcilia con la primera pagina autoritativa del servidor.
    var lastMessageText: String
    var lastMessageType: String
    var lastMessageChannel: String
    var lastMessageDate: String?
    var lastMessageDirection: String
    var lastBusinessPhone: String
    var lastBusinessPhoneNumberId: String
    let lastInboundBusinessPhone: String
    let lastInboundBusinessPhoneNumberId: String
    let firstInboundBusinessPhone: String
    let firstInboundBusinessPhoneNumberId: String
    /// `"api" | "qr" | "smtp" | "ghl_email" | ""`.
    var lastMessageTransport: String
    var messageCount: Int
    var unreadCount: Int
    let hasCommentMessage: Bool
    let hasPrivateDm: Bool

    enum CodingKeys: String, CodingKey {
        case id, createdAt, name, email, phone, matchedPhone, ltv, status, lastPurchase
        case purchases, successfulPaymentsCount
        case hasAppointments, hasShowedAppointment, hasAttendedAppointment
        case hasUpcomingConfirmedAppointmentBadge
        case source, profilePhotoUrl
        case adName = "ad_name"
        case adId = "ad_id"
        case preferredWhatsAppPhoneNumberId
        case phones, phoneNumbers, customFields, tags
        case socialProfileName, socialUsername, notes
        case lastMessageText, lastMessageType, lastMessageChannel
        case lastMessageDate, lastMessageDirection
        case lastBusinessPhone, lastBusinessPhoneNumberId
        case lastInboundBusinessPhone, lastInboundBusinessPhoneNumberId
        case firstInboundBusinessPhone, firstInboundBusinessPhoneNumberId
        case lastMessageTransport, messageCount, unreadCount
        case hasCommentMessage, hasPrivateDm
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        createdAt = container.flexibleString(forKey: .createdAt)
        name = container.flexibleString(forKey: .name) ?? ""
        email = container.flexibleString(forKey: .email) ?? ""
        phone = container.flexibleString(forKey: .phone) ?? ""
        matchedPhone = container.flexibleString(forKey: .matchedPhone)
        ltv = container.flexibleDouble(forKey: .ltv) ?? 0
        status = container.flexibleString(forKey: .status) ?? "lead"
        lastPurchase = container.flexibleString(forKey: .lastPurchase)
        purchases = container.flexibleInt(forKey: .purchases) ?? 0
        successfulPaymentsCount = container.flexibleInt(forKey: .successfulPaymentsCount) ?? purchases
        hasAppointments = container.flexibleBool(forKey: .hasAppointments) ?? false
        hasShowedAppointment = container.flexibleBool(forKey: .hasShowedAppointment) ?? false
        hasAttendedAppointment = container.flexibleBool(forKey: .hasAttendedAppointment) ?? hasShowedAppointment
        hasUpcomingConfirmedAppointmentBadge = container.flexibleBool(forKey: .hasUpcomingConfirmedAppointmentBadge) ?? false
        source = container.flexibleString(forKey: .source)
        profilePhotoUrl = container.flexibleString(forKey: .profilePhotoUrl)
        adName = container.flexibleString(forKey: .adName)
        adId = container.flexibleString(forKey: .adId)
        preferredWhatsAppPhoneNumberId = container.flexibleString(forKey: .preferredWhatsAppPhoneNumberId) ?? ""
        let phonesValue = (try? container.decodeIfPresent([ContactPhoneNumber].self, forKey: .phones))
            ?? (try? container.decodeIfPresent([ContactPhoneNumber].self, forKey: .phoneNumbers))
        phones = phonesValue ?? []
        customFields = (try? container.decodeIfPresent([ContactCustomFieldValue].self, forKey: .customFields)) ?? []
        tags = (try? container.decodeIfPresent([String].self, forKey: .tags)) ?? []
        socialProfileName = container.flexibleString(forKey: .socialProfileName)
        socialUsername = container.flexibleString(forKey: .socialUsername)
        notes = container.flexibleString(forKey: .notes) ?? ""
        lastMessageText = container.flexibleString(forKey: .lastMessageText) ?? ""
        lastMessageType = container.flexibleString(forKey: .lastMessageType) ?? ""
        lastMessageChannel = container.flexibleString(forKey: .lastMessageChannel) ?? ""
        lastMessageDate = container.flexibleString(forKey: .lastMessageDate)
        lastMessageDirection = container.flexibleString(forKey: .lastMessageDirection) ?? ""
        lastBusinessPhone = container.flexibleString(forKey: .lastBusinessPhone) ?? ""
        lastBusinessPhoneNumberId = container.flexibleString(forKey: .lastBusinessPhoneNumberId) ?? ""
        lastInboundBusinessPhone = container.flexibleString(forKey: .lastInboundBusinessPhone) ?? ""
        lastInboundBusinessPhoneNumberId = container.flexibleString(forKey: .lastInboundBusinessPhoneNumberId) ?? ""
        firstInboundBusinessPhone = container.flexibleString(forKey: .firstInboundBusinessPhone) ?? ""
        firstInboundBusinessPhoneNumberId = container.flexibleString(forKey: .firstInboundBusinessPhoneNumberId) ?? ""
        lastMessageTransport = container.flexibleString(forKey: .lastMessageTransport) ?? ""
        messageCount = container.flexibleInt(forKey: .messageCount) ?? 0
        unreadCount = container.flexibleInt(forKey: .unreadCount) ?? 0
        hasCommentMessage = container.flexibleBool(forKey: .hasCommentMessage) ?? false
        hasPrivateDm = container.flexibleBool(forKey: .hasPrivateDm) ?? false
    }

    /// Direcciones consideradas SALIENTES por el cliente (doc 03 §4.6).
    static let outboundDirections: Set<String> = [
        "outbound", "outgoing", "sent", "business", "api", "app",
        "business_echo", "smb_echo", "echo", "message_echo",
    ]

    /// Regla nativa obligatoria: si el último mensaje es saliente, mostrar 0
    /// no leídos aunque el backend mande >0 (doc 03 §4.6).
    var visibleUnreadCount: Int {
        let direction = lastMessageDirection.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if Self.outboundDirections.contains(direction) { return 0 }
        return max(0, unreadCount)
    }

    /// Chat de "solo comentarios": nunca aparece en la vista normal de
    /// mensajes; solo bajo la lente `Comentarios` (doc 03 §3.1).
    var isCommentOnlyChat: Bool {
        if hasCommentMessage && !hasPrivateDm { return true }
        // Fallback si faltan flags: el último mensaje empieza con "comment".
        if !hasCommentMessage && !hasPrivateDm {
            return lastMessageType.lowercased().hasPrefix("comment")
        }
        return false
    }
}

/// Respuesta de `POST /api/contacts/chats/:id/read`.
struct ChatMarkReadResult: Decodable, Sendable {
    let contactId: String
    let unreadCount: Int
    let lastReadAt: String?

    enum CodingKeys: String, CodingKey {
        case contactId, unreadCount, lastReadAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contactId = container.flexibleString(forKey: .contactId) ?? ""
        unreadCount = container.flexibleInt(forKey: .unreadCount) ?? 0
        lastReadAt = container.flexibleString(forKey: .lastReadAt)
    }
}

/// Respuesta de `POST /api/contacts/chats/read` (bulk).
struct ChatBulkMarkReadResult: Decodable, Sendable {
    let updated: Int
    let contactIds: [String]
    let lastReadAt: String?

    enum CodingKeys: String, CodingKey {
        case updated, contactIds, lastReadAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        updated = container.flexibleInt(forKey: .updated) ?? 0
        contactIds = (try? container.decodeIfPresent([String].self, forKey: .contactIds)) ?? []
        lastReadAt = container.flexibleString(forKey: .lastReadAt)
    }
}

/// Página de bandeja ya evaluada (`hasMore` inferido: no hay total del server).
struct ChatInboxPage: Sendable {
    let contacts: [ChatContact]
    let hasMore: Bool
}

/// Helpers de paginación/merge de la bandeja (doc 03 §4.9 y §6.3):
/// `/contacts/chats` no devuelve total ni cursores; el cliente DEBE deduplicar
/// por `contact.id` y fusionar páginas conservando avatares ya hidratados.
enum ChatInboxPaginator {
    /// `hasMore` se infiere: si el lote llenó el `limit`, probablemente hay más.
    static func hasMore(batchCount: Int, limit: Int) -> Bool {
        batchCount >= limit
    }

    /// Append de una página nueva al final: filas ya existentes se actualizan
    /// en su posición (conservando avatar hidratado), las nuevas se agregan.
    static func appendPage(_ existing: [ChatContact], page: [ChatContact]) -> [ChatContact] {
        var result = existing
        var indexById: [String: Int] = [:]
        for (index, contact) in result.enumerated() {
            indexById[contact.id] = index
        }
        for fresh in page {
            if let index = indexById[fresh.id] {
                result[index] = preservingHydratedAvatar(old: result[index], fresh: fresh)
            } else {
                indexById[fresh.id] = result.count
                result.append(fresh)
            }
        }
        return result
    }

    /// Refresco vivo: la primera página fresca manda (orden del server) y el
    /// resto de la cola ya cargada se conserva detrás sin duplicados
    /// (no colapsa la profundidad de scroll, doc 03 §4.9).
    static func mergeRefresh(_ existing: [ChatContact], freshFirstPage: [ChatContact]) -> [ChatContact] {
        var oldById: [String: ChatContact] = [:]
        for contact in existing {
            oldById[contact.id] = contact
        }
        var seen = Set<String>()
        var result: [ChatContact] = []
        result.reserveCapacity(existing.count + freshFirstPage.count)
        for fresh in freshFirstPage where !fresh.id.isEmpty {
            guard seen.insert(fresh.id).inserted else { continue }
            if let old = oldById[fresh.id] {
                result.append(preservingHydratedAvatar(old: old, fresh: fresh))
            } else {
                result.append(fresh)
            }
        }
        for old in existing where seen.insert(old.id).inserted {
            result.append(old)
        }
        return result
    }

    /// Conserva el avatar previamente hidratado si la fila fresca llegó sin foto.
    static func preservingHydratedAvatar(old: ChatContact, fresh: ChatContact) -> ChatContact {
        var merged = fresh
        let freshPhoto = fresh.profilePhotoUrl?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if freshPhoto.isEmpty, let oldPhoto = old.profilePhotoUrl, !oldPhoto.isEmpty {
            merged.profilePhotoUrl = oldPhoto
        }
        return merged
    }
}
