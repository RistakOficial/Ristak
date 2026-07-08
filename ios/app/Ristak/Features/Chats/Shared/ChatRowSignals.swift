import Foundation

/// Heurísticas de presentación y detección de canal/origen sobre las filas de
/// la bandeja (doc research/03 §3.3 y §4.3; port de `getContactChannelKind` /
/// `contactMatchesPhoneAdvancedFilters` de RN y /movil).
enum ChatRowSignals {
    // MARK: - Nombre y subtítulos

    /// Nombre visible: nombre → email → teléfono → «Contacto sin nombre».
    static func displayName(_ contact: ChatContact) -> String {
        for candidate in [contact.name, contact.email, contact.phone] {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return "Contacto sin nombre"
    }

    /// Subtítulo alterno cuando la vista previa está apagada:
    /// teléfono → `@username` → email → «Sin datos de contacto».
    static func contactDetailSubtitle(_ contact: ChatContact) -> String {
        let phone = contact.phone.trimmingCharacters(in: .whitespacesAndNewlines)
        if !phone.isEmpty { return phone }
        if let username = contact.socialUsername?.trimmingCharacters(in: .whitespacesAndNewlines),
           !username.isEmpty {
            return "@\(username)"
        }
        let email = contact.email.trimmingCharacters(in: .whitespacesAndNewlines)
        if !email.isEmpty { return email }
        return "Sin datos de contacto"
    }

    // MARK: - Preview del último mensaje (doc 03 §4.3 `getChatPreview`)

    static func isOutbound(_ direction: String) -> Bool {
        ChatContact.outboundDirections.contains(
            direction.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        )
    }

    /// Preview con prefijo `Tú: ` para salientes y labels por tipo de media.
    static func preview(_ contact: ChatContact) -> String {
        let base = previewBody(contact)
        guard !base.isEmpty else { return base }
        if isOutbound(contact.lastMessageDirection) {
            return "Tú: \(base)"
        }
        return base
    }

    private static func previewBody(_ contact: ChatContact) -> String {
        let text = contact.lastMessageText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }

        let type = contact.lastMessageType.lowercased()
        if type.contains("gif") { return "GIF" }
        if type.contains("sticker") { return "Sticker" }
        if type.contains("image") || type.contains("photo") { return "Foto" }
        if type.contains("video") { return "Video" }
        if type.contains("audio") || type.contains("voice") || type.contains("ptt") { return "Mensaje de voz" }
        if type.contains("document") || type.contains("file") { return "Documento" }
        if type.contains("location") { return "Ubicación" }
        if type.contains("quick_reply") || type.contains("postback") { return "Respuesta rápida" }
        if type.contains("reaction") { return "Reacción" }

        let channel = contact.lastMessageChannel.lowercased()
        if channel.contains("instagram") { return "Mensaje de Instagram" }
        if channel.contains("messenger") || channel.contains("facebook") { return "Mensaje de Messenger" }
        if channel.contains("whatsapp") || !channel.isEmpty { return "Mensaje de WhatsApp" }
        return ""
    }

    // MARK: - Badge de canal (comentario primero, doc 03 §4.3)

    static func badgeChannel(_ contact: ChatContact) -> RistakChatChannel? {
        let type = contact.lastMessageType.lowercased()
        let channel = contact.lastMessageChannel.lowercased()

        if type.hasPrefix("comment") || channel.contains("comment") {
            return channel.contains("instagram") ? .instagram : .facebook
        }
        if let mapped = RistakChatChannel(raw: contact.lastMessageChannel) {
            return mapped
        }
        let transport = contact.lastMessageTransport.lowercased()
        if transport == "smtp" || transport == "ghl_email" { return .gmail }
        if transport == "api" || transport == "qr" { return .whatsapp }
        if let source = contact.source, let mapped = RistakChatChannel(raw: source) {
            return mapped
        }
        return nil
    }

    // MARK: - Detección para filtros avanzados (doc 03 §3.3)

    /// Canal efectivo: `whatsapp|messenger|instagram|webchat|sms|email`.
    static func channelKey(_ contact: ChatContact) -> String {
        let channel = contact.lastMessageChannel.lowercased()
        let transport = contact.lastMessageTransport.lowercased()

        if channel.contains("instagram") { return "instagram" }
        if channel.contains("messenger") || channel.contains("facebook") { return "messenger" }
        if channel == "email" || channel.contains("mail") || transport == "smtp" || transport == "ghl_email" { return "email" }
        if channel.contains("sms") || transport == "ghl_sms" { return "sms" }
        if channel.contains("webchat") || channel.contains("web_chat") || transport == "ghl_webchat" { return "webchat" }
        if channel.contains("whatsapp") || transport == "api" || transport == "qr" { return "whatsapp" }
        return channel
    }

    /// Origen: `meta|site|organic|trigger|unknown`.
    static func originKey(_ contact: ChatContact) -> String {
        let source = ristakFoldedText(contact.source ?? "")
        let hasAd = !(contact.adId ?? "").isEmpty || !(contact.adName ?? "").isEmpty

        if hasAd { return "meta" }
        if source.isEmpty { return "unknown" }
        if source.contains("meta") || source.contains("facebook") || source.contains("instagram")
            || source.contains("fb") || source.contains("ig") || source.contains("ads") {
            return "meta"
        }
        if source.contains("trigger") || source.contains("link") || source.contains("enlace") {
            return "trigger"
        }
        if source.contains("site") || source.contains("web") || source.contains("form")
            || source.contains("landing") || source.contains("funnel") {
            return "site"
        }
        if source.contains("organic") || source.contains("organico") || source.contains("direct") {
            return "organic"
        }
        return "organic"
    }

    /// Red social detectada: `facebook|instagram|messenger|whatsapp|google|unknown`.
    static func socialKey(_ contact: ChatContact) -> String {
        let haystack = ristakFoldedText(
            [contact.source ?? "", contact.lastMessageChannel, contact.adName ?? ""].joined(separator: " ")
        )
        if haystack.contains("instagram") || haystack.contains("ig ") { return "instagram" }
        if haystack.contains("messenger") { return "messenger" }
        if haystack.contains("facebook") || haystack.contains("fb") { return "facebook" }
        if haystack.contains("whatsapp") { return "whatsapp" }
        if haystack.contains("google") { return "google" }
        return "unknown"
    }

    /// Etapa: compara contra `status`.
    static func stageKey(_ contact: ChatContact) -> String {
        contact.status.lowercased()
    }

    /// Actividad: `payments|appointments|with_source|no_phone`.
    static func matchesActivity(_ value: String, contact: ChatContact) -> Bool {
        switch value {
        case "payments":
            return contact.purchases > 0 || contact.ltv > 0
        case "appointments":
            return contact.hasAppointments
        case "with_source":
            return !(contact.source ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case "no_phone":
            return contact.phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        default:
            return false
        }
    }

    static func matchesAdvanced(group: String, value: String, contact: ChatContact) -> Bool {
        switch group {
        case "channel": return channelKey(contact) == value
        case "origin": return originKey(contact) == value
        case "social": return socialKey(contact) == value
        case "stage": return stageKey(contact) == value
        case "activity": return matchesActivity(value, contact: contact)
        default: return true
        }
    }

    // MARK: - Rápidos (doc 03 §3.1)

    static func isCustomer(_ contact: ChatContact) -> Bool {
        contact.status.lowercased() == "customer" || contact.purchases > 0 || contact.ltv > 0
    }

    static func isAppointment(_ contact: ChatContact) -> Bool {
        contact.status.lowercased() == "appointment" || contact.hasAppointments
    }

    static func isLead(_ contact: ChatContact) -> Bool {
        !isCustomer(contact) && !isAppointment(contact) && contact.status.lowercased() == "lead"
    }

    /// Regla comentario vs. DM (crítica, doc 03 §3.1): la lente muestra a
    /// cualquier contacto con comentario, aunque tenga DM.
    static func hasCommentSignal(_ contact: ChatContact) -> Bool {
        if contact.hasCommentMessage { return true }
        return contact.lastMessageType.lowercased().hasPrefix("comment")
    }

    static func matchesCommentsPlatform(_ platform: ChatCommentsPlatform, contact: ChatContact) -> Bool {
        switch platform {
        case .all:
            return true
        case .facebook:
            let channel = contact.lastMessageChannel.lowercased()
            return channel.contains("facebook") || channel.contains("messenger")
        case .instagram:
            return contact.lastMessageChannel.lowercased().contains("instagram")
        }
    }

    static func matchesQuick(_ quick: ChatQuickFilter, contact: ChatContact) -> Bool {
        switch quick {
        case .all: return true
        case .unread: return contact.visibleUnreadCount > 0
        case .appointments: return isAppointment(contact)
        case .customers: return isCustomer(contact)
        case .leads: return isLead(contact)
        case .comments: return hasCommentSignal(contact)
        }
    }

    // MARK: - Filtro local por número (doc 03 §3.2)

    static func matchesBusinessPhone(_ contact: ChatContact, number: WhatsAppPhoneNumber) -> Bool {
        if !number.id.isEmpty, contact.lastBusinessPhoneNumberId == number.id { return true }
        let candidates = [number.phoneNumber, number.displayPhoneNumber, number.qrConnectedPhone]
            .compactMap { $0 }
            .map(digitsOnly)
            .filter { !$0.isEmpty }
        guard !candidates.isEmpty else { return false }
        let rowPhone = digitsOnly(contact.lastBusinessPhone)
        guard !rowPhone.isEmpty else { return false }
        return candidates.contains { $0.hasSuffix(rowPhone) || rowPhone.hasSuffix($0) }
    }

    static func digitsOnly(_ value: String) -> String {
        value.filter(\.isNumber)
    }
}
