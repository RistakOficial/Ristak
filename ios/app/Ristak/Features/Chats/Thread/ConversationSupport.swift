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

/// Parser de `*negrita*`, `_itálica_`, `~tachado~` y `` `mono` `` respetando
/// límites de palabra (RN `parseWhatsAppFormattedText`).
enum WhatsAppTextFormatter {
    private struct Style: OptionSet {
        let rawValue: Int
        static let bold = Style(rawValue: 1 << 0)
        static let italic = Style(rawValue: 1 << 1)
        static let strike = Style(rawValue: 1 << 2)
        static let mono = Style(rawValue: 1 << 3)
    }

    private static let openerBoundary = Set(" \t\n([{\"'¿¡")
    private static let closerBoundary = Set(" \t\n.,;:!?)]}\"'…")

    private static func marker(for char: Character) -> Style? {
        switch char {
        case "*": return .bold
        case "_": return .italic
        case "~": return .strike
        case "`": return .mono
        default: return nil
        }
    }

    /// Convierte el texto plano a `AttributedString` con los estilos aplicados.
    static func attributed(_ text: String, baseFont: Font = .body) -> AttributedString {
        var result = AttributedString()
        appendParsed(Array(text), styles: [], baseFont: baseFont, into: &result)
        return result
    }

    private final class AttributedBox {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    /// Caché del texto formateado con la fuente por defecto (`.body`), usada por
    /// las burbujas del hilo. El mismo texto SIEMPRE produce el mismo
    /// `AttributedString`, así que memoizarlo evita re-parsear carácter por
    /// carácter en cada render de fila (poll, tick, scroll). `NSCache` acotada y
    /// thread-safe. Se cachea `AttributedString` directo (conserva los `Font` de
    /// SwiftUI; un puente a `NSAttributedString` perdería negrita/itálica/mono).
    nonisolated(unsafe) private static let bodyCache: NSCache<NSString, AttributedBox> = {
        let cache = NSCache<NSString, AttributedBox>()
        cache.countLimit = 2000
        return cache
    }()

    /// Variante memoizada para el cuerpo de las burbujas (baseFont `.body`).
    static func attributedBody(_ text: String) -> AttributedString {
        let key = text as NSString
        if let cached = bodyCache.object(forKey: key) { return cached.value }
        let result = attributed(text, baseFont: .body)
        bodyCache.setObject(AttributedBox(result), forKey: key)
        return result
    }

    private static func styledPiece(_ text: String, styles: Style, baseFont: Font) -> AttributedString {
        var piece = AttributedString(text)
        var font = baseFont
        if styles.contains(.mono) {
            font = .system(.body, design: .monospaced)
        }
        if styles.contains(.bold) { font = font.weight(.semibold) }
        if styles.contains(.italic) { font = font.italic() }
        piece.font = font
        if styles.contains(.strike) {
            piece.strikethroughStyle = .single
        }
        return piece
    }

    private static func appendParsed(_ chars: [Character], styles: Style, baseFont: Font, into result: inout AttributedString) {
        var index = 0
        var plainBuffer = ""

        func flushPlain() {
            guard !plainBuffer.isEmpty else { return }
            result.append(styledPiece(plainBuffer, styles: styles, baseFont: baseFont))
            plainBuffer = ""
        }

        while index < chars.count {
            let char = chars[index]
            if let style = marker(for: char), !styles.contains(style),
               isValidOpening(chars, at: index),
               let close = findClosing(chars, from: index + 1, marker: char) {
                flushPlain()
                let inner = Array(chars[(index + 1)..<close])
                appendParsed(inner, styles: styles.union(style), baseFont: baseFont, into: &result)
                index = close + 1
                continue
            }
            plainBuffer.append(char)
            index += 1
        }
        flushPlain()
    }

    private static func isValidOpening(_ chars: [Character], at index: Int) -> Bool {
        // Antes: inicio o boundary de apertura.
        if index > 0 {
            let previous = chars[index - 1]
            guard openerBoundary.contains(previous) else { return false }
        }
        // Después: contenido no vacío que no empiece con espacio ni el marker.
        let nextIndex = index + 1
        guard nextIndex < chars.count else { return false }
        let next = chars[nextIndex]
        if next == chars[index] { return false }
        if next.isWhitespace || next.isNewline { return false }
        return true
    }

    private static func findClosing(_ chars: [Character], from start: Int, marker: Character) -> Int? {
        var index = start
        while index < chars.count {
            if chars[index] == marker {
                // Antes del cierre: no-espacio; después: fin o boundary.
                let previous = chars[index - 1]
                if !previous.isWhitespace {
                    let afterIndex = index + 1
                    if afterIndex >= chars.count || closerBoundary.contains(chars[afterIndex]) {
                        return index
                    }
                }
            }
            if chars[index].isNewline && marker != "`" { return nil }
            index += 1
        }
        return nil
    }
}

