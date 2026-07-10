import Foundation

/// Reducción pura usada por la bandeja real y por unit tests. Mantiene en un
/// solo contrato la promoción inmediata, preview y contador de no leídos.
struct ChatInboxActivityReduction: Equatable {
    let rows: [ChatContact]
    let updatedContact: ChatContact
    let promoted: Bool
}

enum ChatInboxActivityReducer {
    static func apply(
        _ activity: ChatInboxActivity,
        to sourceRows: [ChatContact],
        isDuplicate: Bool
    ) -> ChatInboxActivityReduction? {
        guard let index = sourceRows.firstIndex(where: { $0.id == activity.contactID }) else {
            return nil
        }

        var rows = sourceRows
        var contact = rows[index]
        let isOutbound = ChatRowSignals.isOutbound(activity.direction)

        if activity.conversationIsVisible {
            contact.unreadCount = 0
        } else if !isDuplicate, activity.isNew, !isOutbound {
            contact.unreadCount = max(0, contact.unreadCount) + 1
        }

        let activityDate = RistakDateParsing.date(fromISO: activity.timestamp)
        let currentDate = RistakDateParsing.date(fromISO: contact.lastMessageDate)
        let isCurrentEnough: Bool
        if let activityDate, let currentDate {
            isCurrentEnough = activityDate >= currentDate
        } else {
            isCurrentEnough = true
        }

        // Los envíos locales mandan aunque el reloj del dispositivo difiera.
        // Los entrantes conservan la fecha autoritativa para no revivir eventos.
        let shouldPromote = activity.isNew && (isOutbound || isCurrentEnough)
        if shouldPromote {
            contact = applyingFields(activity, to: contact)
            rows.remove(at: index)
            rows.insert(contact, at: 0)
        } else if contact != rows[index] {
            rows[index] = contact
        }

        return ChatInboxActivityReduction(
            rows: rows,
            updatedContact: contact,
            promoted: shouldPromote
        )
    }

    static func applyingFields(
        _ activity: ChatInboxActivity,
        to source: ChatContact
    ) -> ChatContact {
        var contact = source
        if let text = activity.text { contact.lastMessageText = text }
        if !activity.messageType.isEmpty { contact.lastMessageType = activity.messageType }
        if !activity.channel.isEmpty { contact.lastMessageChannel = activity.channel }
        if !activity.transport.isEmpty { contact.lastMessageTransport = activity.transport }
        if !activity.direction.isEmpty { contact.lastMessageDirection = activity.direction }
        if let phone = activity.businessPhone, !phone.isEmpty {
            contact.lastBusinessPhone = phone
        }
        if let phoneID = activity.businessPhoneNumberID, !phoneID.isEmpty {
            contact.lastBusinessPhoneNumberId = phoneID
        }
        if !activity.timestamp.isEmpty { contact.lastMessageDate = activity.timestamp }
        return contact
    }
}
