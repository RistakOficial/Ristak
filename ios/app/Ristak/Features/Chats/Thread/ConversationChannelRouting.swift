import Foundation

/// Un reintento corto y acotado para catálogos LOCALES del backend. Estos GET
/// no consultan Meta ni disparan sincronizaciones externas; solo recuperan la
/// configuración que Ristak ya tiene guardada.
enum ConversationLocalCatalogRetry {
    static let defaultRetryDelayNanoseconds: UInt64 = 300_000_000

    static func load<Value>(
        retryDelayNanoseconds: UInt64 = defaultRetryDelayNanoseconds,
        operation: () async throws -> Value
    ) async throws -> Value {
        do {
            return try await operation()
        } catch {
            try Task.checkCancellation()
            if retryDelayNanoseconds > 0 {
                try await Task.sleep(nanoseconds: retryDelayNanoseconds)
            }
            try Task.checkCancellation()
            return try await operation()
        }
    }
}

/// Evita perder un nudge SSE que llega entre la apertura del hilo y el fin del
/// primer intento de `/conversation`. Un fallo transitorio también abre la
/// recuperación silenciosa: el siguiente SSE/poll puede volver a cargar el hilo
/// sin obligar al usuario a tocar «Reintentar».
struct ConversationRealtimeBootstrapGate: Equatable {
    private(set) var initialAttemptFinished = false
    private(set) var hasPendingRefresh = false

    mutating func beginInitialAttempt() {
        initialAttemptFinished = false
    }

    mutating func receiveVisibleThreadEvent() -> Bool {
        guard initialAttemptFinished else {
            hasPendingRefresh = true
            return false
        }
        return true
    }

    /// `allowsSilentRecovery` es false únicamente para estados terminales del
    /// bootstrap (acceso denegado o cancelación por abandonar la pantalla).
    /// Los errores de red sí terminan el intento y habilitan la recuperación.
    mutating func finishInitialAttempt(allowsSilentRecovery: Bool) -> Bool {
        guard allowsSilentRecovery else { return false }
        initialAttemptFinished = true
        let shouldRefresh = hasPendingRefresh
        hasPendingRefresh = false
        return shouldRefresh
    }
}

enum ConversationRealtimeConnectionTransition: Equatable {
    case none
    case initial
    case disconnected
    case reconnected
}

/// Decide si una transición de conexión necesita cerrar un hueco sin replay.
/// La conexión inicial que llega mientras el GET inicial está en vuelo NO agrega
/// una segunda descarga; si llega tarde, o es una reconexión real, sí reconcilia.
enum ConversationRealtimeRefreshDecision {
    static func shouldReconcile(
        transition: ConversationRealtimeConnectionTransition,
        initialAttemptFinished: Bool
    ) -> Bool {
        switch transition {
        case .initial:
            return initialAttemptFinished
        case .reconnected:
            return true
        case .none, .disconnected:
            return false
        }
    }
}

/// Contrato de reconciliación del hilo: SSE es la ruta normal; el GET periódico
/// existe únicamente mientras la conexión está caída. Veinticinco segundos deja
/// margen al reconnect del engine (1...15 s) sin regresar al poll agresivo de 4 s.
struct ConversationRealtimePollingPolicy: Equatable {
    static let fallbackInterval: TimeInterval = 25

    private(set) var isConnected = false
    private(set) var hasEverConnected = false

    var shouldScheduleFallback: Bool { !isConnected }

    /// Distingue el primer enlace del socket de una reconexión real. Repetir el
    /// mismo frame es `.none` y no reprograma timers ni descarga conversaciones.
    @discardableResult
    mutating func setConnected(_ connected: Bool) -> ConversationRealtimeConnectionTransition {
        guard isConnected != connected else { return .none }
        isConnected = connected
        guard connected else { return .disconnected }
        if hasEverConnected { return .reconnected }
        hasEverConnected = true
        return .initial
    }
}

/// Ventana de respuesta de WhatsApp nativo ligada al remitente seleccionado.
/// Una conversación de HighLevel o de otro número de negocio nunca abre la
/// ventana de Meta/YCloud por accidente.
enum ConversationWhatsAppReplyWindowResolver {
    static func lastInboundDate(
        in messages: [ChatMessage],
        selectedPhone: WhatsAppPhoneNumber?
    ) -> Date? {
        guard let selectedPhone else { return nil }

        let senderID = clean(selectedPhone.id)
        let senderPhones = [
            selectedPhone.phoneNumber,
            selectedPhone.displayPhoneNumber,
            selectedPhone.qrConnectedPhone,
        ].compactMap { value -> String? in
            let cleaned = clean(value)
            return cleaned.isEmpty ? nil : cleaned
        }
        guard !senderID.isEmpty || !senderPhones.isEmpty else { return nil }

        return messages.compactMap { message -> Date? in
            guard message.direction == .inbound, !message.isComment else { return nil }

            let probe = "\(message.transport ?? "") \(message.channel)".lowercased()
            let excluded = probe.contains("sms")
                || probe.contains("messenger")
                || probe.contains("instagram")
                || probe.contains("facebook")
                || probe.contains("mail")
                || probe.contains("highlevel")
                || probe.contains("ghl_")
            guard !excluded else { return nil }

            let messageID = clean(message.businessPhoneNumberId)
            let messagePhone = clean(message.businessPhone)
            let matchesID = !senderID.isEmpty && !messageID.isEmpty && senderID == messageID
            let matchesPhone = !messagePhone.isEmpty && senderPhones.contains {
                ConversationWhatsAppRouteResolver.phoneValuesMatch($0, messagePhone)
            }

            // Las filas legacy sin identidad del remitente fallan cerrado: no
            // podemos prestarles la ventana de otro número conectado.
            guard matchesID || matchesPhone else { return nil }
            return message.parsedDate
        }.max()
    }

    private static func clean(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

/// Política pura para reconciliar globos optimistas con su espejo durable.
/// Los fallos reconocidos por proveedor sólo se unen mediante una identidad
/// exacta; un timeout local jamás se adivina por texto.
enum ConversationOptimisticReconciliationPolicy {
    static func canMatch(
        optimistic: ChatMessage,
        isInFlight: Bool,
        providerAcknowledgedFailure: Bool,
        authoritativeServerMessageID: String?
    ) -> Bool {
        guard !isInFlight else { return false }
        guard optimistic.failed else { return true }
        guard providerAcknowledgedFailure else { return false }
        return optimistic.providerMessageId?.isEmpty == false
            || authoritativeServerMessageID?.isEmpty == false
    }

    static func identitiesMatch(
        optimisticProviderMessageID: String?,
        authoritativeServerMessageID: String?,
        server: ChatMessage
    ) -> Bool {
        let providerMatches = optimisticProviderMessageID?.isEmpty == false
            && server.providerMessageId == optimisticProviderMessageID
        let localIDMatches = authoritativeServerMessageID?.isEmpty == false
            && server.id == authoritativeServerMessageID
        return providerMatches || localIDMatches
    }
}

/// HighLevel no expone en `/phone-numbers` un catálogo de remitentes WhatsApp;
/// ese endpoint es LC Phone/SMS. Para responder por WhatsApp sólo es confiable
/// el `business_phone` observado en el inbound GHL más reciente del hilo.
enum ConversationHighLevelWhatsAppRouteResolver {
    static func latestInboundBusinessPhone(in messages: [ChatMessage]) -> String? {
        messages.compactMap { message -> (date: Date, phone: String)? in
            guard message.direction == .inbound else { return nil }
            let transport = normalize(message.transport)
            let channel = normalize(message.channel)
            guard transport == "ghl_whatsapp" || channel == "ghl_whatsapp" else { return nil }
            guard let date = message.parsedDate else { return nil }
            let phone = message.businessPhone?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !phone.isEmpty else { return nil }
            return (date, phone)
        }
        .max(by: { $0.date < $1.date })?
        .phone
    }

    private static func normalize(_ value: String?) -> String {
        (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")
    }
}

/// Contrato compartido con DesktopChat para decidir el número de negocio:
/// preferido -> último inbound -> último mensaje -> default -> primero.
enum ConversationWhatsAppRouteResolver {
    static func resolvePhone(
        from phones: [WhatsAppPhoneNumber],
        preferredPhoneNumberID: String?,
        lastInboundBusinessPhoneNumberID: String?,
        lastInboundBusinessPhone: String?,
        lastBusinessPhoneNumberID: String?,
        lastBusinessPhone: String?
    ) -> WhatsAppPhoneNumber? {
        if let phone = phone(withID: preferredPhoneNumberID, in: phones) {
            return phone
        }
        if let phone = phone(withID: lastInboundBusinessPhoneNumberID, in: phones) {
            return phone
        }
        if let phone = phone(matching: lastInboundBusinessPhone, in: phones) {
            return phone
        }
        if let phone = phone(withID: lastBusinessPhoneNumberID, in: phones) {
            return phone
        }
        if let phone = phone(matching: lastBusinessPhone, in: phones) {
            return phone
        }
        return phones.first(where: \.isDefaultSender) ?? phones.first
    }

    static func defaultChannel(
        latestChannelEvidence: String,
        highLevelConnected: Bool,
        highLevelWhatsAppFromNumber: String?,
        highLevelPhoneNumbers: [HighLevelPhoneNumber],
        whatsAppPhones: [WhatsAppPhoneNumber],
        preferredPhoneNumberID: String?,
        lastInboundBusinessPhoneNumberID: String?,
        lastInboundBusinessPhone: String?,
        lastBusinessPhoneNumberID: String?,
        lastBusinessPhone: String?
    ) -> ComposerChannel {
        let latest = latestChannelEvidence.lowercased()
        if highLevelConnected, latest.contains("ghl_whatsapp") {
            return .highLevelWhatsApp(fromNumber: highLevelWhatsAppFromNumber ?? "")
        }
        if highLevelConnected, latest.contains("ghl_sms") || latest.contains("sms_qr") {
            let sender = highLevelPhoneNumbers.first(where: \.isDefault)?.phoneNumber
                ?? highLevelPhoneNumbers.first?.phoneNumber
                ?? ""
            return .sms(fromNumber: sender)
        }

        let phone = resolvePhone(
            from: whatsAppPhones,
            preferredPhoneNumberID: preferredPhoneNumberID,
            lastInboundBusinessPhoneNumberID: lastInboundBusinessPhoneNumberID,
            lastInboundBusinessPhone: lastInboundBusinessPhone,
            lastBusinessPhoneNumberID: lastBusinessPhoneNumberID,
            lastBusinessPhone: lastBusinessPhone
        )
        return .whatsapp(phoneNumberId: phone?.id ?? "")
    }

    static func phoneValuesMatch(_ left: String?, _ right: String?) -> Bool {
        let leftDigits = digits(left)
        let rightDigits = digits(right)
        guard !leftDigits.isEmpty, !rightDigits.isEmpty else { return false }
        return leftDigits == rightDigits
            || leftDigits.hasSuffix(rightDigits)
            || rightDigits.hasSuffix(leftDigits)
    }

    private static func phone(withID rawID: String?, in phones: [WhatsAppPhoneNumber]) -> WhatsAppPhoneNumber? {
        let id = rawID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty else { return nil }
        return phones.first(where: { $0.id == id })
    }

    private static func phone(matching rawPhone: String?, in phones: [WhatsAppPhoneNumber]) -> WhatsAppPhoneNumber? {
        guard let rawPhone, !rawPhone.isEmpty else { return nil }
        return phones.first { phone in
            phoneValuesMatch(phone.phoneNumber, rawPhone)
                || phoneValuesMatch(phone.displayPhoneNumber, rawPhone)
                || phoneValuesMatch(phone.qrConnectedPhone, rawPhone)
        }
    }

    private static func digits(_ value: String?) -> String {
        String((value ?? "").filter(\.isNumber))
    }
}

/// Construcción pura del selector para poder verificar que Meta Direct,
/// HighLevel WhatsApp y los remitentes SMS conviven en la misma hoja.
enum ConversationChannelOptionsBuilder {
    static func build(
        whatsAppStatus: WhatsAppAPIStatus?,
        highLevelConnected: Bool,
        highLevelWhatsAppFromNumber: String?,
        highLevelPhoneNumbers: [HighLevelPhoneNumber],
        hasContactPhone: Bool,
        channelEvidence: String
    ) -> [ComposerChannelOption] {
        let whatsAppPhones = whatsAppStatus?.phoneNumbers ?? []
        let evidence = channelEvidence.lowercased()
        var options: [ComposerChannelOption] = []

        if whatsAppPhones.isEmpty {
            options.append(
                ComposerChannelOption(
                    channel: .whatsapp(phoneNumberId: ""),
                    title: "WhatsApp",
                    subtitle: "Mensaje por WhatsApp conectado.",
                    disabledReason: whatsAppStatus?.connected == true
                        ? (hasContactPhone ? nil : "Este contacto no tiene teléfono guardado.")
                        : "Conecta WhatsApp API o QR para responder."
                )
            )
        } else {
            for (index, phone) in whatsAppPhones.enumerated() {
                let label = phone.label?.isEmpty == false ? phone.label! : "Número \(index + 1)"
                let available = phone.availability?.available
                    ?? (phone.apiSendEnabled || phone.isQRConnected)
                var reason: String?
                if !hasContactPhone {
                    reason = "Este contacto no tiene teléfono guardado."
                } else if !available {
                    reason = "Ese número de WhatsApp ya no está disponible."
                } else if (phone.displayPhoneNumber ?? phone.phoneNumber ?? "").isEmpty {
                    reason = "Ese WhatsApp todavía no tiene número detectado."
                }
                options.append(
                    ComposerChannelOption(
                        channel: .whatsapp(phoneNumberId: phone.id),
                        title: "WhatsApp · \(label)",
                        subtitle: phone.displayPhoneNumber ?? phone.phoneNumber ?? phone.verifiedName ?? "",
                        disabledReason: reason
                    )
                )
            }
        }

        if highLevelConnected {
            let highLevelWhatsAppFromNumber = highLevelWhatsAppFromNumber?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let highLevelWhatsAppDisabledReason: String?
            if !hasContactPhone {
                highLevelWhatsAppDisabledReason = "Este contacto no tiene teléfono guardado."
            } else if highLevelWhatsAppFromNumber.isEmpty {
                highLevelWhatsAppDisabledReason = "Este chat no tiene un número de WhatsApp de HighLevel verificado para responder."
            } else {
                highLevelWhatsAppDisabledReason = nil
            }
            options.append(
                ComposerChannelOption(
                    channel: .highLevelWhatsApp(fromNumber: highLevelWhatsAppFromNumber),
                    title: "WhatsApp · HighLevel",
                    subtitle: highLevelWhatsAppFromNumber.isEmpty
                        ? "Recibe primero un WhatsApp de HighLevel para identificar el remitente."
                        : "Responde desde \(highLevelWhatsAppFromNumber).",
                    disabledReason: highLevelWhatsAppDisabledReason
                )
            )

            if highLevelPhoneNumbers.isEmpty {
                options.append(
                    ComposerChannelOption(
                        channel: .sms(fromNumber: ""),
                        title: "SMS · HighLevel",
                        subtitle: "HighLevel elegirá el número configurado en la conversación.",
                        disabledReason: hasContactPhone ? nil : "Este contacto no tiene teléfono guardado."
                    )
                )
            } else {
                for (index, phone) in highLevelPhoneNumbers.enumerated() {
                    options.append(
                        ComposerChannelOption(
                            channel: .sms(fromNumber: phone.phoneNumber),
                            title: "SMS · \(phone.label.isEmpty ? "Número \(index + 1)" : phone.label)",
                            subtitle: phone.phoneNumber,
                            disabledReason: hasContactPhone ? nil : "Este contacto no tiene teléfono guardado."
                        )
                    )
                }
            }
        }

        options.append(
            ComposerChannelOption(
                channel: .messenger,
                title: "Messenger",
                subtitle: "Responde por Facebook Messenger.",
                disabledReason: (evidence.contains("messenger") || evidence.contains("facebook"))
                    ? nil
                    : "Activa Messenger en Configuración > Meta Ads para responder desde Ristak."
            )
        )
        options.append(
            ComposerChannelOption(
                channel: .instagram,
                title: "Instagram DM",
                subtitle: "Responde por Instagram Direct.",
                disabledReason: evidence.contains("instagram")
                    ? nil
                    : "Activa Instagram en Configuración > Meta Ads para responder desde Ristak."
            )
        )
        return options
    }
}
