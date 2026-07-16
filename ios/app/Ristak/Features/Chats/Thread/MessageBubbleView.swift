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
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(RistakTheme.daySeparator)
            )
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
        HStack(spacing: RistakTheme.Spacing.sm) {
            line
            markerCard
            line
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
    }

    /// Tarjeta cómoda del hito: ícono + título + monto + fecha en una línea
    /// legible y centrada. La tarjeta ABRAZA su contenido y NO se deja aplastar:
    /// los divisores flexibles de los lados rellenan el espacio sobrante.
    private var markerCard: some View {
        HStack(alignment: .center, spacing: RistakTheme.Spacing.xs) {
            Image(systemName: marker.systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(marker.kind == .payment ? RistakTheme.pos : RistakTheme.accent)
                // Marco fijo → el símbolo circular ($ / calendario) mantiene su
                // proporción y nunca se aplasta a óvalo aunque el HStack apriete.
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.xs) {
                    Text(marker.title)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)
                    if let amount = marker.amountLabel {
                        Text(amount)
                            .font(.caption.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(RistakTheme.pos)
                            .lineLimit(1)
                    }
                }
                if !subtitleLine.isEmpty {
                    Text(subtitleLine)
                        .font(.caption2)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.md)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(RistakTheme.daySeparator)
        )
        // Abraza el contenido (no se estira ni se comprime): tamaño dictado por el
        // texto, con prioridad de layout para ganar el ancho frente a los
        // divisores `.frame(maxWidth: .infinity)` que lo flanquean.
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
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
        WhatsAppFormattedMessageText(text: message.displayText, baseFont: .footnote, usesBodyCache: false)
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

struct MessageRowView: View, Equatable {
    let message: ChatMessage
    let formatters: BusinessFormatters
    let contactName: String
    /// Foto del contacto para el avatar de la nota de voz (paridad /movil).
    var contactPhotoURL: URL? = nil
    /// Countdown en vivo para programados ("5m", "3h", "2d").
    let scheduledCountdown: String?
    let actions: MessageRowActions

    /// Solo el mensaje y sus derivados visuales determinan el render; los closures
    /// de `actions` se IGNORAN a propósito (capturan el viewModel estable y el
    /// `@State` del quote, así que su comportamiento no cambia entre renders).
    /// Con esto SwiftUI puede saltarse el `body` de una burbuja que no cambió
    /// aunque el padre re-evalúe por un poll, un tick de 30s o un flip de scroll
    /// — antes se re-ejecutaba el body de TODAS las burbujas visibles cada vez.
    /// `scheduledCountdown` SÍ se compara: cambia por tick en los programados.
    static func == (lhs: MessageRowView, rhs: MessageRowView) -> Bool {
        lhs.message == rhs.message
            && lhs.scheduledCountdown == rhs.scheduledCountdown
            && lhs.contactName == rhs.contactName
            && lhs.contactPhotoURL == rhs.contactPhotoURL
    }

    @State private var dragOffset: CGFloat = 0
    /// True mientras el usuario arrastra la ruedita del scrubber de audio: bloquea
    /// el swipe-para-responder para que no compitan ambos gestos horizontales.
    @State private var isScrubbingAudio = false
    @State private var replyTriggered = false
    /// True mientras el arrastre supera el umbral (para disparar el háptico una
    /// sola vez por gesto, justo al cruzarlo).
    @State private var reachedReplyThreshold = false
    /// Trigger del háptico sutil al cruzar el umbral durante el swipe.
    @State private var replyThresholdHaptic = false
    /// Presenta el selector ampliado de emojis (botón «+» del picker rápido).
    @State private var showsEmojiPicker = false

    /// Distancia de arrastre a la que se dispara la respuesta (paridad /movil
    /// `Math.abs(gesture.dx) > 38`). La flecha llega a plena visibilidad aquí.
    private let replyThreshold: CGFloat = 38

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

            if message.sentByAgent && !isOutbound {
                agentSideMarker
            }

            // La flecha vive FIJA en el hueco que revela el arrastre (entrante
            // pegada a .leading, saliente a .trailing) y la burbuja se desliza
            // POR ENCIMA con `.offset(x:)`, dejándola a la vista. Antes la flecha
            // era un overlay del propio contenido desplazado, así que viajaba con
            // la burbuja y nunca se veía (bug #5).
            ZStack(alignment: isOutbound ? .trailing : .leading) {
                replyArrowCue
                bubbleContent
                    .offset(x: dragOffset)
            }
            .simultaneousGesture(swipeToReplyGesture)
            .sensoryFeedback(.impact(weight: .light), trigger: replyTriggered)
            .sensoryFeedback(.impact(weight: .light, intensity: 0.5), trigger: replyThresholdHaptic)

            if message.sentByAgent && isOutbound {
                agentSideMarker
            }

            if !isOutbound {
                Spacer(minLength: 44)
            }
        }
        // Separación entre burbujas consecutivas (paridad /movil
        // `.messageRow { margin: 3px 0 }` → 6 pt de aire entre mensajes).
        .padding(.vertical, 3)
    }

    // MARK: Globo

    private var bubbleContent: some View {
        bubbleInner
            // Vestido de globo con la geometría exacta de mobile/ (radio 11,
            // colita a 4, padding 7/9/5, sombra sutil). ABRAZA el texto.
            .modifier(RistakChatBubbleStyle(
                side: isOutbound ? .outbound : .inbound,
                fill: bubbleFillOverride,
                channelColor: message.failed ? nil : bubbleChannelColor,
                dashed: message.isScheduled
            ))
            // Los globos son superficies claras aun cuando el shell use modo
            // oscuro; el contenido debe resolver texto e iconos como light.
            .environment(\.colorScheme, .light)
            .overlay(alignment: .bottom) {
                reactionChips
                    .offset(y: 12)
            }
            .padding(.bottom, message.visibleReactions.isEmpty ? 0 : 12)
            .contextMenu { contextMenuItems }
            .sheet(isPresented: $showsEmojiPicker) {
                ReactionEmojiPickerSheet { emoji in
                    actions.react(message, emoji)
                }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
    }

    /// Columna de contenido del globo. La meta (hora + acuse) se reserva como
    /// última "línea" invisible y se dibuja encima abajo-derecha, para que el
    /// globo abrace su contenido en vez de estirarse a lo ancho (WhatsApp).
    private var bubbleInner: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs + 2) {
            quoteBlock
            attachmentBlock
            locationBlock
            commentContextBlock
            emailBlock
            textBlock
            routingReasonBlock
            metaRow.hidden()
        }
        .overlay(alignment: .bottomTrailing) {
            metaRow
        }
    }

    /// Relleno explícito solo cuando falló (rojo). Programado y lados normales
    /// los resuelve `RistakChatBubbleStyle` (dashed / inbound / outbound).
    private var bubbleFillOverride: Color? {
        message.failed ? RistakTheme.bubbleFailed : nil
    }

    private var bubbleChannelColor: Color? {
        guard isOutbound else { return nil }
        let channel = ChatMessageChannelKind.resolve(
            channel: message.channel,
            transport: message.transport,
            messageType: message.messageType,
            hasEmail: message.emailDetails != nil
        )
        switch channel {
        case .whatsappAPI: return RistakTheme.chatChannelWhatsAppAPI
        case .whatsappQR: return RistakTheme.chatChannelWhatsAppQR
        case .instagram: return RistakTheme.chatChannelInstagram
        case .messenger: return RistakTheme.chatChannelMessenger
        case .sms, .email, nil: return nil
        }
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
                        Text(WhatsAppTextFormatter.attributedPreview(
                            target.map(MessagePreviewText.preview(for:)) ?? "Mensaje",
                            baseFont: .caption
                        ))
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
                AudioMessageView(
                    attachment: attachment,
                    isOutbound: isOutbound,
                    messageID: message.id,
                    contactName: contactName,
                    contactPhotoURL: contactPhotoURL,
                    isScrubbing: $isScrubbingAudio
                )
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
                Label(commentLabel, systemImage: "photo.on.rectangle.angled")
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
            EmailMessageCard(message: message, details: details, formatters: formatters)
        }
    }

    @ViewBuilder
    private var textBlock: some View {
        // El globo NO repite el texto plano cuando hay emailDetails (doc 04 §7.6).
        if message.emailDetails == nil, !message.displayText.isEmpty {
            WhatsAppFormattedMessageText(text: message.displayText)
                .foregroundStyle(message.failed ? RistakTheme.neg : RistakTheme.bubbleTextInbound)
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
                    .foregroundStyle(RistakTheme.bubbleMeta)
            }

            if message.isScheduled {
                Image(systemName: "clock")
                    .font(.system(size: 10))
                    .foregroundStyle(RistakTheme.bubbleMeta)
                Text("Programado para \(formatters.messageTime(fromISO: message.scheduledAt ?? message.date))")
                    .font(.caption2)
                    .foregroundStyle(RistakTheme.bubbleMeta)
            } else {
                Text(metaLabel)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.bubbleMeta)
                if isOutbound {
                    MessageReceiptView(status: message.receiptStatus)
                }
            }
        }
    }

    private var metaLabel: String {
        var label = formatters.messageTime(fromISO: message.date)
        if message.pending { label += " · enviando" }
        if message.failed { label += " · error" }
        return label
    }

    private var agentSideMarker: some View {
        AgentBotGlyph(color: RistakTheme.accent, size: 15)
            .frame(width: 26, height: 26)
            .background(Circle().fill(RistakTheme.surface))
            .overlay(Circle().stroke(RistakTheme.border, lineWidth: 0.5))
            .shadow(color: RistakTheme.bubbleShadow, radius: 2, x: 0, y: 1)
            .padding(.bottom, 5)
            .accessibilityLabel("Respondido por agente conversacional")
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
                    // «+» para reaccionar con CUALQUIER emoji. Solo cuando el canal
                    // acepta más de un emoji (WhatsApp); en Meta (solo ❤️) se oculta.
                    if capability.emojis.count > 1 {
                        Button {
                            showsEmojiPicker = true
                        } label: {
                            Label("Más", systemImage: "plus")
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

    /// Progreso del swipe hacia el umbral de respuesta (0…1). Alcanza 1 justo en
    /// el umbral; a partir de ahí se mantiene lleno.
    private var replySwipeProgress: Double {
        Double(min(1, abs(dragOffset) / replyThreshold))
    }

    /// Flecha curva de respuesta que aparece PROGRESIVAMENTE con el arrastre
    /// (opacidad + escala), a plena visibilidad justo al llegar al umbral —
    /// paridad con el gesto de respuesta de /movil (`Forward` en color acento).
    @ViewBuilder
    private var replyArrowCue: some View {
        if abs(dragOffset) > 1 {
            let progress = replySwipeProgress
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(RistakTheme.accent)
                .padding(6)
                .background(
                    Circle()
                        .fill(RistakTheme.surface)
                        .overlay(Circle().strokeBorder(RistakTheme.border, lineWidth: 0.5))
                )
                // Escala sutil 0.5→1 y opacidad 0.2→1 con el progreso del swipe;
                // llega a plena visibilidad justo en el umbral (38 pt). Sin
                // `.offset` propio: se queda quieta en el hueco y la burbuja la
                // descubre al deslizarse.
                .scaleEffect(0.5 + 0.5 * progress)
                .opacity(0.2 + 0.8 * progress)
                .padding(.horizontal, 4)
                .allowsHitTesting(false)
        }
    }

    private var swipeToReplyGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { value in
                // Si el dedo está arrastrando la ruedita del audio, este gesto no
                // debe mover la burbuja ni armar la respuesta.
                guard !message.isScheduled, !isScrubbingAudio else { return }
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) > abs(dy) * 1.4 else { return }
                // Entrantes arrastran a la derecha; salientes a la izquierda.
                let directional = isOutbound ? min(0, dx) : max(0, dx)
                dragOffset = max(-72, min(72, directional))
                // Háptico sutil justo al cruzar el umbral (una sola vez por gesto).
                let crossed = abs(dragOffset) >= replyThreshold
                if crossed != reachedReplyThreshold {
                    reachedReplyThreshold = crossed
                    if crossed { replyThresholdHaptic.toggle() }
                }
            }
            .onEnded { _ in
                if !isScrubbingAudio, abs(dragOffset) >= replyThreshold {
                    replyTriggered.toggle()
                    actions.reply(message)
                }
                reachedReplyThreshold = false
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

// MARK: - Selector ampliado de emoji para reacción (botón «+»)

/// Grilla simple de emojis comunes para reaccionar con CUALQUIER emoji
/// (WhatsApp). Se abre desde el botón «+» del picker rápido del menú contextual;
/// aplica el emoji elegido por la misma ruta de reacción existente.
struct ReactionEmojiPickerSheet: View {
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    private static let emojis: [String] = [
        "❤️", "👍", "👎", "😂", "🤣", "😮",
        "😯", "😢", "😭", "🙏", "🔥", "🎉",
        "👏", "💯", "😍", "🥰", "😅", "🤔",
        "😎", "😊", "👌", "🙌", "💪", "✨",
        "⭐️", "💖", "😴", "🤯", "🥳", "😱",
        "🤩", "😤", "🫶", "🤝", "🙈", "😇",
        "🥲", "😜", "🤗", "😬", "😉", "🤞",
    ]

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: RistakTheme.Spacing.sm),
        count: 6
    )

    var body: some View {
        SheetScaffold(title: "Elegir reacción", subtitle: "Toca un emoji para reaccionar") {
            ScrollView {
                LazyVGrid(columns: columns, spacing: RistakTheme.Spacing.md) {
                    ForEach(Self.emojis, id: \.self) { emoji in
                        Button {
                            onSelect(emoji)
                            dismiss()
                        } label: {
                            Text(emoji)
                                .font(.system(size: 30))
                                .frame(maxWidth: .infinity, minHeight: 46)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Reaccionar con \(emoji)")
                    }
                }
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.top, RistakTheme.Spacing.sm)
                .padding(.bottom, RistakTheme.Spacing.xl)
            }
        }
    }
}
