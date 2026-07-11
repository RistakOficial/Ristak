import Foundation
import SwiftUI
import UIKit

// Soporte del hilo de conversación (docs research/04 §6-§7):
// items del timeline, markers de actividad, contexto de comentarios FB/IG,
// chip de transporte y texto con formato WhatsApp.

// MARK: - Cierre del teclado (paridad mobile/ `Keyboard.dismiss`)

/// Cierra el teclado renunciando al primer respondedor activo. Se usa al tocar
/// fuera del composer para que el teclado no quede atrapado (regresión
/// reportada: "el teclado no se puede cerrar si tocamos fuera de él").
enum KeyboardDismisser {
    @MainActor
    static func dismiss() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }
}

// MARK: - Marker de actividad (pagos/citas del journey completo)

/// Hito centrado del timeline ("Pago completado", "Cita agendada", …).
struct ConversationActivityMarker: Identifiable, Equatable, Sendable {
    enum Kind: String, Sendable {
        case payment
        case appointment
        case appointmentConfirmation
    }

    let id: String
    let kind: Kind
    let title: String
    let subtitle: String
    let amountLabel: String?
    /// Timestamp crudo del evento (clave de orden).
    let date: String

    var parsedDate: Date? { RistakDateParsing.date(fromISO: date) }

    var systemImage: String {
        switch kind {
        case .payment: return "dollarsign.circle"
        case .appointment, .appointmentConfirmation: return "calendar"
        }
    }
}

/// Contexto de la publicación comentada (FB/IG) — se extrae de los eventos
/// crudos porque `ChatMessage` no lo modela (paridad /movil, doc 04 §7.7).
struct CommentPostContext: Equatable, Sendable {
    let postMessage: String?
    let postImageUrl: String?
    let postPermalink: String?
    let postDeleted: Bool
    let commentId: String?
    let postId: String?
}

// MARK: - Item del timeline

/// Item tipado de la lista de conversación (RN `ConversationListItem`).
enum ConversationTimelineItem: Identifiable, Equatable {
    case day(id: String, label: String)
    case activity(ConversationActivityMarker)
    case message(ChatMessage)

    var id: String {
        switch self {
        case .day(let id, _): return id
        case .activity(let marker): return "activity-\(marker.id)"
        case .message(let message): return message.id
        }
    }
}

/// Grupo de un día del hilo: el separador (etiqueta) como cabecera y sus filas
/// (mensajes + markers, sin el item `.day`). Alimenta las `Section` del
/// `LazyVStack(pinnedViews: [.sectionHeaders])` para lograr la fecha flotante
/// pegajosa de /movil (`.messageDaySeparator { position: sticky; top: 8px }`).
struct ConversationDayGroup: Identifiable, Equatable {
    /// Estable: `day-<clave>` (o `day-none` para el grupo sin fecha).
    let id: String
    /// Etiqueta del separador ("Hoy", "Ayer", "10 jul"); vacía = sin cabecera.
    let label: String
    /// Filas del día en orden ascendente (nunca contiene `.day`).
    var items: [ConversationTimelineItem]
}

/// Construcción del timeline (doc 04 §6): mensajes + markers ordenados asc,
/// con separadores de día en la zona horaria del NEGOCIO. Con búsqueda activa
/// los markers se ocultan y los separadores se recalculan sobre lo filtrado.
enum ConversationTimelineBuilder {
    /// Reagrupa el timeline plano en días para la lista con cabeceras pegajosas.
    /// Conserva ids e items estables (memoria del proyecto: merges
    /// identity-preserving, sin scroll-jumps). Las filas previas al primer
    /// separador (fechas inválidas) caen en un grupo sin etiqueta.
    static func groupByDay(_ timeline: [ConversationTimelineItem]) -> [ConversationDayGroup] {
        var groups: [ConversationDayGroup] = []
        for item in timeline {
            switch item {
            case .day(let id, let label):
                groups.append(ConversationDayGroup(id: id, label: label, items: []))
            case .activity, .message:
                if groups.isEmpty {
                    groups.append(ConversationDayGroup(id: "day-none", label: "", items: []))
                }
                groups[groups.count - 1].items.append(item)
            }
        }
        return groups
    }

    static func build(
        messages: [ChatMessage],
        markers: [ConversationActivityMarker],
        formatters: BusinessFormatters,
        searchQuery: String = ""
    ) -> [ConversationTimelineItem] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let visibleMessages: [ChatMessage]
        let visibleMarkers: [ConversationActivityMarker]
        if query.isEmpty {
            visibleMessages = messages
            visibleMarkers = markers
        } else {
            visibleMessages = messages.filter { message in
                let haystack = [
                    message.text,
                    message.attachment?.name ?? "",
                    message.channel,
                    message.transport ?? "",
                    message.status ?? "",
                ].joined(separator: " ").lowercased()
                return haystack.contains(query)
            }
            visibleMarkers = []
        }

        enum Entry {
            case marker(ConversationActivityMarker)
            case message(ChatMessage)

            var date: Date? {
                switch self {
                case .marker(let marker): return marker.parsedDate
                case .message(let message): return message.parsedDate
                }
            }

            var rawDate: String {
                switch self {
                case .marker(let marker): return marker.date
                case .message(let message): return message.date
                }
            }
        }

        var entries: [Entry] = visibleMessages.map { .message($0) }
        entries.append(contentsOf: visibleMarkers.map { .marker($0) })
        entries.sort { left, right in
            (left.date ?? Date(timeIntervalSince1970: 0)) < (right.date ?? Date(timeIntervalSince1970: 0))
        }

        var items: [ConversationTimelineItem] = []
        items.reserveCapacity(entries.count + 12)
        var lastDayKey: String?
        for entry in entries {
            let dayKey = formatters.conversationDayKey(fromISO: entry.rawDate)
            if dayKey != lastDayKey {
                lastDayKey = dayKey
                // Fechas inválidas → grupo sin etiqueta (paridad /movil).
                let label = dayKey == "sin-fecha" ? "" : formatters.daySeparatorLabel(fromISO: entry.rawDate)
                if !label.isEmpty {
                    items.append(.day(id: "day-\(dayKey)", label: label))
                }
            }
            switch entry {
            case .marker(let marker): items.append(.activity(marker))
            case .message(let message): items.append(.message(message))
            }
        }
        return items
    }

    /// Markers desde el journey completo (doc 04 §6.3). `payment` solo
    /// exitosos con monto > 0; `appointment`/`appointment_confirmation`.
    static func buildMarkers(
        from events: [JourneyEvent],
        formatters: BusinessFormatters
    ) -> [ConversationActivityMarker] {
        let successfulPaymentStatuses: Set<String> = ["succeeded", "paid", "completed", "complete", "fulfilled", "success"]
        var markers: [ConversationActivityMarker] = []

        for event in events {
            guard let date = event.date, !date.isEmpty else { continue }
            let data = event.data
            switch event.type {
            case "payment":
                let status = ChatJourneyParser.readString(data, ["status"]).lowercased()
                let amount = ChatJourneyParser.readNumber(data, ["amount"]) ?? 0
                guard amount > 0, successfulPaymentStatuses.contains(status) else { continue }
                let concept = ChatJourneyParser.readString(data, ["title", "description", "concept", "type"])
                let currency = ChatJourneyParser.nonEmpty(ChatJourneyParser.readString(data, ["currency"]))
                let id = ChatJourneyParser.readStringOrNumber(data, ["id", "payment_id", "paymentId"])
                    ?? "payment-\(date)-\(ChatJourneyParser.djb2Base36("\(amount)|\(concept)"))"
                markers.append(
                    ConversationActivityMarker(
                        id: id,
                        kind: .payment,
                        title: "Pago completado",
                        subtitle: concept.isEmpty ? "Cobro registrado" : concept,
                        amountLabel: formatters.currency(amount, currencyOverride: currency),
                        date: date
                    )
                )

            case "appointment", "appointment_confirmation":
                let title = ChatJourneyParser.readString(data, ["title"])
                let start = ChatJourneyParser.readString(data, ["start_time", "startTime"])
                var pieces: [String] = []
                if !title.isEmpty { pieces.append(title) }
                if let startDate = RistakDateParsing.date(fromISO: start) {
                    pieces.append(formatters.daySeparatorLabel(startDate))
                    pieces.append(formatters.messageTime(startDate))
                }
                let isConfirmation = event.type == "appointment_confirmation"
                let id = ChatJourneyParser.readStringOrNumber(data, ["id", "appointment_id", "appointmentId"])
                    ?? "\(event.type)-\(date)-\(ChatJourneyParser.djb2Base36(title))"
                markers.append(
                    ConversationActivityMarker(
                        id: "\(event.type)-\(id)",
                        kind: isConfirmation ? .appointmentConfirmation : .appointment,
                        title: isConfirmation ? "Cita confirmada" : "Cita agendada",
                        subtitle: pieces.joined(separator: " · "),
                        amountLabel: nil,
                        date: date
                    )
                )

            default:
                continue
            }
        }
        return markers
    }

    /// Contexto de publicación comentada por id de mensaje (doc 04 §2.3/§7.7).
    static func buildCommentContexts(from events: [JourneyEvent]) -> [String: CommentPostContext] {
        var contexts: [String: CommentPostContext] = [:]
        for event in events where event.type == "meta_message" {
            let data = event.data
            let messageType = ChatJourneyParser.readString(data, ["message_type", "messageType", "type"])
            guard ChatJourneyParser.isCommentMessageType(messageType) else { continue }
            guard let id = ChatJourneyParser.nonEmpty(
                ChatJourneyParser.readString(data, ["meta_social_message_id", "meta_message_id"])
            ) else { continue }
            let postDeleted = ChatJourneyParser.readBool(data["post_deleted"])
                || ChatJourneyParser.readString(data, ["post_type"]).lowercased() == "deleted"
            contexts[id] = CommentPostContext(
                postMessage: ChatJourneyParser.nonEmpty(ChatJourneyParser.readString(data, ["post_message"])),
                postImageUrl: ChatJourneyParser.nonEmpty(ChatJourneyParser.readString(data, ["post_image_url"])),
                postPermalink: ChatJourneyParser.nonEmpty(ChatJourneyParser.readString(data, ["post_permalink", "permalink"])),
                postDeleted: postDeleted,
                commentId: ChatJourneyParser.nonEmpty(ChatJourneyParser.readString(data, ["comment_id"])),
                postId: ChatJourneyParser.nonEmpty(ChatJourneyParser.readString(data, ["post_id"]))
            )
        }
        return contexts
    }
}

// MARK: - Separador de día flotante (cabecera pegajosa)

/// Píldora de fecha que se queda pegada arriba del hilo mientras te desplazas
/// dentro de ese día y la empuja la del día siguiente (paridad /movil
/// `.messageDaySeparator { position: sticky; top: 8px }` con `backdrop-filter`).
///
/// Se usa como `header` de cada `Section` en un
/// `LazyVStack(pinnedViews: [.sectionHeaders])`. Flota centrada sobre el
/// wallpaper, translúcida y sutil.
struct StickyDaySeparator: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption.weight(.bold))
            .foregroundStyle(RistakTheme.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background {
                Capsule(style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(RistakTheme.border.opacity(0.5), lineWidth: 0.5)
                    )
            }
            .frame(maxWidth: .infinity)
            // 8 pt de aire arriba = inset de la píldora cuando queda pegada
            // (paridad `top: 8px`); 12 pt abajo la separan del primer mensaje.
            .padding(.top, 8)
            .padding(.bottom, 12)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Chip de transporte

/// Micro-etiqueta del canal en la fila meta (RN `getNativeMessageTransportBadge`).
enum MessageTransportBadge {
    static func label(for message: ChatMessage) -> String? {
        let probe = "\(message.transport ?? "") \(message.channel)".lowercased()
        guard !probe.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        if probe.contains("qr") || probe.contains("baileys") || probe.contains("web") { return "QR" }
        if probe.contains("instagram") || probe.contains("ig") { return "IG" }
        if probe.contains("messenger") || probe.contains("facebook") || probe.contains("fb") { return "FB" }
        if probe.contains("mail") || probe.contains("email") { return "EMAIL" }
        if probe.contains("sms") { return "SMS" }
        if probe.contains("whatsapp") || probe.contains("api") || probe.contains("native") { return "API" }
        return nil
    }
}

// MARK: - Preview de mensaje (menú Copiar / barra de respuesta)

enum MessagePreviewText {
    /// `getMessagePreviewText` de RN: texto, etiqueta del adjunto, ubicación
    /// o "Mensaje".
    static func preview(for message: ChatMessage) -> String {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        if let attachment = message.attachment {
            switch attachment.type {
            case .image: return "Foto"
            case .video: return "Video"
            case .audio: return "Audio"
            case .document, .file: return attachment.name ?? "Documento"
            }
        }
        if message.location != nil { return "📍 Ubicación" }
        return "Mensaje"
    }
}

// MARK: - Texto con formato WhatsApp

/// Parser compartido con la sintaxis que Ristak pinta en escritorio: conserva el
/// texto original en datos/copiar, pero al renderizar elimina los delimitadores
/// válidos de WhatsApp. Los delimitadores incompletos o identificadores como
/// `folio_123` se respetan literalmente.
enum WhatsAppTextFormatter {
    struct Style: OptionSet, Equatable {
        let rawValue: Int

        static let bold = Style(rawValue: 1 << 0)
        static let italic = Style(rawValue: 1 << 1)
        static let strike = Style(rawValue: 1 << 2)
        static let inlineCode = Style(rawValue: 1 << 3)
        static let monospace = Style(rawValue: 1 << 4)
    }

    struct InlineSegment: Equatable {
        let text: String
        let styles: Style
    }

    enum LineKind: Equatable {
        case paragraph
        case bullet
        case numbered(String)
        case quote
    }

    struct ParsedLine: Equatable {
        let kind: LineKind
        let segments: [InlineSegment]
    }

    struct RenderedLine {
        let kind: LineKind
        let text: AttributedString
    }

    private struct Rule {
        let style: Style
        let delimiter: [Character]
        let literal: Bool
    }

    private static let rules: [Rule] = [
        .init(style: .monospace, delimiter: Array("```"), literal: true),
        .init(style: .inlineCode, delimiter: Array("`"), literal: true),
        .init(style: .bold, delimiter: Array("*"), literal: false),
        .init(style: .italic, delimiter: Array("_"), literal: false),
        .init(style: .strike, delimiter: Array("~"), literal: false)
    ]

    private static let boundaryCharacters = Set(" \t\n()[]{}\"'“”‘’.,;:!?¿¡/\\|<>=+-")

    /// Interpreta párrafos, listas, citas y estilos inline. Es interno a la
    /// app, pero testeable para mantener la misma semántica que escritorio.
    static func parsedLines(_ source: String) -> [ParsedLine] {
        let normalized = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        return normalized.split(separator: "\n", omittingEmptySubsequences: false).map { raw in
            let line = String(raw)

            if let body = listBody(in: line, marker: "-") ?? listBody(in: line, marker: "*") {
                return ParsedLine(kind: .bullet, segments: parseInline(body))
            }
            if let numbered = numberedList(in: line) {
                return ParsedLine(kind: .numbered(numbered.marker), segments: parseInline(numbered.body))
            }
            if line.hasPrefix("> ") {
                return ParsedLine(kind: .quote, segments: parseInline(String(line.dropFirst(2))))
            }
            return ParsedLine(kind: .paragraph, segments: parseInline(line))
        }
    }

    /// Líneas ya preparadas para el cuerpo de un globo. La caché evita repetir
    /// el parseo y la creación de atributos con cada poll, tick o scroll.
    static func bodyLines(_ text: String) -> [RenderedLine] {
        let key = text as NSString
        if let cached = bodyCache.object(forKey: key) { return cached.value }
        let result = renderedLines(text, baseFont: .body)
        bodyCache.setObject(RenderedLinesBox(result), forKey: key)
        return result
    }

    /// Render inline para previews compactos: las listas/citas siguen legibles
    /// sin abrir un layout de globo dentro de la fila de la bandeja.
    static func attributedPreview(_ text: String, baseFont: Font = .subheadline) -> AttributedString {
        let lines = parsedLines(text)
        var result = AttributedString()

        for (index, line) in lines.enumerated() {
            switch line.kind {
            case .paragraph:
                break
            case .bullet:
                result.append(styledText("• ", styles: [], baseFont: baseFont))
            case .numbered(let marker):
                result.append(styledText("\(marker). ", styles: [], baseFont: baseFont))
            case .quote:
                result.append(styledText("› ", styles: [], baseFont: baseFont))
            }
            result.append(attributed(line.segments, baseFont: baseFont))
            if index < lines.count - 1 {
                result.append(AttributedString("\n"))
            }
        }
        return result
    }

    static func attributedInline(_ text: String, baseFont: Font = .body) -> AttributedString {
        attributed(parseInline(text), baseFont: baseFont)
    }

    private final class RenderedLinesBox {
        let value: [RenderedLine]
        init(_ value: [RenderedLine]) { self.value = value }
    }

    nonisolated(unsafe) private static let bodyCache: NSCache<NSString, RenderedLinesBox> = {
        let cache = NSCache<NSString, RenderedLinesBox>()
        cache.countLimit = 2000
        return cache
    }()

    static func renderedLines(_ text: String, baseFont: Font) -> [RenderedLine] {
        parsedLines(text).map { line in
            RenderedLine(kind: line.kind, text: attributed(line.segments, baseFont: baseFont))
        }
    }

    private static func listBody(in line: String, marker: Character) -> String? {
        guard line.first == marker, line.dropFirst().first?.isWhitespace == true else { return nil }
        return String(line.dropFirst(2))
    }

    private static func numberedList(in line: String) -> (marker: String, body: String)? {
        let characters = Array(line)
        var end = 0
        while end < characters.count, characters[end].isNumber, end < 3 {
            end += 1
        }
        guard end > 0,
              end + 2 <= characters.count,
              characters[end] == ".",
              characters[end + 1].isWhitespace else {
            return nil
        }
        return (String(characters[..<end]), String(characters.dropFirst(end + 2)))
    }

    private static func parseInline(_ source: String, active: Style = []) -> [InlineSegment] {
        let characters = Array(source)
        var segments: [InlineSegment] = []
        var plain = ""
        var index = 0

        func flushPlain() {
            guard !plain.isEmpty else { return }
            appendSegment(&segments, text: plain, styles: active)
            plain = ""
        }

        while index < characters.count {
            if let rule = openingRule(in: characters, at: index),
               let close = closingIndex(in: characters, from: index + rule.delimiter.count, rule: rule) {
                flushPlain()
                let contentStart = index + rule.delimiter.count
                let content = String(characters[contentStart..<close])
                let styles = active.union(rule.style)

                if rule.literal {
                    appendSegment(&segments, text: content, styles: styles)
                } else {
                    for segment in parseInline(content, active: styles) {
                        appendSegment(&segments, text: segment.text, styles: segment.styles)
                    }
                }
                index = close + rule.delimiter.count
                continue
            }

            plain.append(characters[index])
            index += 1
        }
        flushPlain()
        return segments
    }

    private static func appendSegment(_ segments: inout [InlineSegment], text: String, styles: Style) {
        guard !text.isEmpty else { return }
        if let last = segments.indices.last, segments[last].styles == styles {
            segments[last] = InlineSegment(text: segments[last].text + text, styles: styles)
        } else {
            segments.append(InlineSegment(text: text, styles: styles))
        }
    }

    private static func openingRule(in source: [Character], at index: Int) -> Rule? {
        rules.first { rule in
            guard matches(rule.delimiter, in: source, at: index) else { return false }
            if rule.literal {
                return index + rule.delimiter.count < source.count
            }
            return canOpenDelimitedFormat(source, at: index, delimiter: rule.delimiter)
        }
    }

    private static func closingIndex(in source: [Character], from start: Int, rule: Rule) -> Int? {
        var index = start
        while index <= source.count - rule.delimiter.count {
            if matches(rule.delimiter, in: source, at: index) {
                let content = Array(source[start..<index])
                let hasContent = rule.literal
                    ? !content.isEmpty
                    : content.contains(where: { !$0.isWhitespace })
                if hasContent, rule.literal || canCloseDelimitedFormat(source, at: index, delimiter: rule.delimiter) {
                    return index
                }
            }
            index += 1
        }
        return nil
    }

    private static func matches(_ delimiter: [Character], in source: [Character], at index: Int) -> Bool {
        guard index >= 0, index + delimiter.count <= source.count else { return false }
        for offset in delimiter.indices where source[index + offset] != delimiter[offset] {
            return false
        }
        return true
    }

    private static func canOpenDelimitedFormat(_ source: [Character], at index: Int, delimiter: [Character]) -> Bool {
        let nextIndex = index + delimiter.count
        guard nextIndex < source.count, !source[nextIndex].isWhitespace else { return false }
        return index == 0 || isBoundary(source[index - 1])
    }

    private static func canCloseDelimitedFormat(_ source: [Character], at index: Int, delimiter: [Character]) -> Bool {
        guard index > 0, !source[index - 1].isWhitespace else { return false }
        let afterIndex = index + delimiter.count
        return afterIndex == source.count || isBoundary(source[afterIndex])
    }

    private static func isBoundary(_ character: Character) -> Bool {
        character.isWhitespace || boundaryCharacters.contains(character)
    }

    private static func attributed(_ segments: [InlineSegment], baseFont: Font) -> AttributedString {
        segments.reduce(into: AttributedString()) { result, segment in
            result.append(styledText(segment.text, styles: segment.styles, baseFont: baseFont))
        }
    }

    private static func styledText(_ text: String, styles: Style, baseFont: Font) -> AttributedString {
        var result = AttributedString(text)
        var font = baseFont
        if styles.contains(.inlineCode) || styles.contains(.monospace) {
            font = .system(.body, design: .monospaced)
        }
        if styles.contains(.bold) { font = font.weight(.semibold) }
        if styles.contains(.italic) { font = font.italic() }
        result.font = font
        if styles.contains(.strike) {
            result.strikethroughStyle = .single
        }
        return result
    }
}

/// Vista de mensajes enriquecidos para los globos. No toca el contenido
/// almacenado; solo expresa las líneas que WhatsApp formatea visualmente.
struct WhatsAppFormattedMessageText: View {
    let text: String
    let baseFont: Font
    let usesBodyCache: Bool

    init(text: String, baseFont: Font = .body, usesBodyCache: Bool = true) {
        self.text = text
        self.baseFont = baseFont
        self.usesBodyCache = usesBodyCache
    }

    private var lines: [WhatsAppTextFormatter.RenderedLine] {
        usesBodyCache
            ? WhatsAppTextFormatter.bodyLines(text)
            : WhatsAppTextFormatter.renderedLines(text, baseFont: baseFont)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
            ForEach(Array(lines.indices), id: \.self) { index in
                lineView(lines[index])
            }
        }
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func lineView(_ line: WhatsAppTextFormatter.RenderedLine) -> some View {
        switch line.kind {
        case .paragraph:
            Text(line.text)
        case .bullet:
            HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.xs) {
                Text("•")
                    .font(baseFont)
                Text(line.text)
            }
        case .numbered(let marker):
            HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.xs) {
                Text("\(marker).")
                    .font(baseFont)
                    .frame(minWidth: 18, alignment: .trailing)
                Text(line.text)
            }
        case .quote:
            HStack(alignment: .top, spacing: RistakTheme.Spacing.xs) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(RistakTheme.accent)
                    .frame(width: 3)
                Text(line.text)
            }
        }
    }
}
