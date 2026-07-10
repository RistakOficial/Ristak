import SwiftUI

/// Editor de un agente conversacional. Mantiene el mismo orden del formulario web:
/// 1) Personalidad, 2) operación técnica, 3) objetivo/cierre, 4) reglas,
/// 5) entrada/salida. El PUT sigue siendo parcial, pero aquí mandamos la
/// configuración completa que el usuario puede tocar en iOS para no perder
/// `goalWorkflow`, `followUp`, `replyDelivery`, `filters` ni acciones extra.
struct AgentEditorSheet: View {
    let agent: ConversationalAgentDef
    let onSave: (ConversationalAgentDef) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(AppConfigStore.self) private var appConfig

    @State private var name: String
    @State private var aiProvider: String
    @State private var model: String
    @State private var identityMode: String
    @State private var identityUserId: String
    @State private var identityUserName: String
    @State private var identityCustomName: String
    @State private var persuasion: String
    @State private var language: String
    @State private var extraInstructions: String

    @State private var responseDelay: AgentResponseDelayConfig
    @State private var replyDelivery: AgentReplyDeliveryConfig
    @State private var hideAttendedNotifications: Bool
    @State private var followUp: AgentFollowUpConfig

    @State private var objective: String
    @State private var customObjective: String
    @State private var successAction: String
    @State private var successExtras: [AgentSuccessExtra]
    @State private var goalWorkflow: AgentGoalWorkflowConfig

    @State private var requiredData: String
    @State private var handoffRules: String
    @State private var requiredDataOpen: Bool
    @State private var handoffRulesOpen: Bool

    @State private var contactScope: String
    @State private var filters: AgentFilters
    @State private var allowEmojis: Bool

    @State private var calendars: [RistakCalendar] = []
    @State private var teamUsers: [CalendarUser] = []
    @State private var filterOptions: AgentFilterOptions = .empty
    @State private var referenceLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(agent: ConversationalAgentDef, onSave: @escaping (ConversationalAgentDef) -> Void) {
        self.agent = agent
        self.onSave = onSave
        _name = State(initialValue: agent.name)
        _aiProvider = State(initialValue: agent.aiProvider)
        _model = State(initialValue: agent.model)
        _identityMode = State(initialValue: agent.identityMode)
        _identityUserId = State(initialValue: agent.identityUserId)
        _identityUserName = State(initialValue: agent.identityUserName)
        _identityCustomName = State(initialValue: agent.identityCustomName)
        _persuasion = State(initialValue: agent.persuasionLevel)
        _language = State(initialValue: agent.languageLevel)
        _extraInstructions = State(initialValue: agent.extraInstructions)
        _responseDelay = State(initialValue: agent.responseDelay)
        _replyDelivery = State(initialValue: agent.replyDelivery)
        _hideAttendedNotifications = State(initialValue: agent.hideAttendedNotifications)
        _followUp = State(initialValue: agent.followUp)
        _objective = State(initialValue: agent.objective.isEmpty ? AgentObjectiveOption.citas.rawValue : agent.objective)
        _customObjective = State(initialValue: agent.customObjective)
        _successAction = State(initialValue: agent.successAction)
        _successExtras = State(initialValue: agent.successExtras)
        _goalWorkflow = State(initialValue: agent.goalWorkflow)
        _requiredData = State(initialValue: agent.requiredData)
        _handoffRules = State(initialValue: agent.handoffRules)
        _requiredDataOpen = State(initialValue: !agent.requiredData.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        _handoffRulesOpen = State(initialValue: !agent.handoffRules.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        _contactScope = State(initialValue: agent.contactScope)
        _filters = State(initialValue: agent.filters)
        _allowEmojis = State(initialValue: agent.allowEmojis)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmedName.isEmpty && !isSaving }
    private var selectedProvider: AgentAIProviderOption { AgentAIProviderCatalog.option(for: aiProvider) }
    private var selectedModelLabel: String { AgentAIProviderCatalog.modelLabel(provider: aiProvider, model: model) }
    private var humanMessagesEnabled: Bool { replyDelivery.splitMessagesEnabled || replyDelivery.mode == AgentReplyDeliveryModeOption.split.rawValue }
    private var entryRulesCount: Int { filters.entry.groups.reduce(0) { $0 + $1.conditions.count } }
    private var exitRulesCount: Int { filters.exit.groups.reduce(0) { $0 + $1.conditions.count } }

    var body: some View {
        SheetScaffold(title: "Editar agente", subtitle: agent.displayName) {
            SettingsPanelScroll {
                headerCard
                personalitySection
                technicalSection
                objectiveSection
                rulesSection
                entryExitSection
                saveButton
            }
        }
        .task { await loadReferenceData() }
        .alert(
            "No se pudo guardar",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
        ) {
            Button("Entendido", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Intenta otra vez.")
        }
    }

    // MARK: - 1. Personalidad e instrucciones

    private var headerCard: some View {
        SectionCard {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    AgentBotGlyph(color: agent.enabled ? RistakTheme.accent : RistakTheme.textDim, size: 28)
                        .frame(width: 42, height: 42)
                        .background(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                                .fill(agent.enabled ? RistakTheme.accentSoft : RistakTheme.controlRest)
                        )
                    VStack(alignment: .leading, spacing: 4) {
                        Text(agent.enabled ? "Publicado" : "En pausa")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(agent.enabled ? RistakTheme.pos : RistakTheme.warn)
                        Text(agentSummary)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                textField("Nombre del agente", text: $name, placeholder: "Nombre del agente")
            }
        }
    }

    private var personalitySection: some View {
        SectionCard(title: "1. Personalidad e instrucciones") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                menuField(
                    "¿Cómo quieres que se identifique el agente?",
                    selected: identityLabel,
                    options: AgentIdentityOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                ) { next in
                    identityMode = next
                    if next != AgentIdentityOption.user.rawValue {
                        identityUserId = ""
                        identityUserName = ""
                    }
                    if next != AgentIdentityOption.custom.rawValue {
                        identityCustomName = ""
                    }
                }

                if identityMode == AgentIdentityOption.user.rawValue {
                    menuField(
                        "Persona visible",
                        selected: identityUserName.isEmpty ? "Elegir persona" : identityUserName,
                        options: userChoices
                    ) { userId in
                        let user = teamUsers.first(where: { $0.resolvedID == userId })
                        identityUserId = user?.resolvedID ?? ""
                        identityUserName = user?.displayLabel ?? ""
                    }
                    textField("Nombre visible manual", text: $identityUserName, placeholder: "Nombre de la persona")
                }

                if identityMode == AgentIdentityOption.custom.rawValue {
                    textField("Nombre visible", text: $identityCustomName, placeholder: "Ej. Marcos, Raúl o Robot 34")
                }

                labeledSegment(
                    "Qué tan persuasivo debe ser",
                    options: AgentPersuasionOption.allCases.map { .init(id: $0.rawValue, title: $0.label) },
                    selectedID: persuasion
                ) { persuasion = $0 }

                labeledSegment(
                    "Cómo debe hablar",
                    options: AgentLanguageOption.allCases.map { .init(id: $0.rawValue, title: $0.label) },
                    selectedID: language
                ) { language = $0 }

                editorField(
                    "Personalización y capacitación del asistente",
                    text: $extraInstructions,
                    minHeight: 120,
                    placeholder: "Reglas del negocio, límites, información clave y casos especiales."
                )

                SettingsToggleRow(
                    title: "Puede usar emojis",
                    subtitle: "Déjalo apagado si quieres un tono más serio.",
                    isOn: allowEmojis
                ) { allowEmojis = $0 }
            }
        }
    }

    // MARK: - 2. Operación técnica del chat

    private var technicalSection: some View {
        SectionCard(title: "2. Operación técnica del chat") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                menuField(
                    "¿Qué IA va a contestar?",
                    selected: selectedProvider.label,
                    options: AgentAIProviderCatalog.providers.map { PickerChoice(id: $0.id, title: $0.label) }
                ) { provider in
                    aiProvider = AgentAIProviderCatalog.knownProvider(provider)
                    model = AgentAIProviderCatalog.defaultModel(provider: aiProvider)
                }

                menuField(
                    "¿Qué modelo de \(selectedProvider.label) va a usar?",
                    selected: selectedModelLabel,
                    options: selectedProvider.models.map { PickerChoice(id: $0.id, title: $0.label) }
                ) { nextModel in
                    model = nextModel
                }

                responseDelayControls
                replyDeliveryControls

                menuField(
                    "¿Quieres recibir notificaciones mientras el agente IA toma la conversación?",
                    selected: hideAttendedNotifications ? "No" : "Sí",
                    options: [
                        PickerChoice(id: "keep_visible", title: "Sí"),
                        PickerChoice(id: "mute_only", title: "No")
                    ]
                ) { value in
                    hideAttendedNotifications = value == "mute_only"
                }

                followUpControls
            }
        }
    }

    private var responseDelayControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            menuField(
                "¿Cuánto debe esperar antes de contestar?",
                selected: AgentResponseDelayModeOption(rawValue: responseDelay.mode)?.label ?? "No esperar",
                options: AgentResponseDelayModeOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
            ) { responseDelay.mode = $0 }

            if responseDelay.mode == AgentResponseDelayModeOption.fixed.rawValue {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    numberField("Tiempo", value: intText($responseDelay.fixedValue, min: 0))
                    menuField(
                        "Unidad",
                        selected: delayUnitLabel(responseDelay.fixedUnit),
                        options: AgentResponseDelayUnitOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                    ) { responseDelay.fixedUnit = $0 }
                }
            }

            if responseDelay.mode == AgentResponseDelayModeOption.random.rawValue {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    numberField("Mínimo", value: intText($responseDelay.minValue, min: 0))
                    numberField("Máximo", value: intText($responseDelay.maxValue, min: 0))
                }
                menuField(
                    "Unidad",
                    selected: delayUnitLabel(responseDelay.rangeUnit),
                    options: AgentResponseDelayUnitOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                ) { responseDelay.rangeUnit = $0 }
            }
        }
    }

    private var replyDeliveryControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            SettingsToggleRow(
                title: "¿Quieres que mande mensajes como persona?",
                subtitle: "Divide respuestas largas y puede pausar entre globos.",
                isOn: humanMessagesEnabled
            ) { enabled in
                replyDelivery.mode = enabled ? AgentReplyDeliveryModeOption.split.rawValue : AgentReplyDeliveryModeOption.single.rawValue
                replyDelivery.splitMessagesEnabled = enabled
                if enabled {
                    replyDelivery.delayBetweenBubblesEnabled = true
                }
            }

            if humanMessagesEnabled {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    numberField("Pausa mínima", value: intText($replyDelivery.minDelaySeconds, min: 0, max: 60))
                    numberField("Pausa máxima", value: intText($replyDelivery.maxDelaySeconds, min: 0, max: 60))
                }
            }
        }
    }

    private var followUpControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            SettingsToggleRow(
                title: "¿Quieres mandar un recordatorio?",
                subtitle: "Sólo se manda si la persona no responde.",
                isOn: followUp.enabled
            ) { enabled in
                followUp.enabled = enabled
                followUp.first.enabled = true
                followUp.second.enabled = enabled ? followUp.second.enabled : false
                if followUp.strategy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    followUp.strategy = AgentFollowUpConfig.defaultStrategy
                }
            }

            if followUp.enabled {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    numberField("Primer tiempo", value: intText($followUp.first.value, min: 1, max: followUpMaxValue(followUp.first.unit)))
                    menuField(
                        "Unidad",
                        selected: followUpUnitLabel(followUp.first.unit),
                        options: AgentFollowUpUnitOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                    ) { followUp.first.unit = $0 }
                }

                SettingsToggleRow(
                    title: "¿Quieres mandar un segundo recordatorio?",
                    subtitle: "Sólo sale si todavía no responde.",
                    isOn: followUp.second.enabled
                ) { followUp.second.enabled = $0 }

                if followUp.second.enabled {
                    HStack(spacing: RistakTheme.Spacing.sm) {
                        numberField("Segundo tiempo", value: intText($followUp.second.value, min: 1, max: followUpMaxValue(followUp.second.unit)))
                        menuField(
                            "Unidad",
                            selected: followUpUnitLabel(followUp.second.unit),
                            options: AgentFollowUpUnitOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                        ) { followUp.second.unit = $0 }
                    }
                }

                editorField(
                    "Qué debe decir en el recordatorio",
                    text: $followUp.strategy,
                    minHeight: 92,
                    placeholder: "Ej. retoma lo último que dijo y abre con una pregunta corta."
                )
            }
        }
    }

    // MARK: - 3. Objetivo y cierre

    private var objectiveSection: some View {
        SectionCard(title: "3. Objetivo y cierre") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                menuField(
                    "¿Cuál es la meta?",
                    selected: AgentObjectiveOption(rawValue: objective)?.label ?? "Agendar citas",
                    options: AgentObjectiveOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                ) { next in
                    objective = next
                    ensureValidSuccessAction()
                }

                menuField(
                    goalExecutionQuestion,
                    selected: successActionLabel,
                    options: successActionChoices
                ) { next in
                    successAction = next
                    applyGoalOwner(for: next)
                }

                goalWorkflowControls

                if objective == AgentObjectiveOption.custom.rawValue {
                    editorField(
                        "Objetivo escrito a mano",
                        text: $customObjective,
                        minHeight: 70,
                        placeholder: "Ej. que pida una propuesta formal para su empresa."
                    )
                }

                completionControls
                successExtrasControls
            }
        }
    }

    @ViewBuilder
    private var goalWorkflowControls: some View {
        if objective == AgentObjectiveOption.citas.rawValue {
            appointmentGoalControls
        } else if objective == AgentObjectiveOption.ventas.rawValue {
            salesGoalControls
        } else if objective == AgentObjectiveOption.filtrar.rawValue {
            qualificationControls
        } else if successAction == AgentSuccessActionOption.sendTriggerLink.rawValue {
            triggerLinkControls
        }
    }

    private var appointmentGoalControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            // El calendario es obligatorio para citas sin importar quién cumple la
            // meta: el agente lo usa para ofrecer los espacios disponibles.
            menuField(
                "Calendario",
                selected: goalCalendarName(goalWorkflow.appointments.calendarId ?? agent.defaultCalendarId),
                options: goalCalendarChoices
            ) { calendarId in
                let selected = calendarId.isEmpty ? nil : calendarId
                goalWorkflow.appointments.calendarId = selected
            }

            if successAction == AgentSuccessActionOption.bookAppointment.rawValue ||
                successAction == AgentSuccessActionOption.sendGoalURL.rawValue {
                SettingsToggleRow(
                    title: "Permitir mismo horario",
                    subtitle: "Úsalo sólo si tu operación acepta citas sobrepuestas.",
                    isOn: goalWorkflow.appointments.allowOverlappingAppointments
                ) { goalWorkflow.appointments.allowOverlappingAppointments = $0 }
            }

            if successAction == AgentSuccessActionOption.bookAppointment.rawValue {
                depositControls
            }

            if successAction == AgentSuccessActionOption.sendGoalURL.rawValue {
                textField("Enlace del calendario", text: $goalWorkflow.appointments.url, placeholder: "https://calendly.com/tu-negocio/cita")
                textField("ID que se agrega al enlace", text: $goalWorkflow.appointments.trackingParam, placeholder: "ristak_goal_id")
            }
        }
    }

    private var salesGoalControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            if successAction == AgentSuccessActionOption.readyToBuy.rawValue {
                menuField(
                    "Cómo cobra",
                    selected: AgentSalesPaymentModeOption(rawValue: goalWorkflow.sales.paymentMode)?.label ?? "Venta completa",
                    options: AgentSalesPaymentModeOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                ) { paymentMode in
                    goalWorkflow.sales.paymentMode = paymentMode
                    goalWorkflow.deposit.enabled = paymentMode == AgentSalesPaymentModeOption.deposit.rawValue
                    ensureWorkflowCurrency()
                }
                textField("Producto", text: $goalWorkflow.sales.productName, placeholder: "Nombre del producto o servicio")
                textField("Precio", text: $goalWorkflow.sales.priceName, placeholder: "Plan, paquete o precio")
                HStack(spacing: RistakTheme.Spacing.sm) {
                    numberField("Monto", value: doubleText($goalWorkflow.sales.amount))
                    textField("Moneda", text: $goalWorkflow.sales.currency, placeholder: appConfig.accountCurrency ?? "Cuenta")
                }
                depositControls
            }

            if successAction == AgentSuccessActionOption.sendGoalURL.rawValue {
                textField("Enlace del pedido", text: $goalWorkflow.sales.url, placeholder: "https://tutienda.com/checkout")
                textField("ID que se agrega al enlace", text: $goalWorkflow.sales.trackingParam, placeholder: "ristak_goal_id")
            }
        }
    }

    private var depositControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            SettingsToggleRow(
                title: "Pedir anticipo",
                subtitle: "La IA pide comprobante antes de avanzar.",
                isOn: goalWorkflow.deposit.enabled
            ) { enabled in
                goalWorkflow.deposit.enabled = enabled
                // El modo de venta sólo existe en el objetivo de ventas; en citas
                // el anticipo vive únicamente en deposit.enabled.
                if objective == AgentObjectiveOption.ventas.rawValue {
                    goalWorkflow.sales.paymentMode = enabled ? AgentSalesPaymentModeOption.deposit.rawValue : AgentSalesPaymentModeOption.full_payment.rawValue
                }
                if enabled { ensureWorkflowCurrency() }
            }
            if goalWorkflow.deposit.enabled {
                menuField(
                    "Tipo de anticipo",
                    selected: AgentDepositModeOption(rawValue: goalWorkflow.deposit.mode)?.label ?? "Valor único",
                    options: AgentDepositModeOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                ) { goalWorkflow.deposit.mode = $0 }
                if goalWorkflow.deposit.mode == AgentDepositModeOption.range.rawValue {
                    HStack(spacing: RistakTheme.Spacing.sm) {
                        numberField("Mínimo", value: doubleText($goalWorkflow.deposit.minAmount))
                        numberField("Máximo", value: doubleText($goalWorkflow.deposit.maxAmount))
                    }
                } else {
                    numberField("Anticipo", value: doubleText($goalWorkflow.deposit.amount))
                }
                textField("Moneda del anticipo", text: $goalWorkflow.deposit.currency, placeholder: appConfig.accountCurrency ?? "Cuenta")

                depositMethodControls
            }
        }
    }

    private var depositMethodControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            Text("Cómo puede pagar el anticipo")
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)

            SettingsToggleRow(
                title: "Link de pago",
                subtitle: "La IA manda un link para pagar el anticipo.",
                isOn: goalWorkflow.deposit.methods.paymentLink
            ) { goalWorkflow.deposit.methods.paymentLink = $0 }

            SettingsToggleRow(
                title: "Transferencia bancaria",
                subtitle: "La IA comparte tus datos bancarios para el anticipo.",
                isOn: goalWorkflow.deposit.methods.bankTransfer
            ) { goalWorkflow.deposit.methods.bankTransfer = $0 }

            if !goalWorkflow.deposit.methods.paymentLink && !goalWorkflow.deposit.methods.bankTransfer {
                Text("Activa al menos un método para cobrar el anticipo.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.neg)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if goalWorkflow.deposit.methods.bankTransfer {
                editorField(
                    "Datos para transferencia",
                    text: bankTransferDetailsBinding,
                    minHeight: 88,
                    placeholder: "Banco, CLABE o cuenta, titular…"
                )
                Text("El agente compartirá estos datos y pedirá foto del comprobante.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Binding con tope de 1200 caracteres (mismo límite que el backend).
    private var bankTransferDetailsBinding: Binding<String> {
        Binding(
            get: { goalWorkflow.deposit.bankTransferDetails },
            set: { goalWorkflow.deposit.bankTransferDetails = String($0.prefix(1200)) }
        )
    }

    private var qualificationControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            editorField("Qué preguntas debe hacer", text: $goalWorkflow.qualification.questions, minHeight: 88, placeholder: "Ej. problema, urgencia, presupuesto.")
            editorField("Qué lo califica", text: $goalWorkflow.qualification.qualifies, minHeight: 70, placeholder: "Ej. tiene necesidad real y quiere avanzar.")
            editorField("Qué lo descalifica", text: $goalWorkflow.qualification.disqualifies, minHeight: 70, placeholder: "Ej. sólo pide gratis o está fuera del servicio.")
        }
    }

    private var triggerLinkControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            textField("Nombre del enlace", text: $goalWorkflow.triggerLink.triggerLinkName, placeholder: "Formulario, página o WhatsApp")
            textField("URL del enlace", text: $goalWorkflow.triggerLink.triggerLinkUrl, placeholder: "https://...")
        }
    }

    private var completionControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            menuField(
                "Cuando la IA cumpla el objetivo, ¿qué debe pasar?",
                selected: AgentCompletionModeOption(rawValue: goalWorkflow.completion.mode)?.label ?? "Pasar a humano y notificar",
                options: AgentCompletionModeOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
            ) { mode in
                goalWorkflow.completion.mode = mode
                if mode != AgentCompletionModeOption.assign_user.rawValue {
                    goalWorkflow.completion.userId = ""
                    goalWorkflow.completion.userName = ""
                }
            }
            if goalWorkflow.completion.mode == AgentCompletionModeOption.assign_user.rawValue {
                menuField(
                    "Usuario asignado",
                    selected: goalWorkflow.completion.userName.isEmpty ? "Elegir usuario" : goalWorkflow.completion.userName,
                    options: userChoices
                ) { userId in
                    let user = teamUsers.first(where: { $0.resolvedID == userId })
                    goalWorkflow.completion.userId = user?.resolvedID ?? ""
                    goalWorkflow.completion.userName = user?.displayLabel ?? ""
                }
                textField("Usuario manual", text: $goalWorkflow.completion.userName, placeholder: "Nombre del responsable")
            }
        }
    }

    private var successExtrasControls: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            Text("Cosas extra al terminar")
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)

            ForEach(successExtras.indices, id: \.self) { index in
                successExtraRow(index)
            }

            Button {
                successExtras.append(AgentSuccessExtra(type: AgentSuccessExtraOption.add_tag.rawValue))
            } label: {
                Label("Añadir acción", systemImage: "plus")
                    .font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
        }
    }

    private func successExtraRow(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            menuField(
                "Acción",
                selected: AgentSuccessExtraOption(rawValue: successExtras[index].type)?.label ?? "Agregar etiqueta",
                options: AgentSuccessExtraOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
            ) { value in
                successExtras[index].type = value
            }

            if successExtras[index].type == AgentSuccessExtraOption.set_custom_field.rawValue {
                textField("Campo", text: $successExtras[index].field, placeholder: "Campo personalizado")
                textField("Valor", text: $successExtras[index].value, placeholder: "Valor a guardar")
            } else {
                textField("Etiqueta", text: $successExtras[index].tag, placeholder: "Nombre o ID de etiqueta")
            }

            Button(role: .destructive) {
                successExtras.remove(at: index)
            } label: {
                Label("Quitar acción", systemImage: "trash")
                    .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.bordered)
        }
        .padding(RistakTheme.Spacing.sm)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.surface2)
        )
    }

    // MARK: - 4. Reglas de atención

    private var rulesSection: some View {
        SectionCard(title: "4. Reglas de atención") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                SettingsToggleRow(
                    title: "¿Debe pedir algún dato?",
                    subtitle: "Si ya lo tiene, no lo vuelve a pedir.",
                    isOn: requiredDataOpen
                ) { enabled in
                    requiredDataOpen = enabled
                    if !enabled { requiredData = "" }
                }
                if requiredDataOpen {
                    editorField("Datos que debe pedir", text: $requiredData, minHeight: 88, placeholder: "Ej.\n- Nombre completo\n- Servicio que le interesa")
                }

                SettingsToggleRow(
                    title: "¿Cuándo debe pasar el chat al equipo?",
                    subtitle: "Casos que una persona debe revisar.",
                    isOn: handoffRulesOpen
                ) { enabled in
                    handoffRulesOpen = enabled
                    if !enabled { handoffRules = "" }
                }
                if handoffRulesOpen {
                    editorField("Cuándo pasar al equipo", text: $handoffRules, minHeight: 88, placeholder: "Ej.\n- Se enojó\n- Pregunta por facturación")
                }

                SettingsToggleRow(
                    title: "Clientes existentes van con tu equipo",
                    subtitle: "Si detecta que ya es cliente (o dice serlo), pasa el chat directo a un humano.",
                    isOn: goalWorkflow.attention.pastClientsToHuman
                ) { goalWorkflow.attention.pastClientsToHuman = $0 }
            }
        }
    }

    // MARK: - 5. Entrada y salida

    private var entryExitSection: some View {
        SectionCard(title: "5. Entrada y salida") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                menuField(
                    "¿A quién puede atender?",
                    selected: AgentContactScopeOption(rawValue: contactScope)?.label ?? AgentContactScopeOption.all.label,
                    options: AgentContactScopeOption.allCases.map { PickerChoice(id: $0.rawValue, title: $0.label) }
                ) { contactScope = $0 }

                filterBuilder(
                    title: "Reglas de entrada",
                    side: "entry",
                    empty: "Sin reglas: puede contestar cualquier chat nuevo."
                )

                filterBuilder(
                    title: "Cuándo se detiene",
                    side: "exit",
                    empty: "Opcional: si no agregas reglas, se detiene cuando cumple la meta o un humano toma el chat."
                )
            }
        }
    }

    // MARK: - Guardado

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

    private func save() {
        guard canSave else { return }
        guard timingValidationMessage == nil else {
            errorMessage = timingValidationMessage
            return
        }
        guard goalValidationMessage == nil else {
            errorMessage = goalValidationMessage
            return
        }
        isSaving = true
        var workflow = goalWorkflow
        if workflow.deposit.enabled || workflow.sales.amount != nil {
            let currency = appConfig.accountCurrency
            if workflow.sales.currency.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                workflow.sales.currency = currency ?? workflow.sales.currency
            }
            if workflow.deposit.currency.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                workflow.deposit.currency = currency ?? workflow.deposit.currency
            }
        }

        let input = ConversationalAgentDefInput(
            name: trimmedName,
            aiProvider: aiProvider,
            model: model,
            identityMode: identityMode,
            identityUserId: identityMode == AgentIdentityOption.user.rawValue ? identityUserId : "",
            identityUserName: identityMode == AgentIdentityOption.user.rawValue ? identityUserName : "",
            identityCustomName: identityMode == AgentIdentityOption.custom.rawValue ? identityCustomName : "",
            objective: objective,
            customObjective: objective == AgentObjectiveOption.custom.rawValue ? customObjective : "",
            successAction: successAction,
            successExtras: normalizedSuccessExtras,
            requiredData: requiredDataOpen ? requiredData : "",
            handoffRules: handoffRulesOpen ? handoffRules : "",
            extraInstructions: extraInstructions,
            allowEmojis: allowEmojis,
            hideAttended: false,
            hideAttendedNotifications: hideAttendedNotifications,
            defaultCalendarId: workflow.appointments.calendarId,
            persuasionLevel: persuasion,
            languageLevel: language,
            contactScope: contactScope,
            responseDelay: responseDelay,
            replyDelivery: replyDelivery,
            followUp: followUp,
            goalWorkflow: workflow,
            filters: filters
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

    private func loadReferenceData() async {
        guard !referenceLoading else { return }
        referenceLoading = true
        async let calendarsTask = try? CalendarsService.calendars()
        async let usersTask = try? CalendarsService.highLevelUsers()
        async let filterOptionsTask = try? ConversationalAgentService.filterOptions()
        let (fetchedCalendars, fetchedUsers, fetchedFilterOptions) = await (calendarsTask, usersTask, filterOptionsTask)
        calendars = (fetchedCalendars ?? []).filter(\.isActive)
        teamUsers = (fetchedUsers ?? []).filter { !$0.resolvedID.isEmpty }
        filterOptions = fetchedFilterOptions ?? .empty
        referenceLoading = false
    }

    // MARK: - Helpers de estado / labels

    private var agentSummary: String {
        let objectiveLabel = AgentObjectiveOption(rawValue: objective)?.label ?? "Objetivo"
        let delay = responseDelaySummary
        let parts = [
            objectiveLabel,
            successActionLabel,
            entryRulesCount > 0 ? "entra con \(entryRulesCount) reglas" : "entra con cualquier chat",
            exitRulesCount > 0 ? "se suelta con \(exitRulesCount)" : nil,
            delay.isEmpty ? nil : "espera \(delay)",
            humanMessagesEnabled ? "responde en partes" : nil,
            followUp.enabled ? "seguimiento" : nil
        ].compactMap { $0 }
        return parts.joined(separator: " · ")
    }

    private var identityLabel: String {
        AgentIdentityOption(rawValue: identityMode)?.label ?? AgentIdentityOption.business.label
    }

    private var responseDelaySummary: String {
        switch responseDelay.mode {
        case AgentResponseDelayModeOption.fixed.rawValue:
            return "\(responseDelay.fixedValue) \(delayUnitLower(responseDelay.fixedUnit, value: responseDelay.fixedValue))"
        case AgentResponseDelayModeOption.random.rawValue:
            return "\(responseDelay.minValue)-\(responseDelay.maxValue) \(delayUnitLower(responseDelay.rangeUnit, value: responseDelay.maxValue))"
        default:
            return ""
        }
    }

    private var goalExecutionQuestion: String {
        switch objective {
        case AgentObjectiveOption.filtrar.rawValue:
            return "¿Quién debería atender al contacto filtrado?"
        default:
            return "¿Quién cumple la meta?"
        }
    }

    private var successActionChoices: [PickerChoice] {
        switch objective {
        case AgentObjectiveOption.citas.rawValue:
            return [
                PickerChoice(id: AgentSuccessActionOption.readyForHuman.rawValue, title: "Un humano"),
                PickerChoice(id: AgentSuccessActionOption.bookAppointment.rawValue, title: "El agente IA"),
                PickerChoice(id: AgentSuccessActionOption.sendGoalURL.rawValue, title: "La IA mandando un enlace")
            ]
        case AgentObjectiveOption.ventas.rawValue:
            return [
                PickerChoice(id: AgentSuccessActionOption.readyForHuman.rawValue, title: "Un humano"),
                PickerChoice(id: AgentSuccessActionOption.readyToBuy.rawValue, title: "El agente IA"),
                PickerChoice(id: AgentSuccessActionOption.sendGoalURL.rawValue, title: "La IA mandando un enlace")
            ]
        case AgentObjectiveOption.custom.rawValue:
            return [
                PickerChoice(id: AgentSuccessActionOption.readyForHuman.rawValue, title: "Un humano"),
                PickerChoice(id: AgentSuccessActionOption.sendTriggerLink.rawValue, title: "La IA mandando un enlace")
            ]
        default:
            return [PickerChoice(id: AgentSuccessActionOption.readyForHuman.rawValue, title: "Un humano")]
        }
    }

    private var successActionLabel: String {
        successActionChoices.first(where: { $0.id == successAction })?.title ?? "Un humano"
    }

    private var normalizedSuccessExtras: [AgentSuccessExtra] {
        successExtras.compactMap { extra in
            if extra.type == AgentSuccessExtraOption.set_custom_field.rawValue {
                return extra.field.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : extra
            }
            return extra.tag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : extra
        }
    }

    private var userChoices: [PickerChoice] {
        let users = teamUsers.map { PickerChoice(id: $0.resolvedID, title: $0.displayLabel) }
        return users.isEmpty ? [PickerChoice(id: "", title: referenceLoading ? "Cargando usuarios..." : "Sin usuarios disponibles")] : users
    }

    private var calendarChoices: [PickerChoice] {
        let choices = calendars.map { PickerChoice(id: $0.id, title: $0.name) }
        return [PickerChoice(id: "", title: referenceLoading ? "Cargando calendarios..." : "Sin calendario fijo")] + choices
    }

    /// Opciones del calendario del objetivo de citas: aquí el calendario es
    /// obligatorio, así que no existe la opción "Sin calendario fijo".
    private var goalCalendarChoices: [PickerChoice] {
        let choices = calendars.map { PickerChoice(id: $0.id, title: $0.name) }
        if choices.isEmpty {
            return [PickerChoice(id: "", title: referenceLoading ? "Cargando calendarios..." : "No hay calendarios activos")]
        }
        return choices
    }

    private var timingValidationMessage: String? {
        if responseDelay.mode == AgentResponseDelayModeOption.random.rawValue, responseDelay.minValue > responseDelay.maxValue {
            return "Revisa el rango de espera."
        }
        if humanMessagesEnabled, replyDelivery.minDelaySeconds > replyDelivery.maxDelaySeconds {
            return "Revisa el rango de pausa entre globos."
        }
        guard followUp.enabled else { return nil }
        let firstDelay = followUpDelayMinutes(followUp.first)
        if firstDelay > 23 * 60 { return "El seguimiento no puede pasar de 23 horas." }
        if followUp.second.enabled {
            let secondDelay = followUpDelayMinutes(followUp.second)
            if secondDelay > 23 * 60 { return "El segundo seguimiento no puede pasar de 23 horas." }
            if secondDelay <= firstDelay { return "Revisa el orden de los seguimientos." }
        }
        if followUp.strategy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Falta la estrategia de seguimiento."
        }
        return nil
    }

    /// Espejo local de `assertAgentGoalRequirements` del backend: un agente de
    /// citas publicado necesita calendario, y el anticipo necesita al menos un
    /// método de cobro (con datos bancarios si es por transferencia).
    private var goalValidationMessage: String? {
        if objective == AgentObjectiveOption.citas.rawValue, agent.enabled {
            let calendarId = (goalWorkflow.appointments.calendarId ?? agent.defaultCalendarId ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if calendarId.isEmpty {
                return "Elige el calendario para las citas antes de guardar."
            }
        }
        if depositApplies {
            let methods = goalWorkflow.deposit.methods
            if !methods.paymentLink && !methods.bankTransfer {
                return "Activa al menos un método para cobrar el anticipo (link de pago o transferencia)."
            }
            if methods.bankTransfer,
               goalWorkflow.deposit.bankTransferDetails.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "Escribe los datos de transferencia (banco, cuenta o CLABE y titular) para el anticipo."
            }
        }
        return nil
    }

    /// Cuándo aplica el anticipo (mismo criterio que backend y web):
    /// citas → deposit.enabled; ventas → modo de venta "deposit".
    private var depositApplies: Bool {
        if objective == AgentObjectiveOption.citas.rawValue {
            return goalWorkflow.deposit.enabled
        }
        if objective == AgentObjectiveOption.ventas.rawValue {
            return goalWorkflow.sales.paymentMode == AgentSalesPaymentModeOption.deposit.rawValue
        }
        return false
    }

    private func ensureValidSuccessAction() {
        if !successActionChoices.contains(where: { $0.id == successAction }) {
            successAction = successActionChoices.first?.id ?? AgentSuccessActionOption.readyForHuman.rawValue
        }
        applyGoalOwner(for: successAction)
    }

    private func applyGoalOwner(for action: String) {
        if objective == AgentObjectiveOption.citas.rawValue {
            goalWorkflow.appointments.owner = action == AgentSuccessActionOption.bookAppointment.rawValue
                ? "ai"
                : action == AgentSuccessActionOption.sendGoalURL.rawValue ? "url" : "human"
        }
        if objective == AgentObjectiveOption.ventas.rawValue {
            goalWorkflow.sales.owner = action == AgentSuccessActionOption.readyToBuy.rawValue
                ? "ai"
                : action == AgentSuccessActionOption.sendGoalURL.rawValue ? "url" : "human"
        }
    }

    private func ensureWorkflowCurrency() {
        guard let accountCurrency = appConfig.accountCurrency else { return }
        if goalWorkflow.sales.currency.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            goalWorkflow.sales.currency = accountCurrency
        }
        if goalWorkflow.deposit.currency.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            goalWorkflow.deposit.currency = accountCurrency
        }
    }

    private func calendarName(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return referenceLoading ? "Cargando calendarios..." : "Sin calendario fijo" }
        return calendars.first(where: { $0.id == id })?.name ?? "Calendario guardado"
    }

    /// Label del calendario del objetivo de citas: sin calendario elegido es un
    /// placeholder de selección, no una opción válida.
    private func goalCalendarName(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return referenceLoading ? "Cargando calendarios..." : "Elegir calendario" }
        return calendars.first(where: { $0.id == id })?.name ?? "Calendario guardado"
    }

    private func delayUnitLabel(_ value: String) -> String {
        AgentResponseDelayUnitOption(rawValue: value)?.label ?? "Segundos"
    }

    private func followUpUnitLabel(_ value: String) -> String {
        AgentFollowUpUnitOption(rawValue: value)?.label ?? "Minutos"
    }

    private func delayUnitLower(_ value: String, value amount: Int) -> String {
        if value == AgentResponseDelayUnitOption.minutes.rawValue {
            return amount == 1 ? "minuto" : "minutos"
        }
        return amount == 1 ? "segundo" : "segundos"
    }

    private func followUpMaxValue(_ unit: String) -> Int {
        unit == AgentFollowUpUnitOption.hours.rawValue ? 23 : 23 * 60
    }

    private func followUpDelayMinutes(_ step: AgentFollowUpStepConfig) -> Int {
        step.value * (step.unit == AgentFollowUpUnitOption.hours.rawValue ? 60 : 1)
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
        case ConversationalAgentErrorCode.calendarRequired:
            return apiError.message.isEmpty ? "Elige el calendario para las citas antes de guardar." : apiError.message
        case ConversationalAgentErrorCode.depositMethodRequired:
            return apiError.message.isEmpty ? "Activa al menos un método para cobrar el anticipo (link de pago o transferencia)." : apiError.message
        case ConversationalAgentErrorCode.transferDetailsRequired:
            return apiError.message.isEmpty ? "Escribe los datos de transferencia (banco, cuenta o CLABE y titular) para el anticipo." : apiError.message
        default:
            return apiError.message.isEmpty ? "Intenta otra vez." : apiError.message
        }
    }

    // MARK: - Piezas reutilizables

    private struct PickerChoice: Identifiable, Equatable {
        let id: String
        let title: String
    }

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

    private func menuField(
        _ title: String,
        selected: String,
        options: [PickerChoice],
        onSelect: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
            Menu {
                ForEach(options) { option in
                    Button(option.title) { onSelect(option.id) }
                }
            } label: {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    Text(selected.isEmpty ? "Elegir" : selected)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(2)
                    Spacer(minLength: RistakTheme.Spacing.xs)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textDim)
                }
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.surface2)
                )
            }
            .buttonStyle(.plain)
        }
    }

    private func textField(_ title: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.sentences)
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.surface2)
                )
        }
    }

    private func numberField(_ title: String, value: Binding<String>) -> some View {
        textField(title, text: value, placeholder: "0")
            .keyboardType(.decimalPad)
    }

    private func editorField(_ title: String, text: Binding<String>, minHeight: CGFloat, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
            agentTextEditor(text, minHeight: minHeight, placeholder: placeholder)
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
                .fill(RistakTheme.surface2)
        )
    }

    private func filterBuilder(title: String, side: String, empty: String) -> some View {
        let groups = filterGroups(side)
        return VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)

            if groups.isEmpty {
                Text(empty)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(RistakTheme.Spacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                            .fill(RistakTheme.surface2)
                    )
            }

            ForEach(Array(groups.enumerated()), id: \.offset) { item in
                if item.offset > 0 {
                    filterOrDivider
                }
                filterGroupView(side: side, groupIndex: item.offset, group: item.element)
            }

            Menu {
                ForEach(AgentFilterCatalog.categories) { category in
                    Button(category.label) { addFilterGroup(side: side, categoryId: category.id) }
                }
            } label: {
                Label(groups.isEmpty ? "Añadir condición" : "Añadir grupo O", systemImage: "plus")
                    .font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
        }
    }

    private var filterOrDivider: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Rectangle()
                .fill(RistakTheme.border)
                .frame(height: 1)
            Text("O")
                .font(.caption.weight(.bold))
                .foregroundStyle(RistakTheme.textDim)
            Rectangle()
                .fill(RistakTheme.border)
                .frame(height: 1)
        }
        .padding(.vertical, 2)
    }

    private func filterGroupView(side: String, groupIndex: Int, group: AgentConditionGroup) -> some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            HStack {
                Text("Grupo \(groupIndex + 1)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
                Spacer()
                Button(role: .destructive) {
                    removeFilterGroup(side: side, groupIndex: groupIndex)
                } label: {
                    Image(systemName: "trash")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Quitar grupo")
            }

            ForEach(Array(group.conditions.enumerated()), id: \.offset) { item in
                if item.offset > 0 {
                    Text("Y")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(RistakTheme.textDim)
                        .padding(.leading, 2)
                }
                conditionEditor(
                    side: side,
                    groupIndex: groupIndex,
                    conditionIndex: item.offset,
                    condition: item.element
                )
            }

            Menu {
                ForEach(AgentFilterCatalog.categories) { category in
                    Button(category.label) {
                        addFilterCondition(side: side, groupIndex: groupIndex, categoryId: category.id)
                    }
                }
            } label: {
                Label("Añadir condición", systemImage: "plus")
                    .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.bordered)
        }
        .padding(RistakTheme.Spacing.sm)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.surface2)
        )
    }

    private func conditionEditor(side: String, groupIndex: Int, conditionIndex: Int, condition: AgentCondition) -> some View {
        let category = AgentFilterCatalog.category(condition.category)
        let conditionSummary = AgentFilterCatalog.conditionSummary(condition, calendars: calendars, options: filterOptions)
        return VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            HStack(alignment: .top, spacing: RistakTheme.Spacing.xs) {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    menuField(
                        conditionIndex == 0 ? "Si" : "Y",
                        selected: category.label,
                        options: AgentFilterCatalog.categories.map { PickerChoice(id: $0.id, title: $0.label) }
                    ) { categoryId in
                        updateFilterCondition(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, next: AgentFilterCatalog.defaultCondition(categoryId: categoryId))
                    }

                    Text(conditionSummary)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(role: .destructive) {
                    removeFilterCondition(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex)
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Eliminar condición")
            }

            if condition.params.isEmpty {
                Text(category.baseLabel)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            }

            ForEach(Array(condition.params.enumerated()), id: \.offset) { item in
                paramEditor(
                    side: side,
                    groupIndex: groupIndex,
                    conditionIndex: conditionIndex,
                    paramIndex: item.offset,
                    condition: condition,
                    param: item.element
                )
            }

            let usedPresence = condition.params.contains { $0.field == "presence" }
            let criteria = category.params.filter { $0.field != "presence" || !usedPresence }
            if !criteria.isEmpty {
                Menu {
                    ForEach(criteria) { param in
                        Button(param.label) {
                            addFilterCriterion(
                                side: side,
                                groupIndex: groupIndex,
                                conditionIndex: conditionIndex,
                                field: param.field
                            )
                        }
                    }
                } label: {
                    Label("Añadir criterio", systemImage: "plus")
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(RistakTheme.Spacing.sm)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.bg)
        )
    }

    private func paramEditor(
        side: String,
        groupIndex: Int,
        conditionIndex: Int,
        paramIndex: Int,
        condition: AgentCondition,
        param: AgentConditionParam
    ) -> some View {
        let category = AgentFilterCatalog.category(condition.category)
        let paramDef = AgentFilterCatalog.param(categoryId: condition.category, field: param.field)
        let operatorDef = AgentFilterCatalog.operatorDef(categoryId: condition.category, field: param.field, operatorId: param.operatorValue)
        let usedPresence = condition.params.contains { $0.field == "presence" }
        let fieldChoices = category.params.filter { $0.field != "presence" || param.field == "presence" || !usedPresence }

        return VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            if category.params.count > 1 {
                menuField(
                    "Campo",
                    selected: paramDef.label,
                    options: fieldChoices.map { PickerChoice(id: $0.field, title: $0.label) }
                ) { field in
                    replaceFilterParam(
                        side: side,
                        groupIndex: groupIndex,
                        conditionIndex: conditionIndex,
                        paramIndex: paramIndex,
                        next: AgentFilterCatalog.defaultParam(categoryId: condition.category, field: field)
                    )
                }
            }

            if param.field == "custom_field" {
                menuField(
                    "Campo personalizado",
                    selected: customFieldLabel(param.fieldKey),
                    options: customFieldChoices
                ) { fieldKey in
                    patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { next in
                        next.fieldKey = fieldKey
                    }
                }
            }

            menuField(
                "Operador",
                selected: operatorDef.label,
                options: paramDef.operators.map { PickerChoice(id: $0.id, title: $0.label) }
            ) { operatorId in
                updateFilterOperator(
                    side: side,
                    groupIndex: groupIndex,
                    conditionIndex: conditionIndex,
                    paramIndex: paramIndex,
                    operatorId: operatorId
                )
            }

            filterValueEditor(
                side: side,
                groupIndex: groupIndex,
                conditionIndex: conditionIndex,
                paramIndex: paramIndex,
                param: param,
                operatorDef: operatorDef
            )

            Button(role: .destructive) {
                removeFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex)
            } label: {
                Label("Quitar criterio", systemImage: "trash")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.bordered)
        }
        .padding(RistakTheme.Spacing.sm)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.surface)
        )
    }

    @ViewBuilder
    private func filterValueEditor(
        side: String,
        groupIndex: Int,
        conditionIndex: Int,
        paramIndex: Int,
        param: AgentConditionParam,
        operatorDef: AgentFilterOperatorDef
    ) -> some View {
        switch operatorDef.valueKind {
        case "none":
            EmptyView()
        case "channel":
            menuField(
                "Valor",
                selected: optionLabel(AgentFilterCatalog.channelOptions, id: param.value, fallback: "Chats y SMS"),
                options: pickerChoices(AgentFilterCatalog.channelOptions)
            ) { value in
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { next in
                    next.value = value
                    if !AgentFilterCatalog.commentChannels.contains(value) {
                        next.replyMode = nil
                        next.postId = nil
                        next.postName = nil
                    }
                }
            }
            if AgentFilterCatalog.commentChannels.contains(param.value ?? "") {
                menuField(
                    "Cómo responde el agente al comentario",
                    selected: optionLabel(AgentFilterCatalog.commentReplyModeOptions, id: param.replyMode, fallback: "Responder por privado (DM)"),
                    options: pickerChoices(AgentFilterCatalog.commentReplyModeOptions)
                ) { value in
                    patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0.replyMode = value }
                }
                textField("Publicación", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.postName), placeholder: "Cualquier publicación")
                textField("ID de publicación", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.postId), placeholder: "Opcional")
            }
        case "text", "adText", "customFieldValue":
            textField(
                "Valor",
                text: paramString(side, groupIndex, conditionIndex, paramIndex, \.value),
                placeholder: operatorDef.placeholder.isEmpty ? "Valor" : operatorDef.placeholder
            )
        case "list", "tagList":
            textField(
                "Valores separados por coma",
                text: paramValuesText(side, groupIndex, conditionIndex, paramIndex),
                placeholder: operatorDef.placeholder.isEmpty ? "Valor, otro valor" : operatorDef.placeholder
            )
        case "tag":
            textField("Etiqueta", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.value), placeholder: "Nombre o ID de etiqueta")
        case "calendar":
            menuField(
                "Calendario",
                selected: calendarName(param.value),
                options: calendarChoices
            ) { calendarId in
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0.value = calendarId }
            }
        case "date":
            textField("Fecha", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.date), placeholder: "YYYY-MM-DD")
        case "dateRange":
            HStack(spacing: RistakTheme.Spacing.sm) {
                textField("Desde", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.date), placeholder: "YYYY-MM-DD")
                textField("Hasta", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.dateEnd), placeholder: "YYYY-MM-DD")
            }
        case "offset":
            HStack(spacing: RistakTheme.Spacing.sm) {
                numberField("Cantidad", value: intText(paramInt(side, groupIndex, conditionIndex, paramIndex, \.offsetValue, defaultValue: 30), min: 1))
                menuField(
                    "Unidad",
                    selected: optionLabel(AgentFilterCatalog.offsetUnitOptions, id: param.offsetUnit, fallback: "minutos"),
                    options: pickerChoices(AgentFilterCatalog.offsetUnitOptions)
                ) { unit in
                    patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0.offsetUnit = unit }
                }
            }
        case "amount":
            numberField("Monto", value: doubleText(paramDouble(side, groupIndex, conditionIndex, paramIndex, \.amount)))
        case "amountRange":
            HStack(spacing: RistakTheme.Spacing.sm) {
                numberField("Mínimo", value: doubleText(paramDouble(side, groupIndex, conditionIndex, paramIndex, \.amount)))
                numberField("Máximo", value: doubleText(paramDouble(side, groupIndex, conditionIndex, paramIndex, \.amountMax)))
            }
        case "ad":
            menuField(
                "Anuncio",
                selected: adLabel(param.value),
                options: adChoices
            ) { adId in
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0.value = adId }
            }
            textField("ID o nombre manual", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.value), placeholder: "Opcional si no está en la lista")
        case "businessPhone":
            menuField(
                "Número",
                selected: businessPhoneLabel(param.value),
                options: businessPhoneChoices
            ) { phoneId in
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0.value = phoneId }
            }
            textField("ID manual del número", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.value), placeholder: "Opcional")
        case "timeRange":
            HStack(spacing: RistakTheme.Spacing.sm) {
                textField("Desde", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.timeStart), placeholder: "09:00")
                textField("Hasta", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.timeEnd), placeholder: "18:00")
            }
        case "weekdays":
            weekdayPicker(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex, values: param.values ?? [])
        case "customField":
            EmptyView()
        default:
            textField("Valor", text: paramString(side, groupIndex, conditionIndex, paramIndex, \.value), placeholder: "Valor")
        }
    }

    private func weekdayPicker(side: String, groupIndex: Int, conditionIndex: Int, paramIndex: Int, values: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Días")
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ForEach(AgentFilterCatalog.weekdayOptions) { option in
                        let selected = values.contains(option.id)
                        Button(option.label) {
                            patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { next in
                                var set = Set(next.values ?? [])
                                if set.contains(option.id) { set.remove(option.id) } else { set.insert(option.id) }
                                next.values = AgentFilterCatalog.weekdayOptions.map(\.id).filter { set.contains($0) }
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .foregroundStyle(selected ? RistakTheme.onAccent : RistakTheme.textPrimary)
                        .background(
                            Capsule(style: .continuous)
                                .fill(selected ? RistakTheme.accent : RistakTheme.controlRest)
                        )
                    }
                }
            }
        }
    }

    private func filterGroups(_ side: String) -> [AgentConditionGroup] {
        side == "entry" ? filters.entry.groups : filters.exit.groups
    }

    private func setFilterGroups(_ groups: [AgentConditionGroup], side: String) {
        if side == "entry" {
            filters.entry.groups = groups
        } else {
            filters.exit.groups = groups
        }
    }

    private func addFilterGroup(side: String, categoryId: String) {
        var groups = filterGroups(side)
        groups.append(AgentConditionGroup(conditions: [AgentFilterCatalog.defaultCondition(categoryId: categoryId)]))
        setFilterGroups(groups, side: side)
    }

    private func removeFilterGroup(side: String, groupIndex: Int) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex) else { return }
        groups.remove(at: groupIndex)
        setFilterGroups(groups, side: side)
    }

    private func addFilterCondition(side: String, groupIndex: Int, categoryId: String) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex) else { return }
        groups[groupIndex].conditions.append(AgentFilterCatalog.defaultCondition(categoryId: categoryId))
        setFilterGroups(groups, side: side)
    }

    private func removeFilterCondition(side: String, groupIndex: Int, conditionIndex: Int) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex), groups[groupIndex].conditions.indices.contains(conditionIndex) else { return }
        groups[groupIndex].conditions.remove(at: conditionIndex)
        groups = groups.filter { !$0.conditions.isEmpty }
        setFilterGroups(groups, side: side)
    }

    private func updateFilterCondition(side: String, groupIndex: Int, conditionIndex: Int, next: AgentCondition) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex), groups[groupIndex].conditions.indices.contains(conditionIndex) else { return }
        groups[groupIndex].conditions[conditionIndex] = next
        setFilterGroups(groups, side: side)
    }

    private func addFilterCriterion(side: String, groupIndex: Int, conditionIndex: Int, field: String) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex), groups[groupIndex].conditions.indices.contains(conditionIndex) else { return }
        let categoryId = groups[groupIndex].conditions[conditionIndex].category
        groups[groupIndex].conditions[conditionIndex].params.append(AgentFilterCatalog.defaultParam(categoryId: categoryId, field: field))
        setFilterGroups(groups, side: side)
    }

    private func removeFilterParam(side: String, groupIndex: Int, conditionIndex: Int, paramIndex: Int) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex),
              groups[groupIndex].conditions.indices.contains(conditionIndex),
              groups[groupIndex].conditions[conditionIndex].params.indices.contains(paramIndex) else { return }
        groups[groupIndex].conditions[conditionIndex].params.remove(at: paramIndex)
        setFilterGroups(groups, side: side)
    }

    private func replaceFilterParam(side: String, groupIndex: Int, conditionIndex: Int, paramIndex: Int, next: AgentConditionParam) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex),
              groups[groupIndex].conditions.indices.contains(conditionIndex),
              groups[groupIndex].conditions[conditionIndex].params.indices.contains(paramIndex) else { return }
        groups[groupIndex].conditions[conditionIndex].params[paramIndex] = next
        setFilterGroups(groups, side: side)
    }

    private func patchFilterParam(
        side: String,
        groupIndex: Int,
        conditionIndex: Int,
        paramIndex: Int,
        mutate: (inout AgentConditionParam) -> Void
    ) {
        var groups = filterGroups(side)
        guard groups.indices.contains(groupIndex),
              groups[groupIndex].conditions.indices.contains(conditionIndex),
              groups[groupIndex].conditions[conditionIndex].params.indices.contains(paramIndex) else { return }
        mutate(&groups[groupIndex].conditions[conditionIndex].params[paramIndex])
        setFilterGroups(groups, side: side)
    }

    private func updateFilterOperator(side: String, groupIndex: Int, conditionIndex: Int, paramIndex: Int, operatorId: String) {
        guard let current = currentParam(side, groupIndex, conditionIndex, paramIndex) else { return }
        let categoryId = currentCondition(side, groupIndex, conditionIndex)?.category ?? ""
        let oldOperator = AgentFilterCatalog.operatorDef(categoryId: categoryId, field: current.field, operatorId: current.operatorValue)
        let nextOperator = AgentFilterCatalog.operatorDef(categoryId: categoryId, field: current.field, operatorId: operatorId)
        if oldOperator.valueKind == nextOperator.valueKind || current.field == "custom_field" {
            patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0.operatorValue = operatorId }
        } else {
            var next = AgentFilterCatalog.defaultParam(categoryId: categoryId, field: current.field ?? "", operatorId: operatorId)
            next.fieldKey = current.fieldKey
            next.value = current.value
            replaceFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex, next: next)
        }
    }

    private func currentCondition(_ side: String, _ groupIndex: Int, _ conditionIndex: Int) -> AgentCondition? {
        let groups = filterGroups(side)
        guard groups.indices.contains(groupIndex), groups[groupIndex].conditions.indices.contains(conditionIndex) else { return nil }
        return groups[groupIndex].conditions[conditionIndex]
    }

    private func currentParam(_ side: String, _ groupIndex: Int, _ conditionIndex: Int, _ paramIndex: Int) -> AgentConditionParam? {
        guard let condition = currentCondition(side, groupIndex, conditionIndex),
              condition.params.indices.contains(paramIndex) else { return nil }
        return condition.params[paramIndex]
    }

    private func paramString(
        _ side: String,
        _ groupIndex: Int,
        _ conditionIndex: Int,
        _ paramIndex: Int,
        _ keyPath: WritableKeyPath<AgentConditionParam, String?>
    ) -> Binding<String> {
        Binding(
            get: { currentParam(side, groupIndex, conditionIndex, paramIndex)?[keyPath: keyPath] ?? "" },
            set: { value in
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { next in
                    let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    next[keyPath: keyPath] = clean.isEmpty ? nil : value
                }
            }
        )
    }

    private func paramValuesText(_ side: String, _ groupIndex: Int, _ conditionIndex: Int, _ paramIndex: Int) -> Binding<String> {
        Binding(
            get: { (currentParam(side, groupIndex, conditionIndex, paramIndex)?.values ?? []).joined(separator: ", ") },
            set: { raw in
                let values = raw
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0.values = values }
            }
        )
    }

    private func paramInt(
        _ side: String,
        _ groupIndex: Int,
        _ conditionIndex: Int,
        _ paramIndex: Int,
        _ keyPath: WritableKeyPath<AgentConditionParam, Int?>,
        defaultValue: Int
    ) -> Binding<Int> {
        Binding(
            get: { currentParam(side, groupIndex, conditionIndex, paramIndex)?[keyPath: keyPath] ?? defaultValue },
            set: { value in
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0[keyPath: keyPath] = value }
            }
        )
    }

    private func paramDouble(
        _ side: String,
        _ groupIndex: Int,
        _ conditionIndex: Int,
        _ paramIndex: Int,
        _ keyPath: WritableKeyPath<AgentConditionParam, Double?>
    ) -> Binding<Double?> {
        Binding(
            get: { currentParam(side, groupIndex, conditionIndex, paramIndex)?[keyPath: keyPath] },
            set: { value in
                patchFilterParam(side: side, groupIndex: groupIndex, conditionIndex: conditionIndex, paramIndex: paramIndex) { $0[keyPath: keyPath] = value }
            }
        )
    }

    private var customFieldChoices: [PickerChoice] {
        let choices = filterOptions.customFields.map { PickerChoice(id: $0.key, title: $0.label) }
        return [PickerChoice(id: "", title: choices.isEmpty ? "Sin campos personalizados" : "Elegir campo")] + choices
    }

    private var businessPhoneChoices: [PickerChoice] {
        let choices = filterOptions.businessPhones.map { PickerChoice(id: $0.id, title: $0.label) }
        return [PickerChoice(id: "", title: choices.isEmpty ? "Sin números cargados" : "Elegir número")] + choices
    }

    private var adChoices: [PickerChoice] {
        let choices = filterOptions.ads.map { ad in
            PickerChoice(id: ad.id, title: "\(ad.detected ? "● " : "")\(ad.name)\(ad.campaign.map { " · \($0)" } ?? "")")
        }
        return [PickerChoice(id: "", title: choices.isEmpty ? "Sin anuncios cargados" : "Elegir anuncio")] + choices
    }

    private func pickerChoices(_ options: [PickerOption]) -> [PickerChoice] {
        options.map { PickerChoice(id: $0.id, title: $0.label) }
    }

    private func optionLabel(_ options: [PickerOption], id: String?, fallback: String) -> String {
        options.first(where: { $0.id == id })?.label ?? (id?.isEmpty == false ? id! : fallback)
    }

    private func customFieldLabel(_ key: String?) -> String {
        guard let key, !key.isEmpty else { return "Elegir campo" }
        return filterOptions.customFields.first(where: { $0.key == key })?.label ?? key
    }

    private func businessPhoneLabel(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return filterOptions.businessPhones.isEmpty ? "Sin números cargados" : "Elegir número" }
        return filterOptions.businessPhones.first(where: { $0.id == id })?.label ?? id
    }

    private func adLabel(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return filterOptions.ads.isEmpty ? "Sin anuncios cargados" : "Elegir anuncio" }
        return filterOptions.ads.first(where: { $0.id == id })?.name ?? id
    }

    private func intText(_ value: Binding<Int>, min: Int, max: Int? = nil) -> Binding<String> {
        Binding(
            get: { String(value.wrappedValue) },
            set: { raw in
                let parsed = Int(raw.filter { $0.isNumber }) ?? min
                value.wrappedValue = Swift.max(min, max.map { Swift.min(parsed, $0) } ?? parsed)
            }
        )
    }

    private func doubleText(_ value: Binding<Double?>) -> Binding<String> {
        Binding(
            get: {
                guard let wrapped = value.wrappedValue else { return "" }
                if wrapped.rounded() == wrapped { return String(Int(wrapped)) }
                return String(wrapped)
            },
            set: { raw in
                let normalized = raw.replacingOccurrences(of: ",", with: ".")
                if normalized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    value.wrappedValue = nil
                } else {
                    value.wrappedValue = Double(normalized)
                }
            }
        )
    }
}
