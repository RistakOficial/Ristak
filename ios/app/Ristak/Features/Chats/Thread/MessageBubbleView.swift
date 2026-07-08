import SwiftUI
import UIKit

// Burbujas y filas del timeline (doc research/04 §7).

// MARK: - Acciones inyectadas a la fila

/// Callbacks del ViewModel hacia cada burbuja (evita acoplar la vista al VM).
struct MessageRowActions {
    var reply: (ChatMessage) -> Void
    var react: (ChatMessage, String) -> Void
    var copy: (ChatMessage) -> Void
    var info: (ChatMessage) -> Void
    var retry: (ChatMessage) -> Void
    var editScheduled: (ChatMessage) -> Void
    var deleteScheduled: (ChatMessage) -> Void
    var scrollTo: (String) -> Void
    var reactionCapability: (ChatMessage) -> ReactionCapability
    var findReplyTarget: (ChatMessage) -> ChatMessage?
    var commentContext: (ChatMessage) -> CommentPostContext?
}

// MARK: - Separador de día

struct DaySeparatorView: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(RistakTheme.textDim)
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .padding(.vertical, 5)
            .background(Capsule().fill(RistakTheme.daySeparator))
            .frame(maxWidth: .infinity)
            .padding(.vertical, RistakTheme.Spacing.xxs)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Marker de actividad

struct ActivityMarkerView: View {
    let marker: ConversationActivityMarker
    let formatters: BusinessFormatters

    var body: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            line
            HStack(spacing: RistakTheme.Spacing.xxs) {
                Image(systemName: marker.systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(marker.kind == .payment ? RistakTheme.pos : RistakTheme.accent)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 4) {
                        Text(marker.title)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(RistakTheme.textPrimary)
                        if let amount = marker.amountLabel {
                            Text(amount)
                                .font(.caption.weight(.bold))
                                .monospacedDigit()
                                .foregroundStyle(RistakTheme.pos)
                        }
                    }
                    Text(subtitleLine)
                        .font(.caption2)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .padding(.vertical, 6)
            .background(Capsule().fill(RistakTheme.daySeparator))
            line
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
    }

    private var subtitleLine: String {
        var pieces: [String] = []
        if !marker.subtitle.isEmpty { pieces.append(marker.subtitle) }
        if let date = marker.parsedDate {
            pieces.append(formatters.messageTime(date))
        }
        return pieces.joined(separator: " · ")
    }

    private var line: some View {
        Rectangle()
            .fill(RistakTheme.border)
            .frame(height: 0.5)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - Burbuja de sistema

struct SystemBubbleView: View {
    let message: ChatMessage

    var body: some View {
        Text(message.text)
            .font(.footnote)
            .foregroundStyle(RistakTheme.textDim)
            .multilineTextAlignment(.center)
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.small)
                    .fill(RistakTheme.daySeparator)
            )
            .frame(maxWidth: .infinity)
            .padding(.vertical, RistakTheme.Spacing.xxs)
    }
}

// MARK: - Fila de mensaje

struct MessageRowView: View {
    let message: ChatMessage
    let formatters: BusinessFormatters
    let contactName: String
    /// Countdown en vivo para programados ("5m", "3h", "2d").
    let scheduledCountdown: String?
    let actions: MessageRowActions

    @State private var dragOffset: CGFloat = 0
    @State private var replyTriggered = false

    private var isOutbound: Bool { message.direction == .outbound }

    var body: some View {
        if message.direction == .system {
            SystemBubbleView(message: message)
        } else {
            bubbleRow
        }
    }

    private var bubbleRow: some View {
        HStack(alignment: .bottom, spacing: RistakTheme.Spacing.xs) {
            if isOutbound {
                Spacer(minLength: 44)
                if message.isScheduled, let scheduledCountdown {
                    scheduledTimer(scheduledCountdown)
                }
            }

            bubbleContent
                .offset(x: dragOffset)
                .overlay(alignment: isOutbound ? .trailing : .leading) {
                    if abs(dragOffset) > 6 {
                        Image(systemName: "arrowshape.turn.up.left.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(RistakTheme.textDim)
                            .padding(6)
                            .background(Circle().fill(RistakTheme.daySeparator))
                            .offset(x: isOutbound ? 40 : -40)
                    }
                }
                .simultaneousGesture(swipeToReplyGesture)
                .sensoryFeedback(.impact(weight: .light), trigger: replyTriggered)

            if !isOutbound {
                Spacer(minLength: 44)
            }
        }
        .padding(.vertical, 1.5)
    }

    // MARK: Globo

    private var bubbleContent: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
            quoteBlock
            attachmentBlock
            locationBlock
            commentContextBlock
            emailBlock
            textBlock
            routingReasonBlock
            metaRow
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, RistakTheme.Spacing.xs)
        .background(bubbleBackground)
        .overlay(alignment: .bottom) {
            reactionChips
                .offset(y: 12)
        }
        .padding(.bottom, message.visibleReactions.isEmpty ? 0 : 12)
        .contextMenu { contextMenuItems }
    }

    private var bubbleBackground: some View {
        let shape = RoundedRectangle(cornerRadius: 16)
        return ZStack {
            shape.fill(bubbleFill)
            if message.isScheduled {
                shape.strokeBorder(
                    RistakTheme.textMute,
                    style: StrokeStyle(lineWidth: 1, dash: [5, 4])
                )
            }
        }
    }

    private var bubbleFill: Color {
        if message.failed {
            return RistakTheme.bubbleFailed
        }
        if message.isScheduled { return RistakTheme.bubbleScheduled }
        return isOutbound ? RistakTheme.bubbleOutgoing : RistakTheme.bubbleIncoming
    }

    // MARK: Piezas

    @ViewBuilder
    private var quoteBlock: some View {
        if message.replyToMessageId != nil || message.replyToProviderMessageId != nil {
            let target = actions.findReplyTarget(message)
            Button {
                if let target {
                    actions.scrollTo(target.id)
                }
            } label: {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(RistakTheme.accent)
                        .frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(quoteTitle(target: target))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(RistakTheme.accent)
                        Text(target.map(MessagePreviewText.preview(for:)) ?? "Mensaje")
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(RistakTheme.Spacing.xxs)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.small)
                        .fill(RistakTheme.controlRest)
                )
            }
            .buttonStyle(.plain)
        }
    }

    private func quoteTitle(target: ChatMessage?) -> String {
        guard let target else { return contactName }
        return target.direction == .outbound ? "Tú" : contactName
    }

    @ViewBuilder
    private var attachmentBlock: some View {
        if let attachment = message.attachment {
            switch attachment.type {
            case .image:
                ImageAttachmentView(attachment: attachment)
            case .video:
                VideoAttachmentView(attachment: attachment, isOutbound: isOutbound)
            case .audio:
                AudioMessageView(attachment: attachment, isOutbound: isOutbound)
            case .document, .file:
                DocumentAttachmentView(attachment: attachment)
            }
        }
    }

    @ViewBuilder
    private var locationBlock: some View {
        if let location = message.location {
            LocationMessageView(location: location)
        }
    }

    @ViewBuilder
    private var commentContextBlock: some View {
        if message.isComment {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
                Label(commentLabel, systemImage: "text.bubble")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)

                if let context = actions.commentContext(message) {
                    Button {
                        if let permalink = context.postPermalink, let url = URL(string: permalink) {
                            UIApplication.shared.open(url)
                        }
                    } label: {
                        HStack(spacing: RistakTheme.Spacing.xs) {
                            if let imageRaw = context.postImageUrl, let url = URL(string: imageRaw) {
                                ChatRemoteImage(url: url)
                                    .frame(width: 36, height: 36)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(context.postDeleted ? "Publicación eliminada" : "Publicación")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(RistakTheme.textDim)
                                Text(postPreviewText(context))
                                    .font(.caption)
                                    .foregroundStyle(RistakTheme.textPrimary)
                                    .lineLimit(2)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(RistakTheme.Spacing.xxs)
                        .background(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.small)
                                .fill(RistakTheme.controlRest)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(context.postPermalink == nil)
                }
            }
        }
    }

    private var commentLabel: String {
        switch message.commentReplyMode {
        case "public": return "Respuesta pública al comentario"
        case "private": return "Respuesta por privado"
        default:
            return message.direction == .inbound ? "Comentó en tu publicación" : "Comentario"
        }
    }

    private func postPreviewText(_ context: CommentPostContext) -> String {
        if context.postDeleted { return "Comentario conservado en Ristak" }
        if let text = context.postMessage, !text.isEmpty { return text }
        return "Ver publicación"
    }

    @ViewBuilder
    private var emailBlock: some View {
        if let details = message.emailDetails {
            EmailMessageCard(message: message, details: details)
        }
    }

    @ViewBuilder
    private var textBlock: some View {
        // El globo NO repite el texto plano cuando hay emailDetails (doc 04 §7.6).
        if message.emailDetails == nil, !message.text.isEmpty {
            Text(WhatsAppTextFormatter.attributed(message.text, baseFont: .body))
                .foregroundStyle(message.failed ? RistakTheme.neg : RistakTheme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var routingReasonBlock: some View {
        if let reason = message.routingReason, !reason.isEmpty, isOutbound {
            Text(reason)
                .font(.caption2)
                .foregroundStyle(RistakTheme.textMute)
        }
    }

    // MARK: Meta + palomitas

    private var metaRow: some View {
        HStack(spacing: RistakTheme.Spacing.xxs) {
            if let badge = MessageTransportBadge.label(for: message) {
                Text(badge)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(RistakTheme.textMute)
            }

            if message.isScheduled {
                Image(systemName: "clock")
                    .font(.system(size: 10))
                    .foregroundStyle(RistakTheme.textMute)
                Text("Programado para \(formatters.messageTime(fromISO: message.scheduledAt ?? message.date))")
                    .font(.caption2)
                    .foregroundStyle(RistakTheme.textMute)
            } else {
                Text(metaLabel)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textMute)
                if isOutbound {
                    MessageReceiptView(status: message.receiptStatus)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var metaLabel: String {
        var label = formatters.messageTime(fromISO: message.date)
        if message.pending { label += " · enviando" }
        if message.failed { label += " · error" }
        return label
    }

    // MARK: Reacciones

    @ViewBuilder
    private var reactionChips: some View {
        let reactions = message.visibleReactions
        if !reactions.isEmpty {
            HStack(spacing: 2) {
                ForEach(reactions) { reaction in
                    Text(reaction.emoji)
                        .font(.footnote)
                }
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(RistakTheme.surface)
                    .overlay(Capsule().strokeBorder(RistakTheme.border, lineWidth: 0.5))
            )
            .offset(x: isOutbound ? -8 : 8)
            .frame(maxWidth: .infinity, alignment: isOutbound ? .trailing : .leading)
        }
    }

    // MARK: Menú contextual (doc 04 §8)

    @ViewBuilder
    private var contextMenuItems: some View {
        if message.isScheduled {
            Button {
                actions.editScheduled(message)
            } label: {
                Label("Editar programación", systemImage: "pencil")
            }
            Button(role: .destructive) {
                actions.deleteScheduled(message)
            } label: {
                Label("Eliminar programación", systemImage: "trash")
            }
        } else {
            let capability = actions.reactionCapability(message)
            if !capability.emojis.isEmpty {
                ControlGroup {
                    ForEach(capability.emojis, id: \.self) { emoji in
                        Button(emoji) {
                            actions.react(message, emoji)
                        }
                    }
                }
                .controlGroupStyle(.compactMenu)
            }

            Button {
                actions.reply(message)
            } label: {
                Label("Responder", systemImage: "arrowshape.turn.up.left")
            }
            Button {
                actions.copy(message)
            } label: {
                Label("Copiar", systemImage: "doc.on.doc")
            }
            if message.failed {
                Button {
                    actions.retry(message)
                } label: {
                    Label("Reintentar", systemImage: "arrow.clockwise")
                }
            }
            if let attachment = message.attachment, let raw = attachment.url, let url = URL(string: raw), !url.isFileURL {
                Button {
                    UIApplication.shared.open(url)
                } label: {
                    Label(attachment.type == .document || attachment.type == .file ? "Abrir documento" : "Descargar", systemImage: "arrow.down.circle")
                }
            }
            Button {
                actions.info(message)
            } label: {
                Label("Info del mensaje", systemImage: "info.circle")
            }
        }
    }

    // MARK: Swipe para responder (doc 04 §8.1)

    private var swipeToReplyGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { value in
                guard !message.isScheduled else { return }
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) > abs(dy) * 1.4 else { return }
                // Entrantes arrastran a la derecha; salientes a la izquierda.
                let directional = isOutbound ? min(0, dx) : max(0, dx)
                dragOffset = max(-72, min(72, directional))
            }
            .onEnded { _ in
                if abs(dragOffset) > 38 {
                    replyTriggered.toggle()
                    actions.reply(message)
                }
                withAnimation(.spring(duration: 0.28)) {
                    dragOffset = 0
                }
            }
    }

    // MARK: Timer flotante de programados

    private func scheduledTimer(_ countdown: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "clock")
                .font(.system(size: 10, weight: .semibold))
            Text(countdown)
                .font(.caption2.weight(.bold))
                .monospacedDigit()
        }
        .foregroundStyle(RistakTheme.textDim)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Capsule().fill(RistakTheme.daySeparator))
    }
}

// MARK: - Palomitas

/// Palomitas de acuse (doc 04 §7.2): derivadas SOLO de `status`.
struct MessageReceiptView: View {
    let status: ChatMessageReceiptStatus

    var body: some View {
        switch status {
        case .pending:
            ProgressView()
                .controlSize(.mini)
                .accessibilityLabel("Enviando")
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(RistakTheme.neg)
                .accessibilityLabel("No se envió")
        case .sent:
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(RistakTheme.textMute)
                .accessibilityLabel("Enviado")
        case .delivered:
            doubleCheck(color: RistakTheme.textMute)
                .accessibilityLabel("Entregado")
        case .read:
            doubleCheck(color: RistakTheme.accent)
                .accessibilityLabel("Leído")
        }
    }

    private func doubleCheck(color: Color) -> some View {
        HStack(spacing: -5) {
            Image(systemName: "checkmark")
            Image(systemName: "checkmark")
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(color)
    }
}
