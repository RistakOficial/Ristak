import SwiftUI

/// Hub del agente conversacional (se abre desde el botón robot de la bandeja).
/// Encender/apagar el agente completo, activar/pausar cada agente, reiniciar
/// omisiones y entrar a editar. Paridad con el "AI Agent Hub" del /movil.
struct AgentHubSheet: View {
    @State private var viewModel = AgentHubViewModel()
    @State private var editingAgent: ConversationalAgentDef?

    var body: some View {
        SheetScaffold(title: "Agente conversacional") {
            content
        }
        .task { await viewModel.load() }
        .alert(
            viewModel.alert?.title ?? "",
            isPresented: Binding(get: { viewModel.alert != nil }, set: { if !$0 { viewModel.alert = nil } }),
            presenting: viewModel.alert
        ) { _ in
            Button("Entendido", role: .cancel) { viewModel.alert = nil }
        } message: { alert in
            Text(alert.message)
        }
        .sheet(item: $editingAgent) { agent in
            AgentEditorSheet(agent: agent) { updated in
                viewModel.applyUpdatedAgent(updated)
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    private var alertBinding: Binding<AgentHubViewModel.HubAlert?> {
        Binding(get: { viewModel.alert }, set: { viewModel.alert = $0 })
    }

    // MARK: - Contenido por estado

    @ViewBuilder
    private var content: some View {
        switch viewModel.phase {
        case .loading:
            SettingsPanelScroll { EmptyView() }
        case .needsOpenAI(let reconnect):
            RistakEmptyState(
                icon: "key.horizontal",
                title: reconnect ? "Reconecta OpenAI" : "Conecta OpenAI",
                message: reconnect
                    ? "Tu conexión con OpenAI dejó de funcionar. Vuelve a conectarla en Ajustes → Asistente Personal AI para usar el agente."
                    : "Conecta tu API key de OpenAI en Ajustes → Asistente Personal AI para activar el agente conversacional."
            )
        case .accessDenied:
            SettingsAccessDeniedView(message: "No tienes acceso al agente conversacional.")
        case .failed(let message):
            RistakErrorState(message: message) { viewModel.retry() }
        case .ready:
            readyContent
        }
    }

    private var readyContent: some View {
        SettingsPanelScroll {
            globalCard
            if !viewModel.businessPromptReady {
                businessPromptNotice
            }
            agentsCard
        }
    }

    // MARK: - Interruptor global

    private var globalCard: some View {
        SectionCard {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: "sparkles")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(RistakTheme.accent)
                    .frame(width: 42, height: 42)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                            .fill(RistakTheme.accentSoft)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Agente conversacional")
                        .font(.headline)
                        .foregroundStyle(RistakTheme.textPrimary)
                    Text(globalSubtitle)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                if viewModel.globalSaving {
                    ProgressView().controlSize(.small)
                }

                Toggle("", isOn: Binding(
                    get: { viewModel.globalEnabled },
                    set: { viewModel.setGlobalEnabled($0) }
                ))
                .labelsHidden()
                .tint(RistakTheme.accent)
                .disabled(viewModel.globalSaving)
                .accessibilityLabel("Encender el agente conversacional")
            }
        }
    }

    private var globalSubtitle: String {
        if viewModel.globalEnabled {
            let n = viewModel.publishedCount
            return n == 1 ? "1 agente atendiendo chats" : "\(n) agentes atendiendo chats"
        }
        return "Apagado — ningún chat se responde solo."
    }

    private var businessPromptNotice: some View {
        SectionCard {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(RistakTheme.warn)
                Text("Completa la descripción de tu negocio en Ajustes → Asistente Personal AI para poder encender el agente.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: - Lista de agentes

    @ViewBuilder
    private var agentsCard: some View {
        if viewModel.agents.isEmpty {
            SectionCard(title: "Agentes") {
                Text("Aún no hay agentes. Créalos desde el panel de escritorio; aquí podrás encenderlos, pausarlos y ajustarlos.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            SectionCard(title: "Agentes") {
                VStack(spacing: 0) {
                    ForEach(Array(viewModel.agents.enumerated()), id: \.element.id) { index, agent in
                        if index > 0 {
                            Divider().overlay(RistakTheme.border)
                        }
                        agentRow(agent)
                    }
                }
            }
        }
    }

    private func agentRow(_ agent: ConversationalAgentDef) -> some View {
        let enabled = viewModel.isAgentEnabled(agent)
        return HStack(spacing: RistakTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 3) {
                Text(agent.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)
                Text(enabled ? "Activo" : "Pausado")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(enabled ? RistakTheme.pos : RistakTheme.warn)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(RistakTheme.controlRest))
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            if viewModel.savingAgentIDs.contains(agent.id) || viewModel.resettingAgentIDs.contains(agent.id) {
                ProgressView().controlSize(.small)
            }

            Toggle("", isOn: Binding(
                get: { viewModel.isAgentEnabled(agent) },
                set: { viewModel.setAgentEnabled(agent, enabled: $0) }
            ))
            .labelsHidden()
            .tint(RistakTheme.accent)
            .disabled(viewModel.savingAgentIDs.contains(agent.id))
            .accessibilityLabel("Activar \(agent.displayName)")

            Menu {
                Button {
                    editingAgent = agent
                } label: {
                    Label("Editar agente", systemImage: "slider.horizontal.3")
                }
                Button {
                    viewModel.resetSkipped(agent)
                } label: {
                    Label("Reiniciar omisiones", systemImage: "arrow.counterclockwise")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(RistakTheme.textDim)
            }
            .accessibilityLabel("Más acciones de \(agent.displayName)")
        }
        .padding(.vertical, RistakTheme.Spacing.xs)
    }
}
