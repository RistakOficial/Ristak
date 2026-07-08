import SwiftUI

// Viaje de cliente ("Recorrido del contacto") de la ficha de contacto.
// Port fiel de mobile/src/App.tsx (`buildContactInfoDisplayJourney`,
// `getContactInfoJourneyDescription`, `getContactJourneyItems` y helpers) para
// que el iOS muestre los mismos hitos, en el mismo orden (nuevo → viejo) y con
// las mismas descripciones. La lógica es 100 % local sobre el journey COMPLETO
// (sin filtrar) que trae `JourneyService.fetchFullJourney`.

// MARK: - Fase de carga del journey

enum JourneyLoadPhase: Equatable {
    case idle
    case loading
    case loaded
    case failed
}

// MARK: - Ícono de un hito (canal crudo o SF Symbol)

/// Los hitos de canal (WhatsApp / Instagram / Messenger / Meta / Correo) usan el
/// badge de canal CRUDO (sin aro ni contenedor circular — el color social vive
/// solo en el badge, doc 14 §2.4). El resto usa un SF Symbol tonal.
enum ContactJourneyIcon: Equatable, Sendable {
    case channel(RistakChatChannel)
    case symbol(String)
}

/// Rol de color del ícono/acento del hito (paridad `CONTACT_INFO_THEME`).
enum ContactJourneyAccent: Equatable, Sendable {
    case positive // success (verde)
    case accent   // acento de marca
    case muted    // gris atenuado

    var color: Color {
        switch self {
        case .positive: return RistakTheme.pos
        case .accent: return RistakTheme.accent
        case .muted: return RistakTheme.textDim
        }
    }
}

// MARK: - Hito ya listo para pintar

struct ContactJourneyItem: Identifiable, Equatable, Sendable {
    let id: String
    let type: String
    let title: String
    let subtitle: String
    let date: String
    let icon: ContactJourneyIcon
    let accent: ContactJourneyAccent
}

// MARK: - Nodo interno del pipeline (evita depender de `JourneyEvent` de Core)

private struct JourneyNode {
    let type: String
    let date: String
    var data: [String: RistakJSONValue]
}

// MARK: - Constructor (necesita zona horaria + moneda del negocio)

struct ContactJourneyBuilder: Sendable {
    let formatters: BusinessFormatters
    private var timeZone: TimeZone { formatters.timeZone }

    /// Punto de entrada: eventos crudos → hitos ordenados de más nuevo a más
    /// viejo (paridad `getContactJourneyItems`).
    func items(from events: [JourneyEvent]) -> [ContactJourneyItem] {
        let nodes = events.map { JourneyNode(type: $0.type, date: $0.date ?? "", data: $0.data) }
        return buildDisplayJourney(nodes)
            .enumerated()
            .map { index, event in item(from: event, index: index) }
            .sorted { CJL.sortable($0.date) > CJL.sortable($1.date) }
    }

    // MARK: Construcción del journey visible (merge por día + canal)

    private func buildDisplayJourney(_ events: [JourneyNode]) -> [JourneyNode] {
        var dailyEvents: [JourneyNode] = []
        var otherEvents: [JourneyNode] = []
        let firstPaymentTime = CJL.firstSuccessfulPaymentTime(events)

        for event in events {
            guard !event.date.isEmpty else { continue }
            if CJL.isBusinessAuthored(event) { continue }
            if CJL.isDailyContactEvent(event) {
                if CJL.isWhatsApp(event),
                   !CJL.shouldShowWhatsApp(event, firstPaymentTime: firstPaymentTime) {
                    continue
                }
                dailyEvents.append(event)
            } else {
                otherEvents.append(event)
            }
        }

        // Agrupa los eventos diarios por (día · canal) y funde su data.
        var byGroup: [String: [JourneyNode]] = [:]
        for event in dailyEvents {
            let key = groupKey(for: event)
            byGroup[key, default: []].append(event)
        }

        var merged: [JourneyNode] = []
        for dayEvents in byGroup.values {
            let sorted = dayEvents.sorted { CJL.dailyScore($0) > CJL.dailyScore($1) }
            guard let primary = sorted.first else { continue }
            let hasWhatsApp = dayEvents.contains { CJL.isWhatsApp($0) }
            let isWhatsAppAd = dayEvents.contains { CJL.isWhatsApp($0) && CJL.isAdAttributed($0) }

            var mergedData: [String: RistakJSONValue] = [:]
            for event in sorted {
                for (key, value) in event.data {
                    if !CJL.hasMeaningful(mergedData[key]), CJL.hasMeaningful(value) {
                        mergedData[key] = value
                    }
                }
            }
            if hasWhatsApp {
                mergedData["is_ad_attributed"] = .bool(isWhatsAppAd)
            }

            merged.append(JourneyNode(
                type: hasWhatsApp ? "whatsapp_message" : primary.type,
                date: primary.date,
                data: mergedData
            ))
        }

        return (otherEvents + merged).sorted { CJL.sortable($0.date) > CJL.sortable($1.date) }
    }

    private func groupKey(for event: JourneyNode) -> String {
        let dayKey = dayKey(for: event.date)
        if CJL.isWhatsApp(event) {
            return "\(dayKey):whatsapp:\(CJL.isAdAttributed(event) ? "ad" : "direct")"
        }
        if CJL.isMetaMessage(event) {
            return "\(dayKey):meta:\(CJL.metaPlatformKey(event)):\(CJL.metaDailyKind(event))"
        }
        if CJL.hasWebSignal(event) {
            return "\(dayKey):contact:web"
        }
        return "\(dayKey):contact"
    }

    /// Clave de día `YYYY-MM-DD` en la zona horaria del negocio (paridad
    /// `getContactInfoJourneyDayKey`).
    private func dayKey(for date: String) -> String {
        guard let parsed = RistakDateParsing.date(fromISO: date) else { return date }
        return RistakDateParsing.businessDateString(from: parsed, timeZone: timeZone)
    }

    // MARK: Mapeo a `ContactJourneyItem` (paridad `getContactJourneyItems`)

    private func item(from event: JourneyNode, index: Int) -> ContactJourneyItem {
        let data = event.data
        let type = event.type.isEmpty ? "activity" : event.type
        let id = "\(type)-\(event.date)-\(index)"

        switch type {
        case "whatsapp_message":
            return ContactJourneyItem(
                id: id, type: type, title: "WhatsApp",
                subtitle: description(for: event), date: event.date,
                icon: .channel(.whatsapp), accent: .positive
            )
        case "meta_message":
            return ContactJourneyItem(
                id: id, type: type, title: CJL.metaTitle(event),
                subtitle: description(for: event), date: event.date,
                icon: .channel(CJL.metaChannel(event)), accent: .positive
            )
        case "email_message":
            return ContactJourneyItem(
                id: id, type: type, title: "Correo",
                subtitle: description(for: event), date: event.date,
                icon: .channel(.gmail), accent: .accent
            )
        case "payment":
            let amount = CJL.firstNumber([data["amount"], data["total"]]) ?? 0
            let status = CJL.readable(data["status"])
            let title = amount > 0
                ? "Pago \(money(amount, currency: CJL.readable(data["currency"])))"
                : "Pago registrado"
            return ContactJourneyItem(
                id: id, type: type, title: title,
                subtitle: status.isEmpty ? "" : CJL.plainStatus(status), date: event.date,
                icon: .symbol("dollarsign.circle.fill"), accent: .positive
            )
        case "appointment", "appointment_confirmation":
            let status = CJL.firstReadable([data["status"], data["appointment_status"]])
            let subtitle = CJL.joinDetails([
                CJL.firstReadable([data["title"], data["summary"]]),
                status.isEmpty ? nil : CJL.plainStatus(status),
            ])
            return ContactJourneyItem(
                id: id, type: type,
                title: type == "appointment_confirmation" ? "Cita agendada" : "Cita",
                subtitle: subtitle, date: event.date,
                icon: .symbol("calendar"), accent: .accent
            )
        case "contact_created":
            let web = CJL.hasWebSignal(event)
            return ContactJourneyItem(
                id: id, type: type, title: web ? "Contacto" : "Contacto creado",
                subtitle: description(for: event), date: event.date,
                icon: .symbol("person.fill"), accent: .muted
            )
        case "page_visit":
            return ContactJourneyItem(
                id: id, type: type, title: "Visita",
                subtitle: description(for: event), date: event.date,
                icon: .symbol("target"), accent: .muted
            )
        default:
            let title = CJL.readable(data["title"])
            return ContactJourneyItem(
                id: id, type: type, title: title.isEmpty ? "Actividad" : title,
                subtitle: description(for: event), date: event.date,
                icon: .symbol("waveform.path.ecg"), accent: .muted
            )
        }
    }

    // MARK: Descripción (paridad `getContactInfoJourneyDescription`)

    private func description(for event: JourneyNode) -> String {
        let data = event.data

        switch event.type {
        case "page_visit":
            let source = platformLabel(event)
            let pageUrl = CJL.compactPageUrlLabel(CJL.firstReadable([data["page_url"], data["landing_page"], data["referrer_url"]]))
            let pageName = CJL.firstNonEmpty([
                CJL.firstReadable([data["form_site_name"], data["public_page_title"]]),
                pageUrl,
                CJL.pageNameFromUrl(CJL.firstReadable([data["page_url"], data["landing_page"]])),
            ])
            let campaign = CJL.firstReadable([data["campaign_name"], data["utm_campaign"]])
            let eventName = CJL.readable(data["event_name"]).lowercased()
            return CJL.firstNonEmpty([
                CJL.joinDetails([
                    eventName.contains("form") ? "Formulario enviado" : source,
                    pageName,
                    campaign.isEmpty ? nil : "Campaña \(campaign)",
                ]),
                "Visita registrada",
            ]) ?? "Visita registrada"

        case "contact_created":
            if CJL.hasWebSignal(event) {
                let source = CJL.firstNonEmpty([platformLabel(event), "Sitio web"]) ?? "Sitio web"
                let pageUrl = CJL.compactPageUrlLabel(CJL.firstReadable([data["page_url"], data["landing_page"], data["referrer_url"]]))
                let pageName = CJL.firstNonEmpty([
                    CJL.firstReadable([data["form_site_name"], data["public_page_title"]]),
                    pageUrl,
                    CJL.pageNameFromUrl(CJL.firstReadable([data["page_url"], data["landing_page"]])),
                ])
                let campaign = CJL.firstReadable([data["campaign_name"], data["utm_campaign"]])
                return CJL.firstNonEmpty([
                    CJL.joinDetails([source, pageName, campaign.isEmpty ? nil : "Campaña \(campaign)"]),
                    "Sitio web",
                ]) ?? "Sitio web"
            }
            let source = CJL.firstNonEmpty([CJL.readable(data["source"]), "Contacto guardado en Ristak"]) ?? "Contacto guardado en Ristak"
            let campaign = CJL.readable(data["campaign_name"])
            let adName = CJL.firstReadable([data["attribution_ad_name"], data["meta_ad_name"]])
            return CJL.joinDetails([source, campaign.isEmpty ? adName : campaign])

        case "whatsapp_message":
            let platform = CJL.firstNonEmpty([
                platformLabel(event),
                CJL.isTruthyFlag(data["is_ad_attributed"]) ? "Meta Ads" : "WhatsApp",
            ]) ?? "WhatsApp"
            let campaign = CJL.readable(data["campaign_name"])
            let adName = CJL.firstReadable([data["attribution_ad_name"], data["ad_name"]])
            if CJL.isTruthyFlag(data["is_ad_attributed"]) {
                return CJL.joinDetails([
                    "Anuncio \(platform)",
                    campaign.isEmpty ? nil : "Campaña \(campaign)",
                    campaign.isEmpty && !adName.isEmpty ? adName : nil,
                ])
            }
            let mediaLabel = CJL.messageTypeLabel(CJL.readable(data["message_type"]), fallback: "")
            return (!mediaLabel.isEmpty && mediaLabel != "Mensaje") ? "\(mediaLabel) por WhatsApp" : ""

        case "meta_message":
            let sender = CJL.firstReadable([data["profile_name"], data["username"]])
            let mediaLabel = CJL.messageTypeLabel(CJL.readable(data["message_type"]), fallback: "")
            return CJL.joinDetails([
                CJL.metaSurfaceLabel(event),
                sender,
                (!mediaLabel.isEmpty && mediaLabel != "Mensaje") ? mediaLabel : nil,
            ])

        case "email_message":
            return CJL.firstNonEmpty([CJL.readable(data["subject"]), "Correo recibido"]) ?? "Correo recibido"

        default:
            let summary = CJL.firstReadable([data["summary"], data["description"], data["title"]])
            return summary.isEmpty
                ? ContactInfoDates.dateTime(fromISO: event.date, timeZone: timeZone)
                : summary
        }
    }

    /// `getJourneyPlatformLabel`.
    private func platformLabel(_ event: JourneyNode) -> String {
        let data = event.data
        if CJL.hasWebSignal(event) {
            let webSource = CJL.sourceLabel(from: data)
            if !webSource.isEmpty { return webSource }
        }
        if event.type == "meta_message" {
            return CJL.firstNonEmpty([CJL.readable(data["source"]), CJL.metaTitle(event)]) ?? CJL.metaTitle(event)
        }
        let platform = CJL.readable(data["ad_platform"])
        if !platform.isEmpty { return platform }
        return CJL.sourceLabel(from: data)
    }

    /// `formatContactMoney`: respeta la moneda del registro; si no trae, usa la
    /// de la cuenta.
    private func money(_ amount: Double, currency: String) -> String {
        formatters.currency(amount, currencyOverride: currency.isEmpty ? nil : currency)
    }
}

// MARK: - Lógica pura (paridad exacta con los helpers de mobile/)

private enum CJL {
    // Constantes
    static let outboundDirections: Set<String> = [
        "outbound", "outgoing", "sent", "business", "api", "app",
        "business_echo", "smb_echo", "echo", "message_echo",
    ]
    static let messageEventTypes: Set<String> = ["whatsapp_message", "meta_message", "email_message"]
    static let genericSources: Set<String> = ["directo", "desconocido", "otro"]
    static let successPaymentStatuses: Set<String> = [
        "paid", "partial", "succeeded", "completed", "complete", "fulfilled", "success",
    ]
    static let metaCommentTypes: Set<String> = ["comment", "comment_reply_public", "comment_reply_private"]

    static let webSourcePattern = "(ristak_site|native_site|site|website|web|form|landing|pagina|página)"
    static let whatsappSourcePattern = "(whatsapp|waapi|ycloud|click_to_whatsapp|ctwa)"
    static let instagramPattern = "(instagram|ig)"
    static let messengerPattern = "(messenger|facebook|fb)"

    // MARK: Valores

    static func readable(_ value: RistakJSONValue?) -> String {
        guard let value else { return "" }
        switch value {
        case .null:
            return ""
        case .string(let s):
            return s.trimmingCharacters(in: .whitespacesAndNewlines)
        case .number(let n):
            return numberString(n)
        case .bool(let b):
            return b ? "true" : "false"
        case .array(let items):
            return items.map { readable($0) }.filter { !$0.isEmpty }.joined(separator: ", ")
        case .object(let dict):
            for key in ["name", "label", "title", "value"] {
                guard let nested = dict[key] else { continue }
                switch nested {
                case .string(let s):
                    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { return t }
                case .number(let n):
                    return numberString(n)
                case .bool(let b):
                    return b ? "true" : "false"
                default:
                    continue
                }
            }
            return ""
        }
    }

    static func numberString(_ n: Double) -> String {
        if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        return String(n)
    }

    static func firstReadable(_ candidates: [RistakJSONValue?]) -> String {
        for candidate in candidates {
            let value = readable(candidate)
            if !value.isEmpty { return value }
        }
        return ""
    }

    static func firstNonEmpty(_ candidates: [String?]) -> String? {
        for candidate in candidates {
            if let candidate, !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return candidate
            }
        }
        return nil
    }

    static func firstNumber(_ candidates: [RistakJSONValue?]) -> Double? {
        for candidate in candidates where truthy(candidate) {
            if let value = candidate?.doubleValue { return value }
        }
        return nil
    }

    static func truthy(_ value: RistakJSONValue?) -> Bool {
        switch value {
        case .none, .some(.null): return false
        case .some(.string(let s)): return !s.isEmpty
        case .some(.number(let n)): return n != 0
        case .some(.bool(let b)): return b
        case .some(.object), .some(.array): return true
        }
    }

    static func hasMeaningful(_ value: RistakJSONValue?) -> Bool {
        switch value {
        case .none, .some(.null):
            return false
        case .some(.string(let s)):
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return !t.isEmpty && !["null", "undefined", "nan"].contains(t)
        default:
            return true
        }
    }

    static func isTruthyFlag(_ value: RistakJSONValue?) -> Bool {
        switch value {
        case .some(.bool(let b)):
            return b
        case .some(.number(let n)):
            return n != 0
        default:
            let normalized = normalizeProbe(readable(value))
            return !normalized.isEmpty && !["false", "0", "no", "null", "undefined"].contains(normalized)
        }
    }

    static func normalizeProbe(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "[\\s-]+", with: "_", options: .regularExpression)
    }

    static func matches(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    // MARK: Direcciones / autoría

    static func isOutboundDirection(_ value: String) -> Bool {
        outboundDirections.contains(normalizeProbe(value))
    }

    static func isOutbound(_ event: JourneyNode) -> Bool {
        isOutboundDirection(firstReadable([
            event.data["direction"], event.data["message_direction"], event.data["from_type"],
        ]))
    }

    static func isBusinessAuthored(_ event: JourneyNode) -> Bool {
        messageEventTypes.contains(event.type) && isOutbound(event)
    }

    // MARK: Origen / web

    static func isGenericSource(_ source: String) -> Bool {
        genericSources.contains(source.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    static func sourceLooksWhatsApp(_ source: String) -> Bool {
        matches(whatsappSourcePattern, source.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    static func sourceLabel(from data: [String: RistakJSONValue]) -> String {
        let explicit = readable(data["conversion_source"])
        if !explicit.isEmpty, !isGenericSource(explicit) { return explicit }

        let candidates: [RistakJSONValue?] = [
            data["source_platform"], data["ad_platform"], data["site_source_name"],
            data["referral_source_app"], data["utm_source"], data["referral_source_type"],
            data["referral_entry_point"], data["source"],
        ]
        for candidate in candidates {
            let source = readable(candidate)
            if !source.isEmpty, !isGenericSource(source) { return source }
        }

        let referrer = firstReadable([data["referrer_url"], data["referral_source_url"], data["source_url"]])
        if matches(webSourcePattern, referrer) {
            return firstNonEmpty([pageNameFromUrl(referrer), referrer]) ?? ""
        }
        return ""
    }

    static func hasWebSignal(_ event: JourneyNode) -> Bool {
        if event.type == "page_visit" { return true }
        if event.type != "contact_created" { return false }

        let data = event.data
        let conversionChannel = readable(data["conversion_channel"]).lowercased()
        let eventName = readable(data["event_name"]).lowercased()
        let conversionType = readable(data["conversion_type"]).lowercased()
        let source = readable(data["source"]).lowercased()
        let sourceLabel = sourceLabel(from: data)

        if conversionChannel == "web" { return true }
        if truthy(data["submission_id"]) || truthy(data["form_site_id"]) || truthy(data["form_site_name"]) { return true }
        if readable(data["tracking_source"]).lowercased() == "native_site" || truthy(data["site_id"]) || truthy(data["public_page_id"]) { return true }
        if eventName.contains("form") || eventName.contains("conversion") { return true }
        if conversionType.contains("form") || conversionType.contains("conversion") { return true }
        if matches(webSourcePattern, source) { return true }

        return !sourceLabel.isEmpty && !sourceLooksWhatsApp(sourceLabel)
    }

    static func isWhatsApp(_ event: JourneyNode) -> Bool {
        let data = event.data
        let conversionChannel = readable(data["conversion_channel"]).lowercased()

        if event.type == "whatsapp_message" { return !isOutbound(event) }
        if event.type != "contact_created" { return false }
        if hasWebSignal(event) { return false }
        if conversionChannel == "web" { return false }
        if conversionChannel == "whatsapp" { return true }

        let source = firstReadable([data["source"], data["referral_source_app"], data["referral_entry_point"]]).lowercased()
        return source.contains("whatsapp")
    }

    // MARK: Meta

    static func metaPlatformText(_ event: JourneyNode) -> String {
        [event.data["source"], event.data["social_platform"], event.data["transport"], event.data["channel"]]
            .map { readable($0) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    static func metaPlatformKey(_ event: JourneyNode) -> String {
        let text = metaPlatformText(event)
        if matches(instagramPattern, text) { return "instagram" }
        if matches(messengerPattern, text) { return "messenger" }
        return "meta"
    }

    static func metaTitle(_ event: JourneyNode) -> String {
        switch metaPlatformKey(event) {
        case "instagram": return "Instagram"
        case "messenger": return "Messenger"
        default: return "Meta"
        }
    }

    static func metaChannel(_ event: JourneyNode) -> RistakChatChannel {
        switch metaPlatformKey(event) {
        case "instagram": return .instagram
        case "messenger": return .messenger
        default: return .facebook
        }
    }

    static func isMetaMessage(_ event: JourneyNode) -> Bool {
        event.type == "meta_message" && !isOutbound(event)
    }

    static func metaType(_ event: JourneyNode) -> String {
        readable(event.data["message_type"]).lowercased()
    }

    static func isMetaComment(_ event: JourneyNode) -> Bool {
        truthy(event.data["comment_id"]) || metaCommentTypes.contains(metaType(event))
    }

    static func metaDailyKind(_ event: JourneyNode) -> String {
        isMetaComment(event) ? "comment" : "message"
    }

    static func metaSurfaceLabel(_ event: JourneyNode) -> String {
        if isMetaComment(event) {
            switch metaPlatformKey(event) {
            case "instagram": return "Comentario de Instagram"
            case "messenger": return "Comentario de Messenger"
            default: return "Comentario social"
            }
        }
        let source = readable(event.data["source"])
        if !source.isEmpty { return source }
        let title = metaTitle(event)
        return title == "Meta" ? "Mensaje social" : "Mensaje privado de \(title)"
    }

    // MARK: Clasificación diaria / atribución

    static func isDailyContactEvent(_ event: JourneyNode) -> Bool {
        event.type == "contact_created" || isWhatsApp(event) || isMetaMessage(event)
    }

    static func isAdAttributed(_ event: JourneyNode) -> Bool {
        if event.type == "whatsapp_message", isOutbound(event) { return false }
        let data = event.data
        return isTruthyFlag(data["is_ad_attributed"])
            || hasMeaningful(data["attribution_ad_id"])
            || hasMeaningful(data["referral_source_id"])
            || hasMeaningful(data["referral_ctwa_clid"])
    }

    // MARK: Tiempos / pagos

    static func sortable(_ value: String) -> Double {
        RistakDateParsing.date(fromISO: value)?.timeIntervalSince1970 ?? 0
    }

    static func eventTime(_ event: JourneyNode) -> Double? {
        let time = sortable(event.date)
        return time > 0 ? time : nil
    }

    static func firstSuccessfulPaymentTime(_ events: [JourneyNode]) -> Double? {
        events
            .filter { $0.type == "payment" }
            .filter { event in
                let status = normalizeProbe(readable(event.data["status"]))
                let amount = firstNumber([event.data["amount"], event.data["total"], event.data["value"]]) ?? 0
                return amount > 0 && (status.isEmpty || successPaymentStatuses.contains(status))
            }
            .compactMap { eventTime($0) }
            .sorted()
            .first
    }

    static func shouldShowWhatsApp(_ event: JourneyNode, firstPaymentTime: Double?) -> Bool {
        guard let firstPaymentTime else { return true }
        guard let time = eventTime(event) else { return true }
        if time < firstPaymentTime { return true }
        return isAdAttributed(event)
    }

    // MARK: Puntuación (para elegir el evento primario de cada grupo)

    static func whatsAppScore(_ event: JourneyNode) -> Int {
        let fields = [
            "campaign_name", "adset_name", "attribution_ad_name", "attribution_ad_id",
            "ad_platform", "referral_source_url", "referral_source_type", "referral_source_id",
            "referral_ctwa_clid", "referral_headline", "referral_body", "message_text",
        ]
        let completeness = fields.reduce(0) { $0 + (hasMeaningful(event.data[$1]) ? 1 : 0) }
        return (isAdAttributed(event) ? 1000 : 0) + (event.type == "whatsapp_message" ? 10 : 0) + completeness
    }

    static func metaScore(_ event: JourneyNode) -> Int {
        let fields = [
            "message_text", "message_type", "profile_name", "username", "media_url",
            "postback_payload", "comment_id", "post_message", "post_permalink", "post_image_url",
            "post_type", "media_id", "parent_comment_id", "permalink", "meta_message_id",
            "meta_social_message_id", "status",
        ]
        let completeness = fields.reduce(0) { $0 + (hasMeaningful(event.data[$1]) ? 1 : 0) }
        return 10 + completeness
    }

    static func dailyScore(_ event: JourneyNode) -> Int {
        isMetaMessage(event) ? metaScore(event) : whatsAppScore(event)
    }

    // MARK: Texto

    static func joinDetails(_ parts: [String?]) -> String {
        parts
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    static func messageTypeLabel(_ type: String, fallback: String) -> String {
        let normalized = normalizeProbe(type)
        if normalized.isEmpty { return fallback }
        if normalized.contains("image") || normalized.contains("photo") { return "Foto" }
        if normalized.contains("video") { return "Video" }
        if normalized.contains("audio") || normalized.contains("voice") { return "Audio" }
        if normalized.contains("document") || normalized.contains("file") { return "Documento" }
        if normalized.contains("location") { return "📍 Ubicación" }
        if normalized.contains("comment") { return "Comentario" }
        return fallback
    }

    static func plainStatus(_ value: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty { return "Confirmado" }
        switch normalized.lowercased() {
        case "paid": return "Pagado"
        case "confirmed": return "Confirmado"
        case "cancelled", "canceled": return "Cancelado"
        case "pending": return "Pendiente"
        case "completed": return "Completado"
        default:
            return normalized
                .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
                .split(separator: " ")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    static func pageNameFromUrl(_ pageUrl: String) -> String {
        guard !pageUrl.isEmpty else { return "" }
        if let url = URL(string: pageUrl), let host = url.host {
            let segments = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
            return segments.last ?? host
        }
        let base = pageUrl.split(separator: "?").first.map(String.init) ?? pageUrl
        let segments = base.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        return segments.last ?? pageUrl
    }

    static func compactPageUrlLabel(_ pageUrl: String) -> String {
        let raw = pageUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "" }
        if let url = URL(string: raw), let host = url.host {
            var path = url.path
            while path.hasSuffix("/") { path.removeLast() }
            return (path.isEmpty || path == "/") ? host : host + path
        }
        var stripped = raw.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
        stripped = stripped.split(separator: "?").first.map(String.init) ?? stripped
        while stripped.hasSuffix("/") { stripped.removeLast() }
        return stripped
    }
}

// MARK: - Fila resumen "Viaje de cliente" (dentro de "Origen y conversión")

/// Fila de acceso al panel del viaje (paridad `ContactInfoSummaryRow`): ícono
/// tonal + título + subtítulo + "Ver ›".
struct ContactJourneySummaryRow: View {
    let phase: JourneyLoadPhase
    let count: Int
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: RistakTheme.Spacing.sm) {
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(RistakTheme.accentSoft)
                    .frame(width: 44, height: 44)
                    .overlay(
                        Image(systemName: "cursorarrow.click")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(RistakTheme.accent)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Viaje de cliente")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                HStack(spacing: 2) {
                    Text("Ver")
                        .font(.subheadline.weight(.semibold))
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(RistakTheme.accent)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ver viaje de cliente")
    }

    private var subtitle: String {
        switch phase {
        case .loading:
            return "Cargando actividad…"
        case .failed:
            return "Toca para reintentar"
        case .idle, .loaded:
            return "\(count) eventos · De más nuevo a más viejo"
        }
    }
}

// MARK: - Panel "Viaje de cliente" (sheet)

struct ContactJourneyPanel: View {
    let phase: JourneyLoadPhase
    let items: [ContactJourneyItem]
    let timeZone: TimeZone
    let onRetry: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .loading where items.isEmpty:
                    RistakLoadingView(message: "Cargando actividad…")
                case .failed where items.isEmpty:
                    RistakErrorState(message: "No se pudo cargar la actividad del contacto.") {
                        onRetry()
                    }
                default:
                    if items.isEmpty {
                        emptyState
                    } else {
                        timeline
                    }
                }
            }
            .background(RistakTheme.bgGrouped)
            .navigationTitle("Viaje de cliente")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
    }

    private var timeline: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().overlay(RistakTheme.border)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        ContactJourneyTimelineRow(
                            item: item,
                            timeZone: timeZone,
                            isFirst: index == 0,
                            isLast: index == items.count - 1
                        )
                    }
                }
                .padding(.horizontal, RistakTheme.Spacing.md)
                .padding(.top, RistakTheme.Spacing.md)
                .padding(.bottom, RistakTheme.Spacing.xs)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                    .fill(RistakTheme.surface)
            )
            .padding(RistakTheme.Spacing.md)
        }
    }

    private var header: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.accentSoft)
                .frame(width: 40, height: 40)
                .overlay(
                    Image(systemName: "cursorarrow.click")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(RistakTheme.accent)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text("Recorrido del contacto")
                    .font(.headline)
                    .foregroundStyle(RistakTheme.textPrimary)
                Text("\(items.count) \(items.count == 1 ? "evento" : "eventos") · De más nuevo a más viejo")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            }

            Spacer(minLength: 0)
        }
        .padding(RistakTheme.Spacing.md)
    }

    private var emptyState: some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.accentSoft)
                .frame(width: 58, height: 58)
                .overlay(
                    Image(systemName: "cursorarrow.click")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(RistakTheme.accent)
                )
            Text("Sin actividad todavía")
                .font(.headline)
                .foregroundStyle(RistakTheme.textPrimary)
            Text("Aún no hay hitos guardados para este contacto.")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(RistakTheme.Spacing.xl)
    }
}

// MARK: - Fila de la línea de tiempo

struct ContactJourneyTimelineRow: View {
    let item: ContactJourneyItem
    let timeZone: TimeZone
    let isFirst: Bool
    let isLast: Bool

    private let iconSize: CGFloat = 34

    var body: some View {
        HStack(alignment: .top, spacing: RistakTheme.Spacing.sm) {
            rail
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                }
                Text(ContactInfoDates.dateTime(fromISO: item.date, timeZone: timeZone))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(RistakTheme.textMute)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, RistakTheme.Spacing.lg)
        }
    }

    /// Riel: línea conectora continua detrás + ícono arriba (con hueco superior
    /// en el primero y sin cola en el último).
    private var rail: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : RistakTheme.border)
                    .frame(width: 1, height: iconSize / 2)
                Rectangle()
                    .fill(isLast ? Color.clear : RistakTheme.border)
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)
            }
            icon
        }
        .frame(width: iconSize)
    }

    @ViewBuilder
    private var icon: some View {
        switch item.icon {
        case .channel(let channel):
            // Badge de canal CRUDO: sin aro ni contenedor (color social solo aquí).
            ChannelBadgeView(channel: channel, size: iconSize - 4)
                .frame(width: iconSize, height: iconSize)
        case .symbol(let name):
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.accentSoft)
                .frame(width: iconSize, height: iconSize)
                .overlay(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .stroke(RistakTheme.border, lineWidth: 0.5)
                )
                .overlay(
                    Image(systemName: name)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(item.accent.color)
                )
        }
    }
}
