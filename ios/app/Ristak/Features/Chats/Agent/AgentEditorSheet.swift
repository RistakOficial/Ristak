import SwiftUI

/// Editor de un agente conversacional (modificar). Ajusta objetivo, identidad,
/// estilo, alcance e instrucciones — los campos "seguros" que no dependen del
/// goalWorkflow/filtros (que se configuran en el escritorio y se preservan
/// porque el PUT es parcial). Devuelve el agente actualizado vía `onSave`.
struct AgentEditorSheet: View {
    let agent: ConversationalAgentDef
    let onSave: (ConversationalAgentDef) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var objective: String
    @State private var customObjective: String
    @State private var identityMode: String
    @State private var identityCustomName: String
    @State private var persuasion: String
    @State private var language: String
    @State private var contactScope: String
    @State private var allowEmojis: Bool
    @State private var requiredData: String
    @State private var handoffRules: String
    @State private var extraInstructions: String

    @State private var isSaving = false
    @State private var errorMessage: String?

    init(agent: ConversationalAgentDef, onSave: @escaping (ConversationalAgentDef) -> Void) {
        self.agent = agent
        self.onSave = onSave
        _name = State(initialValue: agent.name)
        _objective = State(initialValue: agent.objective.isEmpty ? "datos" : agent.objective)
        _customObjective = State(initialValue: agent.customObjective)
        _identityMode = State(initialValue: agent.identityMode)
        _identityCustomName = State(initialValue: agent.identityCustomName)
        _persuasion = State(initialValue: agent.persuasionLevel)
        _language = State(initialValue: agent.languageLevel)
        _contactScope = State(initialValue: agent.contactScope)
        _allowEmojis = State(initialValue: agent.allowEmojis)
        _requiredData = State(initialValue: agent.requiredData)
        _handoffRules = State(initialValue: agent.handoffRules)
        _extraInstructions = State(initialValue: agent.extraInstructions)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmedName.isEmpty && !isSaving }

    var body: some View {
        SheetScaffold(title: "Editar agente", subtitle: agent.displayName) {
            SettingsPanelScroll {
                nameCard
                objectiveCard
                identityCard
                styleCard
                scopeCard
                instructionsCard
                saveButton
            }
        }
        .alert(
            "No se pudo guardar",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
        ) {
            Button("Entendido", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Intenta otra vez.")
        }
    }

    // MARK: - Cards

    private var nameCard: some View {
        SectionCard(title: "Nombre") {
            TextField("Nombre del agente", text: $name)
                .textInputAutocapitalization(.words)
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .stroke(RistakTheme.border, lineWidth: 1)
                )
        }
    }

    private var objectiveCard: some View {
        SectionCard(title: "Objetivo") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                ForEach(AgentObjectiveOption.allCases, id: \.self) { option in
                    SettingsRadioRow(
                        systemImage: objectiveIcon(option),
                        title: option.label,
                        subtitle: objectiveSubtitle(option),
                        isSelected: objective == option.rawValue
                    ) { objective = option.rawValue }
                }

                if objective == AgentObjectiveOption.custom.rawValue {
                    Text("Describe el objetivo")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                    agentTextEditor($customObjective, minHeight: 70, placeholder: "Ej. Reservar una llamada de demostración…")
                }
            }
        }
    }

    private var identityCard: some View {
        SectionCard(title: "Identidad") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                ForEach(AgentIdentityOption.allCases, id: \.self) { option in
                    SettingsRadioRow(
                        systemImage: identityIcon(option),
                        title: option.label,
                        subtitle: identitySubtitle(option),
                        isSelected: identityMode == option.rawValue
                    ) { identityMode = option.rawValue }
                }

                if identityMode == AgentIdentityOption.custom.rawValue {
                    TextField("Nombre con el que se presenta", text: $identityCustomName)
                        .padding(.horizontal, RistakTheme.Spacing.sm)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                                .fill(RistakTheme.surface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                                .stroke(RistakTheme.border, lineWidth: 1)
                        )
                }
            }
        }
    }

    private var styleCard: some View {
        SectionCard(title: "Estilo") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                labeledSegment(
                    "Nivel de persuasión",
                    options: AgentPersuasionOption.allCases.map { .init(id: $0.rawValue, title: $0.label) },
                    selectedID: persuasion
                ) { persuasion = $0 }

                labeledSegment(
                    "Tono del lenguaje",
                    options: AgentLanguageOption.allCases.map { .init(id: $0.rawValue, title: $0.label) },
                    selectedID: language
                ) { language = $0 }
            }
        }
    }

    private var scopeCard: some View {
        SectionCard(title: "Alcance") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                labeledSegment(
                    "A qué contactos atiende",
                    options: AgentContactScopeOption.allCases.map { .init(id: $0.rawValue, title: $0.label) },
                    selectedID: contactScope
                ) { contactScope = $0 }

                SettingsToggleRow(
                    title: "Permitir emojis",
                    subtitle: "El agente puede usar emojis al responder.",
                    isOn: allowEmojis
                ) { allowEmojis = $0 }
            }
        }
    }

    private var instructionsCard: some View {
        SectionCard(title: "Instrucciones") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                editorField("Datos que debe recopilar", text: $requiredData, placeholder: "Ej. nombre, presupuesto, ciudad…")
                editorField("Cuándo pasar a un humano", text: $handoffRules, placeholder: "Ej. si piden hablar con una persona…")
                editorField("Instrucciones extra", text: $extraInstructions, placeholder: "Tono, límites, información clave…")
            }
        }
    }

    private var saveButton: some View {
        Button {
            save()
        } label: {
            Group {
                if isSaving {
                    ProgressView().tint(RistakTheme.onAccent)
                } else {
                    Text("Guardar cambios")
                        .font(.body.weight(.semibold))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(RistakTheme.onAccent)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(canSave ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
            )
        }
        .buttonStyle(.plain)
        .disabled(!canSave)
        .padding(.top, RistakTheme.Spacing.xs)
    }

    // MARK: - Guardado

    private func save() {
        guard canSave else { return }
        isSaving = true
        let input = ConversationalAgentDefInput(
            name: trimmedName,
            objective: objective,
            customObjective: objective == AgentObjectiveOption.custom.rawValue ? customObjective : nil,
            identityMode: identityMode,
            identityCustomName: identityMode == AgentIdentityOption.custom.rawValue ? identityCustomName : nil,
            persuasionLevel: persuasion,
            languageLevel: language,
            contactScope: contactScope,
            allowEmojis: allowEmojis,
            requiredData: requiredData,
            handoffRules: handoffRules,
            extraInstructions: extraInstructions
        )
        Task {
            defer { isSaving = false }
            do {
                let updated = try await ConversationalAgentService.updateAgent(id: agent.id, input)
                onSave(updated)
                dismiss()
            } catch {
                errorMessage = friendlyMessage(error)
            }
        }
    }

    private func friendlyMessage(_ error: Error) -> String {
        guard let apiError = error as? RistakAPIError else { return "Intenta otra vez." }
        switch apiError.code {
        case ConversationalAgentErrorCode.businessPromptNotReady:
            return "Completa la descripción de tu negocio en Ajustes antes de guardar."
        case ConversationalAgentErrorCode.entryConflict:
            return "Otro agente ya cubre estas condiciones de entrada. Ajusta el objetivo o el alcance."
        case ConversationalAgentErrorCode.limitReached:
            return "Alcanzaste el máximo de agentes de tu plan."
        default:
            return apiError.message.isEmpty ? "Intenta otra vez." : apiError.message
        }
    }

    // MARK: - Piezas reutilizables

    private func labeledSegment(
        _ title: String,
        options: [SettingsSegmentTabs.Option],
        selectedID: String,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
            SettingsSegmentTabs(options: options, selectedID: selectedID, onSelect: onSelect)
        }
    }

    private func editorField(_ title: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
            agentTextEditor(text, minHeight: 76, placeholder: placeholder)
        }
    }

    private func agentTextEditor(_ text: Binding<String>, minHeight: CGFloat, placeholder: String) -> some View {
        ZStack(alignment: .topLeading) {
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textMute)
                    .padding(.horizontal, RistakTheme.Spacing.sm + 4)
                    .padding(.vertical, 12)
                    .allowsHitTesting(false)
            }
            TextEditor(text: text)
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textPrimary)
                .scrollContentBackground(.hidden)
                .frame(minHeight: minHeight)
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, 6)
        }
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .stroke(RistakTheme.border, lineWidth: 1)
        )
    }

    // MARK: - Íconos / subtítulos

    private func objectiveIcon(_ option: AgentObjectiveOption) -> String {
        switch option {
        case .citas: return "calendar"
        case .ventas: return "cart"
        case .datos: return "list.bullet.rectangle"
        case .filtrar: return "line.3.horizontal.decrease.circle"
        case .custom: return "wand.and.stars"
        }
    }

    private func objectiveSubtitle(_ option: AgentObjectiveOption) -> String {
        switch option {
        case .citas: return "Lleva la conversación hacia agendar una cita."
        case .ventas: return "Empuja hacia cerrar una venta o cobro."
        case .datos: return "Recolecta información del contacto."
        case .filtrar: return "Califica si el contacto es adecuado."
        case .custom: return "Tú defines la meta de la conversación."
        }
    }

    private func identityIcon(_ option: AgentIdentityOption) -> String {
        switch option {
        case .business: return "building.2"
        case .custom: return "person.text.rectangle"
        case .agent: return "cpu"
        }
    }

    private func identitySubtitle(_ option: AgentIdentityOption) -> String {
        switch option {
        case .business: return "Se presenta con el nombre de tu negocio."
        case .custom: return "Usa un nombre propio que tú definas."
        case .agent: return "Aclara que es un asistente virtual."
        }
    }
}
