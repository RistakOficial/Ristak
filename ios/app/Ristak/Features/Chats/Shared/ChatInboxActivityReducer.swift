import Foundation

/// Reducción pura usada por la bandeja real y por unit tests. Mantiene en un
/// solo contrato la promoción inmediata, preview y contador de no leídos.
struct ChatInboxActivityReduction: Equatable {
    let rows: [ChatContact]
    let updatedContact: ChatContact
    let promoted: Bool
}

/// Buffer acotado para eventos SSE de contactos que todavía no están en las
/// páginas cargadas. Coalesce por contacto y por mensaje: una ráfaga no abre
/// varios GET ni puede crecer sin límite mientras la red está lenta.
struct ChatUnknownActivityBuffer {
    struct EnqueueResult: Equatable {
        let accepted: Bool
        let evictedContactID: String?
    }

    struct Batch: Equatable {
        let activities: [ChatInboxActivity]

        var pendingInboundCount: Int {
            activities.reduce(into: 0) { count, activity in
                if activity.isNew,
                   !activity.conversationIsVisible,
                   !ChatRowSignals.isOutbound(activity.direction) {
                    count += 1
                }
            }
        }
    }

    static let maxContacts = 32
    static let maxActivitiesPerContact = 16

    private var activitiesByContactID: [String: [ChatInboxActivity]] = [:]
    private var contactOrder: [String] = []

    var isEmpty: Bool { activitiesByContactID.isEmpty }
    var contactIDs: [String] { contactOrder }

    func contains(contactID: String) -> Bool {
        activitiesByContactID[contactID] != nil
    }

    mutating func enqueue(_ activity: ChatInboxActivity) -> EnqueueResult {
        guard activity.isNew, !activity.contactID.isEmpty else {
            return EnqueueResult(accepted: false, evictedContactID: nil)
        }

        var activities = activitiesByContactID[activity.contactID] ?? []
        if let duplicateIndex = activities.firstIndex(where: {
            $0.deduplicationKey == activity.deduplicationKey
        }) {
            guard activity.conversationIsVisible,
                  !activities[duplicateIndex].conversationIsVisible else {
                return EnqueueResult(accepted: false, evictedContactID: nil)
            }
            activities[duplicateIndex] = activities[duplicateIndex].withConversationVisible()
            activitiesByContactID[activity.contactID] = activities
            return EnqueueResult(accepted: true, evictedContactID: nil)
        }

        var evictedContactID: String?
        if activities.isEmpty {
            if activitiesByContactID.count >= Self.maxContacts,
               let oldest = contactOrder.first {
                contactOrder.removeFirst()
                activitiesByContactID[oldest] = nil
                evictedContactID = oldest
            }
            contactOrder.append(activity.contactID)
        }

        activities.append(activity)
        if activities.count > Self.maxActivitiesPerContact {
            activities.removeFirst(activities.count - Self.maxActivitiesPerContact)
        }
        activitiesByContactID[activity.contactID] = activities
        return EnqueueResult(accepted: true, evictedContactID: evictedContactID)
    }

    mutating func take(contactID: String) -> Batch? {
        guard let activities = activitiesByContactID.removeValue(forKey: contactID) else {
            return nil
        }
        contactOrder.removeAll { $0 == contactID }
        return Batch(activities: activities)
    }

    mutating func removeAll() {
        activitiesByContactID.removeAll()
        contactOrder.removeAll()
    }
}

enum ChatNavigationDestinationResolver {
    enum ValidationStatus: Equatable {
        case valid
        case invalid
        case unknown
    }

    static func validationStatus(phone: String, contact: ChatContact) -> ValidationStatus {
        validationStatus(
            phone: phone,
            primaryPhone: contact.phone,
            phones: contact.phones,
            inventoryIsComplete: !contact.phones.isEmpty
        )
    }

    static func validationStatus(phone: String, contact: ContactDetail) -> ValidationStatus {
        validationStatus(
            phone: phone,
            primaryPhone: contact.phone,
            phones: contact.phones,
            inventoryIsComplete: true
        )
    }

    private static func validationStatus(
        phone: String,
        primaryPhone: String,
        phones: [ContactPhoneNumber],
        inventoryIsComplete: Bool
    ) -> ValidationStatus {
        let selectedDigits = ChatRowSignals.digitsOnly(phone)
        guard selectedDigits.count >= 7 else { return .invalid }
        let knownPhones = ([primaryPhone] + phones.map(\.phone))
            .map(ChatRowSignals.digitsOnly)
            .filter { !$0.isEmpty }
        if knownPhones.contains(selectedDigits) { return .valid }
        // El endpoint actual siempre incluye `phones`, aun si sólo existe el
        // principal. Un snapshot legacy sin ese arreglo es información
        // incompleta: no declaramos inválido, pero tampoco permitimos enviar.
        return inventoryIsComplete ? .invalid : .unknown
    }

    static func resolve(
        authoritativeRow: ChatContact?,
        navigationSeed: ChatContact?,
        directorySeed: ChatContact?,
        persistedPhone: String?,
        persistedPhoneIsValidated: Bool = false
    ) -> ChatContact? {
        guard var contact = authoritativeRow ?? navigationSeed ?? directorySeed else { return nil }
        let explicitPhone = navigationSeed?.matchedPhone?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !explicitPhone.isEmpty,
           let navigationSeed,
           validationStatus(phone: explicitPhone, contact: navigationSeed) != .invalid {
            contact.matchedPhone = explicitPhone
            contact.destinationPhoneRequiresValidation = false
            return contact
        }

        let storedPhone = persistedPhone?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !storedPhone.isEmpty else { return contact }
        let validationContact = [authoritativeRow, directorySeed, navigationSeed]
            .compactMap { $0 }
            .first { !$0.phones.isEmpty || ChatRowSignals.digitsOnly($0.phone) == ChatRowSignals.digitsOnly(storedPhone) }
            ?? contact
        guard validationStatus(phone: storedPhone, contact: validationContact) != .invalid else {
            contact.matchedPhone = nil
            contact.destinationPhoneRequiresValidation = false
            return contact
        }
        contact.matchedPhone = storedPhone
        contact.destinationPhoneRequiresValidation = !persistedPhoneIsValidated
        return contact
    }
}

enum ChatInboxServerReconciliation {
    /// Determina si una fila REST ya avanzó hasta esta actividad. La mera
    /// presencia del contacto no basta: una página vieja puede haber salido
    /// antes del SSE y su unread todavía necesita el delta local.
    static func contains(_ activity: ChatInboxActivity, in contact: ChatContact) -> Bool {
        let directionMatches = ChatRowSignals.isOutbound(contact.lastMessageDirection)
            == ChatRowSignals.isOutbound(activity.direction)
        let activityText = (activity.text ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let serverText = contact.lastMessageText
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if directionMatches, !activityText.isEmpty, activityText == serverText {
            return true
        }

        guard let activityDate = RistakDateParsing.date(fromISO: activity.timestamp),
              let serverDate = RistakDateParsing.date(fromISO: contact.lastMessageDate) else {
            return false
        }
        if serverDate > activityDate { return true }
        guard abs(serverDate.timeIntervalSince(activityDate)) < 0.001,
              directionMatches else { return false }
        return activity.messageType.isEmpty
            || contact.lastMessageType.caseInsensitiveCompare(activity.messageType) == .orderedSame
    }

    static func containedInboundCount(
        in activities: [ChatInboxActivity],
        serverContact: ChatContact?
    ) -> Int {
        guard let serverContact else { return 0 }
        return activities.reduce(into: 0) { count, activity in
            if activity.isNew,
               !activity.conversationIsVisible,
               !ChatRowSignals.isOutbound(activity.direction),
               contains(activity, in: serverContact) {
                count += 1
            }
        }
    }
}

enum ChatInboxActivityReducer {
    static func apply(
        _ activity: ChatInboxActivity,
        to sourceRows: [ChatContact],
        seedContact: ChatContact? = nil,
        isDuplicate: Bool
    ) -> ChatInboxActivityReduction? {
        var rows = sourceRows
        var index = rows.firstIndex(where: { $0.id == activity.contactID })
        if index == nil,
           let seedContact,
           seedContact.id == activity.contactID {
            rows.append(seedContact)
            index = rows.indices.last
        }
        guard let index else { return nil }

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
