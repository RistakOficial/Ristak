import SwiftUI
import UIKit

/// Tarjeta de correo colapsable (doc 04 §7.6): cabecera siempre visible
/// (kicker + asunto + ruta + chevron); expandida muestra filas etiqueta:valor
/// y el cuerpo (HTML → texto atribuido; fallback al cuerpo plano).
struct EmailMessageCard: View {
    let message: ChatMessage
    let details: ChatEmailDetails

    @State private var isExpanded = false
    @State private var htmlBody: AttributedString?

    private var kicker: String {
        switch message.direction {
        case .outbound: return "Correo enviado"
        case .inbound: return "Correo recibido"
        case .system: return "Correo electrónico"
        }
    }

    private var routeLine: String {
        switch message.direction {
        case .outbound:
            return details.toEmail.isEmpty ? details.fromEmail : details.toEmail
        default:
            return details.fromEmail.isEmpty ? details.toEmail : details.fromEmail
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.22)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(alignment: .top, spacing: RistakTheme.Spacing.sm) {
                    Image(systemName: "envelope.fill")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.info)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(RistakTheme.infoSoft))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(kicker.uppercased())
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(RistakTheme.textDim)
                        Text(details.subject.isEmpty ? "Sin asunto" : details.subject)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(RistakTheme.textPrimary)
                            .lineLimit(isExpanded ? nil : 2)
                        if !routeLine.isEmpty {
                            Text(routeLine)
                                .font(.caption)
                                .foregroundStyle(RistakTheme.textDim)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textMute)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    Divider()
                        .padding(.vertical, RistakTheme.Spacing.xxs)

                    detailRow("Asunto", details.subject)
                    detailRow("Remitente", details.fromEmail)
                    detailRow("Destinatarios", details.toEmail)
                    detailRow("CC", details.ccEmail ?? "")
                    detailRow("BCC", details.bccEmail ?? "")
                    detailRow("Responder a", details.replyTo)
                    detailRow("Estado", details.status)
                    detailRow("Transporte", details.transport)

                    Text("Cuerpo:")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textDim)

                    if let htmlBody {
                        Text(htmlBody)
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textPrimary)
                            .textSelection(.enabled)
                    } else {
                        Text(details.body.isEmpty ? "Sin cuerpo" : details.body)
                            .font(.subheadline)
                            .foregroundStyle(details.body.isEmpty ? RistakTheme.textDim : RistakTheme.textPrimary)
                            .textSelection(.enabled)
                    }
                }
                .task {
                    await renderHTMLIfNeeded()
                }
            }
        }
        .frame(maxWidth: 320, alignment: .leading)
    }

    @ViewBuilder
    private func detailRow(_ label: String, _ value: String) -> some View {
        if !value.isEmpty {
            HStack(alignment: .top, spacing: RistakTheme.Spacing.xxs) {
                Text("\(label):")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
                Text(value)
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textPrimary)
                    .textSelection(.enabled)
            }
        }
    }

    /// Render del cuerpo HTML como texto atribuido (main thread; una sola vez).
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
        // Normalizar tipografía/color para ambos modos (el HTML trae estilos propios).
        attributed.font = nil
        attributed.foregroundColor = nil
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
