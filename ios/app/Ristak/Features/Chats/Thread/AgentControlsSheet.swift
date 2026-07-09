import SwiftUI

/// Controles del agente conversacional para ESTA conversación (se abre desde el
/// botón robot del header). Estado + acciones por agente: Tomar / Pausar /
/// Omitir (activo) o Reactivar (inactivo), más descartar el aviso de objetivo
/// cumplido. Paridad con el sheet del /movil.
struct AgentControlsSheet: View {
    @Bindable var viewModel: ConversationViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetScaffold(title: "Agente", subtitle: viewModel.displayName) {
            SettingsPanelScroll {
                statusCard
                if let signal = viewModel.agentSignalState, AgentStatusStyle.signalMeta(signal.signal ?? "") != nil {
                    signalCard(signal)
                }
                actionsCard
            }
        }
    }

    // MARK: - Estado

    private var statusCard: some View {
        SectionCard {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: headerIcon)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(headerColor)
                    .frame(width: 40, height: 40)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                            .fill(RistakTheme.controlRest)
                    )
                Text(statusText)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if viewModel.agentActionInFlight || viewModel.clearingAgentSignal {
                    ProgressView().controlSize(.small)
                }
            }
        }
    }

    private var statusText: String {
        if viewModel.agentStates.count > 1 {
            return "\(viewModel.agentStates.count) agentes asignados a este chat."
        }
        let status = viewModel.primaryAgentState?.status ?? "active"
        return AgentStatusStyle.chatLabel(status)
    }

    private var headerIcon: String {
        AgentStatusStyle.icon(viewModel.primaryAgentState?.status ?? "active")
    }

    private var headerColor: Color {
        AgentStatusStyle.color(viewModel.primaryAgentState?.status ?? "active")
    }

    // MARK: - Aviso de objetivo cumplido (señal)

    private func signalCard(_ state: ConversationAgentState) -> some View {
        let meta = AgentStatusStyle.signalMeta(state.signal ?? "")
        return SectionCard {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    Image(systemName: meta?.icon ?? "checkmark.seal.fill")
                        .foregroundStyle(RistakTheme.pos)
                    Text(meta?.title ?? "Objetivo concretado")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                    Spacer(minLength: 0)
                }
                if let summary = state.signalSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                    Text(summary)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                }
                Button {
                    viewModel.clearAgentSignal()
                } label: {
                    Text("Descartar aviso")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.accent)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.clearingAgentSignal)
                .padding(.top, 2)
            }
        }
    }

    // MARK: - Acciones por agente

    private var actionsCard: some View {
        SectionCard(title: "Acciones") {
            VStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(Array(viewModel.agentStates.enumerated()), id: \.offset) { _, state in
                    agentActionGroup(state)
                }
            }
        }
    }

    @ViewBuilder
    private func agentActionGroup(_ state: ConversationAgentState) -> some View {
        let name = state.agentName ?? "Agente"
        if state.status.lowercased() == "active" {
            actionRow(title: "Tomar \(name)", subtitle: "Deja de responder y tú sigues el chat.", icon: "person.fill.checkmark") {
                run(.takeOver, state)
            }
            actionRow(title: "Pausar \(name)", subtitle: "Se detiene 24 horas en este chat.", icon: "pause.circle") {
                run(.pause, state)
            }
            actionRow(title: "Omitir \(name)", subtitle: "No vuelve a tomar este chat hasta reactivarlo.", icon: "nosign", isDestructive: true) {
                run(.skip, state)
            }
        } else {
            actionRow(title: "Reactivar \(name)", subtitle: AgentStatusStyle.chatLabel(state.status), icon: "play.circle") {
                run(.activate, state)
            }
        }
    }

    private func run(_ action: ConversationAgentAction, _ state: ConversationAgentState) {
        viewModel.performAgentAction(action, state: state)
        dismiss()
    }

    private func actionRow(
        title: String,
        subtitle: String,
        icon: String,
        isDestructive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isDestructive ? RistakTheme.neg : RistakTheme.accent)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(isDestructive ? RistakTheme.neg : RistakTheme.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(viewModel.agentActionInFlight)
    }
}
