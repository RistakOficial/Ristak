import SwiftUI
import UIKit

/// Tarjeta de correo dentro del hilo (User #5): se ve como un preview de mail
/// nativo. Cabecera siempre visible (icono tonal + tipo + fecha en zona del
/// negocio, asunto y contacto principal); colapsada muestra un adelanto de 2
/// líneas del cuerpo con afordancia para expandir; expandida muestra chips de
/// remitente/destinatarios y el cuerpo (HTML → texto atribuido legible en
/// claro/oscuro, ancho acotado).
struct EmailMessageCard: View {
    let message: ChatMessage
    let details: ChatEmailDetails
    let formatters: BusinessFormatters

    @State private var isExpanded = false
    @State private var htmlBody: AttributedString?

    private var kicker: String {
        switch message.direction {
        case .outbound: return "Correo enviado"
        case .inbound: return "Correo recibido"
        case .system: return "Correo electrónico"
        }
    }

    private var subject: String {
        let trimmed = details.subject.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Sin asunto" : trimmed
    }

    /// Contacto principal de la ruta: para salientes el destinatario, para
    /// entrantes el remitente (con respaldo al otro extremo).
    private var primaryContact: String {
        switch message.direction {
        case .outbound:
            return details.toEmail.isEmpty ? details.fromEmail : details.toEmail
        default:
            return details.fromEmail.isEmpty ? details.toEmail : details.fromEmail
        }
    }

    private var primaryContactLabel: String {
        message.direction == .outbound ? "Para" : "De"
    }

    /// Fecha del correo en la zona horaria del negocio ("Hoy · 3:40 p.m.").
    private var dateLabel: String {
        let day = formatters.daySeparatorLabel(fromISO: message.date)
        let time = formatters.messageTime(fromISO: message.date)
        return [day, time].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var previewBody: String {
        details.body
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var bodyText: String {
        let trimmed = details.body.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Sin cuerpo" : trimmed
    }

    /// Chips de la ruta completa (solo los que traen valor).
    private var recipientChips: [(label: String, value: String)] {
        var chips: [(String, String)] = []
        func add(_ label: String, _ value: String?) {
            let clean = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty { chips.append((label, clean)) }
        }
        add("De", details.fromEmail)
        add("Para", details.toEmail)
        add("CC", details.ccEmail)
        add("BCC", details.bccEmail)
        add("Responder a", details.replyTo)
        return chips
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if isExpanded {
                expandedContent
            } else if !previewBody.isEmpty {
                collapsedPreview
            }
        }
        .frame(maxWidth: 300, alignment: .leading)
    }

    // MARK: - Cabecera

    private var header: some View {
        Button {
            withAnimation(.snappy(duration: 0.22)) {
                isExpanded.toggle()
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    Image(systemName: "envelope.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(RistakTheme.info)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(RistakTheme.infoSoft))

                    VStack(alignment: .leading, spacing: 1) {
                        Text(kicker.uppercased())
                            .font(.system(size: 10, weight: .bold))
                            .tracking(0.4)
                            .foregroundStyle(RistakTheme.info)
                            .lineLimit(1)
                        if !dateLabel.isEmpty {
                            Text(dateLabel)
                                .font(.caption2)
                                .foregroundStyle(RistakTheme.textMute)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: 0)

                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(RistakTheme.textMute)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }

                Text(subject)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(isExpanded ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !primaryContact.isEmpty {
                    HStack(spacing: 4) {
                        Text(primaryContactLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(RistakTheme.textMute)
                        Text(primaryContact)
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Colapsado

    private var collapsedPreview: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(previewBody)
                .font(.caption)
                .foregroundStyle(RistakTheme.textDim)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text("Ver correo completo")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(RistakTheme.accent)
        }
        .padding(.top, RistakTheme.Spacing.xs)
    }

    // MARK: - Expandido

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            Rectangle()
                .fill(RistakTheme.border.opacity(0.6))
                .frame(height: 0.5)
                .padding(.top, RistakTheme.Spacing.xs)

            if !recipientChips.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(recipientChips, id: \.label) { chip in
                        recipientChip(chip.label, chip.value)
                    }
                }
            }

            bodyView
        }
        .padding(.top, 2)
        .task {
            await renderHTMLIfNeeded()
        }
    }

    private func recipientChip(_ label: String, _ value: String) -> some View {
        HStack(spacing: 6) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .bold))
                .tracking(0.3)
                .foregroundStyle(RistakTheme.textMute)
            Text(value)
                .font(.caption)
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule().fill(RistakTheme.controlRest))
    }

    @ViewBuilder
    private var bodyView: some View {
        if let htmlBody {
            Text(htmlBody)
                .font(.callout)
                .foregroundStyle(RistakTheme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(bodyText)
                .font(.callout)
                .foregroundStyle(details.body.isEmpty ? RistakTheme.textMute : RistakTheme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Render del cuerpo HTML como texto atribuido (main thread; una sola vez).
    /// Se normaliza tipografía y color para que la Vista imponga la fuente y el
    /// color del tema (legible en claro/oscuro).
    @MainActor
    private func renderHTMLIfNeeded() async {
        guard htmlBody == nil,
              let html = details.bodyHtml,
              !html.isEmpty,
              let data = html.data(using: .utf8) else { return }
        let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
            .documentType: NSAttributedString.DocumentType.html,
            .characterEncoding: String.Encoding.utf8.rawValue,
        ]
        guard let rendered = try? NSAttributedString(data: data, options: options, documentAttributes: nil) else {
            return
        }
        var attributed = AttributedString(rendered)
        attributed.font = nil
        attributed.foregroundColor = nil
        attributed.backgroundColor = nil
        htmlBody = attributed
    }
}

/// Sheet «Info del mensaje» (doc 04 §8.2 — pantalla de /movil, superior al
/// Alert de RN): preview + filas de canal/estado/horas/error.
struct MessageInfoSheet: View {
    let message: ChatMessage
    let formatters: BusinessFormatters

    var body: some View {
        SheetScaffold(title: "Info del mensaje") {
            List {
                Section {
                    Text(MessagePreviewText.preview(for: message))
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(6)
                }

                Section {
                    infoRow(
                        message.direction == .outbound ? "Enviado" : "Recibido",
                        value: fullTimestamp(message.date) ?? "Sin hora guardada"
                    )
                    infoRow("Canal", value: channelLabel)

                    if message.direction == .outbound {
                        infoRow("Entregado", value: deliveredLabel)
                        infoRow("Leído", value: readLabel)
                    } else {
                        infoRow("Leído por ti", value: fullTimestamp(message.readAt) ?? "Sin registro guardado")
                    }

                    if let status = message.status, !status.isEmpty {
                        infoRow("Estado", value: status)
                    }
                }

                if message.receiptStatus == .failed {
                    Section {
                        HStack(alignment: .top) {
                            Text("Error")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(RistakTheme.neg)
                            Spacer()
                            Text(message.errorReason ?? "No se guardó la razón exacta del error.")
                                .font(.subheadline)
                                .foregroundStyle(RistakTheme.neg)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
        .presentationDetents([.medium, .large])
    }

    private var channelLabel: String {
        MessageTransportBadge.label(for: message) ?? message.channel
    }

    private var deliveredLabel: String {
        if let stamp = fullTimestamp(message.deliveredAt) { return stamp }
        switch message.receiptStatus {
        case .delivered, .read: return "Confirmado, sin hora exacta"
        case .failed: return "No entregado"
        default: return "Sin confirmación"
        }
    }

    private var readLabel: String {
        if let stamp = fullTimestamp(message.readAt) { return stamp }
        if message.receiptStatus == .read { return "Leído, sin hora exacta" }
        return "Aún no leído"
    }

    private func fullTimestamp(_ raw: String?) -> String? {
        guard let date = RistakDateParsing.date(fromISO: raw) else { return nil }
        return "\(formatters.daySeparatorLabel(date)) · \(formatters.messageTime(date))"
    }

    private func infoRow(_ label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textPrimary)
                .multilineTextAlignment(.trailing)
        }
    }
}
