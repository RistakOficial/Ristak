import SwiftUI

// MARK: - Fila de chat (doc research/03 §4.3)

struct ChatRowView: View {
    let contact: ChatContact
    let formatters: BusinessFormatters
    let showPreview: Bool
    let showUnreadIndicators: Bool
    let isMuted: Bool
    let isSelecting: Bool
    let isSelected: Bool
    /// Fila activa resaltada (iPad/wide).
    let isActive: Bool
    /// Nombres de etiquetas del contacto (máx 2 se pintan).
    let tagNames: [String]

    var body: some View {
        HStack(alignment: .center, spacing: RistakTheme.Spacing.sm) {
            if isSelecting {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? RistakTheme.accent : RistakTheme.textMute)
                    .accessibilityHidden(true)
            }

            ContactAvatarView(
                name: ChatRowSignals.displayName(contact),
                photoURL: contact.profilePhotoUrl.flatMap(URL.init(string:)),
                size: 48,
                channel: ChatRowSignals.badgeChannel(contact)
            )

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.xs) {
                    Text(ChatRowSignals.displayName(contact))
                        .font(.body.weight(hasVisibleUnread ? .semibold : .regular))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    if showUnreadIndicators {
                        Text(relativeDate)
                            .font(.caption)
                            .foregroundStyle(hasVisibleUnread ? RistakTheme.accent : RistakTheme.textDim)
                            .monospacedDigit()
                    }
                }

                HStack(alignment: .center, spacing: RistakTheme.Spacing.xs) {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(2)

                    Spacer(minLength: 0)

                    if contact.hasCommentMessage {
                        Image(systemName: "text.bubble")
                            .font(.caption)
                            .foregroundStyle(RistakTheme.info)
                            .accessibilityLabel("Tiene comentarios")
                    }

                    if isMuted {
                        Image(systemName: "bell.slash.fill")
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textMute)
                            .accessibilityLabel("Silenciado")
                    }

                    if showUnreadIndicators, hasVisibleUnread {
                        Text(contact.visibleUnreadCount > 9 ? "9+" : "\(contact.visibleUnreadCount)")
                            .font(.caption2.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(RistakTheme.onAccent)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(RistakTheme.accent))
                            .accessibilityLabel("\(contact.visibleUnreadCount) mensajes sin leer")
                    }
                }

                if !tagNames.isEmpty {
                    HStack(spacing: RistakTheme.Spacing.xxs) {
                        ForEach(tagNames.prefix(2), id: \.self) { name in
                            TagPillView(text: name)
                        }
                        if tagNames.count > 2 {
                            Text("+\(tagNames.count - 2)")
                                .font(.caption2)
                                .foregroundStyle(RistakTheme.textMute)
                        }
                    }
                }
            }
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
        .contentShape(Rectangle())
        .listRowBackground(rowBackground)
        .accessibilityElement(children: .combine)
    }

    private var hasVisibleUnread: Bool {
        showUnreadIndicators && contact.visibleUnreadCount > 0
    }

    private var subtitle: String {
        if showPreview {
            let preview = ChatRowSignals.preview(contact)
            if !preview.isEmpty { return preview }
        }
        return ChatRowSignals.contactDetailSubtitle(contact)
    }

    private var relativeDate: String {
        formatters.inboxRelativeDate(fromISO: contact.lastMessageDate ?? contact.createdAt)
    }

    private var rowBackground: Color {
        if isActive { return RistakTheme.accentSoft }
        return .clear
    }
}

// MARK: - Fila fija «Asistente Personal AI» (doc 03 §4.2.3)

struct AssistantChatRow: View {
    var body: some View {
        HStack(alignment: .center, spacing: RistakTheme.Spacing.sm) {
            Image(systemName: "sparkles")
                .font(.title3.weight(.semibold))
                .foregroundStyle(RistakTheme.accent)
                .frame(width: 48, height: 48)
                .background(Circle().fill(RistakTheme.accentSoft))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text("Asistente Personal AI")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)

                Text("Pregúntame lo que necesites de Ristak.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            Text("Fijo")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(RistakTheme.textDim)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(RistakTheme.controlRest))
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Asistente Personal AI, fijo")
    }
}

// MARK: - Fila «Archivados» (doc 03 §4.2.5)

struct ArchivedAccessRow: View {
    let count: Int
    /// `true` = dentro de la vista archivados («‹ Archivados n», tap = volver).
    let isBackRow: Bool

    var body: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Image(systemName: isBackRow ? "chevron.backward" : "archivebox")
                .font(.body.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
                .frame(width: 30)

            Text("Archivados")
                .font(.body.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)

            Spacer(minLength: 0)

            if count > 0 {
                Text("\(count)")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textDim)
            }
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isBackRow ? "Volver de archivados" : "Archivados, \(count)")
    }
}

// MARK: - Píldora de cache-refresh (doc 03 §4.9)

struct CacheRefreshPillRow: View {
    var body: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            ProgressView()
                .controlSize(.mini)
            Text("Mostrando lo guardado, actualizando chats")
                .font(.caption)
                .foregroundStyle(RistakTheme.textDim)
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, 6)
        .background(Capsule().fill(RistakTheme.controlRest))
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Panel de selección múltiple (doc 03 §4.7)

struct ChatSelectionPanel: View {
    let selectedCount: Int
    let allVisibleSelected: Bool
    let isArchivedView: Bool
    let onMarkRead: () -> Void
    let onArchiveOrRestore: () -> Void
    let onToggleSelectVisible: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            HStack {
                Text(selectedCount == 1 ? "1 seleccionado" : "\(selectedCount) seleccionados")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)

                Spacer()

                Button("Cancelar", action: onCancel)
                    .font(.subheadline)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    panelButton("Marcar como leídos", systemImage: "checkmark.circle", action: onMarkRead)
                        .disabled(selectedCount == 0)

                    panelButton(
                        isArchivedView ? "Restaurar chats" : "Archivar chats",
                        systemImage: isArchivedView ? "tray.and.arrow.up" : "archivebox",
                        action: onArchiveOrRestore
                    )
                    .disabled(selectedCount == 0)

                    panelButton(
                        allVisibleSelected ? "Deseleccionar visibles" : "Seleccionar visibles",
                        systemImage: allVisibleSelected ? "square.dashed" : "checklist",
                        action: onToggleSelectVisible
                    )
                }
            }
        }
        .padding(.vertical, RistakTheme.Spacing.xs)
    }

    private func panelButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, 7)
                .background(Capsule().fill(RistakTheme.controlRest))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Placeholder del asistente

/// Detalle del chat del Asistente Personal AI (módulo aparte — placeholder).
struct AssistantComingSoonScreen: View {
    var body: some View {
        RistakEmptyState(
            icon: "sparkles",
            title: "Próximamente",
            message: "El Asistente Personal AI estará disponible aquí muy pronto."
        )
        .navigationTitle("Asistente Personal AI")
        .navigationBarTitleDisplayMode(.inline)
    }
}
