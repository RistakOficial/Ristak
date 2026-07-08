import Foundation

/// Cache-first de la bandeja (doc research/03 §4.9 MOB-007): guarda un
/// snapshot en disco de las primeras filas para pintar al instante en el
/// arranque en frío, mientras corre UNA recarga silenciosa (píldora
/// «Mostrando lo guardado, actualizando chats»).
///
/// Serializa un SUBSET de campos con los mismos nombres del contrato JSON y
/// re-decodifica con el decoder tolerante de `ChatContact` (todos los campos
/// tienen default), evitando conformar `Encodable` en el modelo de Core.
enum ChatInboxDiskCache {
    private static let maxRows = 300

    // MARK: - API

    static func load(namespace: String) -> [ChatContact] {
        let url = fileURL(namespace: namespace)
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([ChatContact].self, from: data)) ?? []
    }

    static func save(_ rows: [ChatContact], namespace: String) {
        let snapshot = rows.prefix(maxRows).map(serialize)
        guard JSONSerialization.isValidJSONObject(snapshot),
              let data = try? JSONSerialization.data(withJSONObject: snapshot) else {
            return
        }
        try? data.write(to: fileURL(namespace: namespace), options: .atomic)
    }

    static func clear(namespace: String) {
        try? FileManager.default.removeItem(at: fileURL(namespace: namespace))
    }

    // MARK: - Internos

    private static func fileURL(namespace: String) -> URL {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let safeName = namespace.unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? String($0) : "-" }
            .joined()
        return directory.appendingPathComponent("ristak-chat-inbox-\(safeName).json")
    }

    /// Subset de claves con los MISMOS nombres del payload del backend.
    private static func serialize(_ contact: ChatContact) -> [String: Any] {
        var entry: [String: Any] = [
            "id": contact.id,
            "name": contact.name,
            "email": contact.email,
            "phone": contact.phone,
            "ltv": contact.ltv,
            "status": contact.status,
            "purchases": contact.purchases,
            "successfulPaymentsCount": contact.successfulPaymentsCount,
            "hasAppointments": contact.hasAppointments,
            "hasShowedAppointment": contact.hasShowedAppointment,
            "hasAttendedAppointment": contact.hasAttendedAppointment,
            "hasUpcomingConfirmedAppointmentBadge": contact.hasUpcomingConfirmedAppointmentBadge,
            "preferredWhatsAppPhoneNumberId": contact.preferredWhatsAppPhoneNumberId,
            "notes": contact.notes,
            "tags": contact.tags,
            "lastMessageText": contact.lastMessageText,
            "lastMessageType": contact.lastMessageType,
            "lastMessageChannel": contact.lastMessageChannel,
            "lastMessageDirection": contact.lastMessageDirection,
            "lastBusinessPhone": contact.lastBusinessPhone,
            "lastBusinessPhoneNumberId": contact.lastBusinessPhoneNumberId,
            "lastInboundBusinessPhone": contact.lastInboundBusinessPhone,
            "lastInboundBusinessPhoneNumberId": contact.lastInboundBusinessPhoneNumberId,
            "firstInboundBusinessPhone": contact.firstInboundBusinessPhone,
            "firstInboundBusinessPhoneNumberId": contact.firstInboundBusinessPhoneNumberId,
            "lastMessageTransport": contact.lastMessageTransport,
            "messageCount": contact.messageCount,
            "unreadCount": contact.unreadCount,
            "hasCommentMessage": contact.hasCommentMessage,
            "hasPrivateDm": contact.hasPrivateDm,
        ]
        if let createdAt = contact.createdAt { entry["createdAt"] = createdAt }
        if let lastPurchase = contact.lastPurchase { entry["lastPurchase"] = lastPurchase }
        if let source = contact.source { entry["source"] = source }
        if let photo = contact.profilePhotoUrl { entry["profilePhotoUrl"] = photo }
        if let adName = contact.adName { entry["ad_name"] = adName }
        if let adID = contact.adId { entry["ad_id"] = adID }
        if let socialName = contact.socialProfileName { entry["socialProfileName"] = socialName }
        if let username = contact.socialUsername { entry["socialUsername"] = username }
        if let date = contact.lastMessageDate { entry["lastMessageDate"] = date }
        return entry
    }
}
