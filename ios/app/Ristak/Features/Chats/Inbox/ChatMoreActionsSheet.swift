import SwiftUI

/// Acciones que el sheet «Más acciones» delega a la bandeja (doc 03 §4.4).
enum ChatMoreAction {
    case select
    case scheduleAppointment
    case registerPayment
    case scheduleMessage
    case addTag
    case toggleMute
    case markRead
    case toggleArchive
}

/// Sheet «Más acciones» de una fila de chat (long-press). Secciones: Agente
/// conversacional (si hay estados), Chat y Bandeja — copy exacto doc 03 §4.4.
struct ChatMoreActionsSheet: View {
    let contact: ChatContact
    let viewModel: InboxViewModel
    let onAction: (ChatMoreAction) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var agentStates: [ConversationAgentState] = []
    @State private var agentStatesLoaded = false
    @State private var isRunningAgentAction = false
    @State private var agentErrorMessage: String?

    private var isMuted: Bool { viewModel.localState.isMuted(contact.id) }
    private var isArchived: Bool { viewModel.localState.isArchived(contact.id) }

    var body: some View {
        SheetScaffold(title: "Más acciones", subtitle: ChatRowSignals.displayName(contact)) {
            List {
                if agentStatesLoaded, !agentStates.isEmpty {
                    agentSection
                }
                chatSection
                inboxSection
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .task {
            agentStates = (await viewModel.loadAgentStates(contactID: contact.id))
                .filter { $0.isAssignedExistingAgent }
            agentStatesLoaded = true
        }
        .alert("No se pudo actualizar el agente", isPresented: agentErrorBinding) {
            Button("Entendido", role: .cancel) {}
        } message: {
            Text(agentErrorMessage ?? "")
        }
    }

    // MARK: - Agente conversacional

    private var primaryAgentStatus: String {
        agentStates.first?.status.lowercased() ?? ""
    }

    private var agentIsActive: Bool {
        agentStates.contains { $0.status.lowercased() == "active" }
    }

    private var agentSection: some View {
        Section("Agente conversacional") {
            if agentIsActive {
                actionRow(
                    title: "Pausar agente",
                    subtitle: "Detiene el agente durante 24 horas.",
                    systemImage: "pause.circle"
                ) {
                    runAgentAction(.pause)
                }
                actionRow(
                    title: "Tomar chat",
                    subtitle: "Detiene al agente y deja esta conversación en humano.",
                    systemImage: "person.crop.circle.badge.checkmark"
                ) {
                    runAgentAction(.takeOver)
                }
                actionRow(
                    title: "Omitir agente",
                    subtitle: "El agente no vuelve a tomar este chat hasta reactivarlo.",
                    systemImage: "nosign",
                    isDestructive: true
                ) {
                    runAgentAction(.skip)
                }
            } else {
                actionRow(
                    title: "Continuar agente",
                    subtitle: "El agente vuelve a atender este chat.",
                    systemImage: "play.circle"
                ) {
                    runAgentAction(primaryAgentStatus == "paused" ? .resume : .activate)
                }
            }
        }
        .disabled(isRunningAgentAction)
    }

    private func runAgentAction(_ action: ConversationAgentAction) {
        guard !isRunningAgentAction else { return }
        isRunningAgentAction = true
        Task {
            let ok = await viewModel.performAgentAction(action, contactID: contact.id, states: agentStates)
            isRunningAgentAction = false
            if ok {
                dismiss()
            } else {
                agentErrorMessage = "Intenta otra vez en unos segundos."
            }
        }
    }

    private var agentErrorBinding: Binding<Bool> {
        Binding(
            get: { agentErrorMessage != nil },
            set: { if !$0 { agentErrorMessage = nil } }
        )
    }

    // MARK: - Chat

    private var chatSection: some View {
        Section("Chat") {
            // «Seleccionar» SIEMPRE es la primera acción de chat (doc 03 §4.4).
            actionRow(
                title: "Seleccionar",
                subtitle: "Activa selección múltiple desde esta conversación.",
                systemImage: "checkmark.circle"
            ) {
                finish(.select)
            }
            actionRow(
                title: "Agendar cita",
                subtitle: "Crear una cita para este contacto.",
                systemImage: "calendar.badge.plus"
            ) {
                finish(.scheduleAppointment)
            }
            actionRow(
                title: "Registrar pagos",
                subtitle: "Registrar un cobro para este contacto.",
                systemImage: "dollarsign.circle"
            ) {
                finish(.registerPayment)
            }
            actionRow(
                title: "Programar mensaje",
                subtitle: "Elige fecha y hora exacta de envío.",
                systemImage: "clock"
            ) {
                finish(.scheduleMessage)
            }
            actionRow(
                title: "Agregar etiqueta",
                subtitle: "Clasificar este chat con una etiqueta.",
                systemImage: "tag"
            ) {
                finish(.addTag)
            }
            actionRow(
                title: isMuted ? "Quitar silencio" : "Silenciar",
                subtitle: isMuted
                    ? "Quita la marca de silencio de este chat."
                    : "Marca este chat como silenciado.",
                systemImage: isMuted ? "bell" : "bell.slash"
            ) {
                finish(.toggleMute)
            }
        }
    }

    // MARK: - Bandeja

    private var inboxSection: some View {
        Section("Bandeja") {
            if contact.visibleUnreadCount > 0 {
                actionRow(
                    title: "Marcar como leído",
                    subtitle: "Quita los pendientes de esta conversación.",
                    systemImage: "envelope.open"
                ) {
                    finish(.markRead)
                }
            }
            actionRow(
                title: isArchived ? "Restaurar chat" : "Archivar chat",
                subtitle: isArchived
                    ? "Devuelve la conversación a la bandeja principal."
                    : "Mueve la conversación a Archivados.",
                systemImage: isArchived ? "tray.and.arrow.up" : "archivebox"
            ) {
                finish(.toggleArchive)
            }
        }
    }

    // MARK: - Helpers

    private func finish(_ action: ChatMoreAction) {
        dismiss()
        onAction(action)
    }

    private func actionRow(
        title: String,
        subtitle: String,
        systemImage: String,
        isDestructive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: systemImage)
                    .font(.body)
                    .foregroundStyle(isDestructive ? RistakTheme.neg : RistakTheme.accent)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(isDestructive ? RistakTheme.neg : RistakTheme.textPrimary)

                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(2)
                }
            }
        }
        .buttonStyle(.plain)
    }
}
