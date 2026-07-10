import Foundation

// MARK: - Agente conversacional: runtime interno + definiciones (doc 05 §6)
//
// El agente conversacional (auto-respuesta por contacto) es un sistema DISTINTO
// del "Asistente Personal AI" (`AIAgentService`, /api/ai-agent). Aquí modelamos
// el runtime interno (`ConversationalAgentConfig`) y las DEFINICIONES de agente
// (`ConversationalAgentDef`) que el Hub del chat enciende/pausa/edita. El estado
// POR CONVERSACIÓN (`ConversationAgentState`) y sus acciones viven en
// `Core/Models/MessageSendModels.swift` + `AgentStateService`.

// MARK: Códigos de error del backend (para create/update)

enum ConversationalAgentErrorCode {
    static let entryConflict = "CONVERSATIONAL_AGENT_ENTRY_CONFLICT"
    static let limitReached = "CONVERSATIONAL_AGENT_LIMIT_REACHED"
    static let businessPromptNotReady = "CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY"
    static let calendarRequired = "CONVERSATIONAL_AGENT_CALENDAR_REQUIRED"
    static let depositMethodRequired = "CONVERSATIONAL_AGENT_DEPOSIT_METHOD_REQUIRED"
    static let transferDetailsRequired = "CONVERSATIONAL_AGENT_TRANSFER_DETAILS_REQUIRED"
}

// MARK: Estado del "prompt del negocio" (bloquea encender/crear si no está listo)

struct ConversationalBusinessPromptStatus: Codable, Sendable, Equatable {
    let ready: Bool
    let status: String?
    let businessName: String?
    let industry: String?
    let summary: String?

    enum CodingKeys: String, CodingKey {
        case ready, status, businessName, industry, summary
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ready = c.flexibleBool(forKey: .ready) ?? false
        status = c.flexibleString(forKey: .status)
        businessName = c.flexibleString(forKey: .businessName)
        industry = c.flexibleString(forKey: .industry)
        summary = c.flexibleString(forKey: .summary)
    }
}

// MARK: Runtime interno — GET/POST /conversational-agent/config

struct ConversationalAgentConfig: Codable, Sendable, Equatable {
    let enabled: Bool
    let aiProvider: String
    let model: String
    let objective: String
    let customObjective: String
    let successAction: String
    let requiredData: String
    let handoffRules: String
    let extraInstructions: String
    let allowEmojis: Bool
    let hideAttended: Bool
    let hideAttendedNotifications: Bool
    let defaultCalendarId: String?
    let persuasionLevel: String
    let languageLevel: String
    let updatedAt: String?
    let businessPromptStatus: ConversationalBusinessPromptStatus?

    enum CodingKeys: String, CodingKey {
        case enabled, aiProvider, model, objective, customObjective, successAction
        case requiredData, handoffRules, extraInstructions
        case allowEmojis, hideAttended, hideAttendedNotifications, defaultCalendarId
        case persuasionLevel, languageLevel, updatedAt, businessPromptStatus
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.flexibleBool(forKey: .enabled) ?? false
        aiProvider = AgentAIProviderCatalog.knownProvider(c.flexibleString(forKey: .aiProvider))
        model = AgentAIProviderCatalog.knownModel(provider: aiProvider, c.flexibleString(forKey: .model))
        objective = c.flexibleString(forKey: .objective) ?? AgentObjectiveOption.citas.rawValue
        customObjective = c.flexibleString(forKey: .customObjective) ?? ""
        successAction = c.flexibleString(forKey: .successAction) ?? AgentSuccessActionOption.readyForHuman.rawValue
        requiredData = c.flexibleString(forKey: .requiredData) ?? ""
        handoffRules = c.flexibleString(forKey: .handoffRules) ?? ""
        extraInstructions = c.flexibleString(forKey: .extraInstructions) ?? ""
        allowEmojis = c.flexibleBool(forKey: .allowEmojis) ?? false
        hideAttended = c.flexibleBool(forKey: .hideAttended) ?? false
        hideAttendedNotifications = c.flexibleBool(forKey: .hideAttendedNotifications) ?? false
        defaultCalendarId = c.flexibleString(forKey: .defaultCalendarId)
        persuasionLevel = c.flexibleString(forKey: .persuasionLevel) ?? AgentPersuasionOption.high.rawValue
        languageLevel = c.flexibleString(forKey: .languageLevel) ?? AgentLanguageOption.intermediate.rawValue
        updatedAt = c.flexibleString(forKey: .updatedAt)
        businessPromptStatus = try? c.decodeIfPresent(ConversationalBusinessPromptStatus.self, forKey: .businessPromptStatus)
    }

    /// ¿Se puede encender el agente? Requiere el prompt del negocio listo
    /// (si el backend no lo manda, asumimos listo y dejamos que 409 corrija).
    var canEnable: Bool { businessPromptStatus?.ready ?? true }
}

/// Body parcial de POST /conversational-agent/config.
struct ConversationalAgentConfigInput: Encodable, Sendable {
    var enabled: Bool?
    var aiProvider: String?
    var model: String?
    var objective: String?
    var customObjective: String?
    var successAction: String?
    var requiredData: String?
    var handoffRules: String?
    var extraInstructions: String?
    var allowEmojis: Bool?
    var hideAttended: Bool?
    var hideAttendedNotifications: Bool?
    var defaultCalendarId: String?
    var persuasionLevel: String?
    var languageLevel: String?
}

// MARK: Disponibilidad de OpenAI cacheable (gate del Hub sin bloquear el pintado)

/// Snapshot Codable de la disponibilidad de OpenAI para el Hub del agente.
///
/// `AIAgentConfigStatus` vive en `Core` y es Decodable-only; aquí guardamos solo
/// la última disponibilidad conocida (`configured` + `needsReconnect`) para que
/// el gate del Hub NO bloquee el primer pintado: si la última vez OpenAI estaba
/// listo, mostramos los agentes cacheados al instante y revalidamos por detrás.
struct AgentOpenAIAvailabilitySnapshot: Codable, Sendable, Equatable {
    let configured: Bool
    let needsReconnect: Bool

    init(configured: Bool, needsReconnect: Bool) {
        self.configured = configured
        self.needsReconnect = needsReconnect
    }

    init(_ status: AIAgentConfigStatus) {
        configured = status.configured
        needsReconnect = status.needsReconnect
    }

    /// Mismo criterio que `AIAgentConfigStatus.isReady`.
    var isReady: Bool { configured && !needsReconnect }
}

// MARK: Definición de agente — GET /agents, PUT /agents/:id

struct ConversationalAgentDef: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let name: String
    let enabled: Bool
    let aiProvider: String
    let model: String
    let identityMode: String
    let identityUserId: String
    let identityUserName: String
    let identityCustomName: String
    let position: Int
    let objective: String
    let customObjective: String
    let successAction: String
    let successExtras: [AgentSuccessExtra]
    let requiredData: String
    let handoffRules: String
    let extraInstructions: String
    let allowEmojis: Bool
    let hideAttended: Bool
    let hideAttendedNotifications: Bool
    let defaultCalendarId: String?
    let persuasionLevel: String
    let languageLevel: String
    let contactScope: String
    let contactScopeCutoffAt: String?
    let responseDelay: AgentResponseDelayConfig
    let replyDelivery: AgentReplyDeliveryConfig
    let followUp: AgentFollowUpConfig
    let goalWorkflow: AgentGoalWorkflowConfig
    let filters: AgentFilters
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, enabled, aiProvider, model
        case identityMode, identityUserId, identityUserName, identityCustomName
        case position, objective, customObjective, successAction, successExtras
        case requiredData, handoffRules, extraInstructions
        case allowEmojis, hideAttended, hideAttendedNotifications, defaultCalendarId
        case persuasionLevel, languageLevel, contactScope, contactScopeCutoffAt
        case responseDelay, replyDelivery, followUp, goalWorkflow, filters
        case createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.flexibleString(forKey: .id) ?? ""
        name = c.flexibleString(forKey: .name) ?? ""
        enabled = c.flexibleBool(forKey: .enabled) ?? false
        aiProvider = AgentAIProviderCatalog.knownProvider(c.flexibleString(forKey: .aiProvider))
        model = AgentAIProviderCatalog.knownModel(provider: aiProvider, c.flexibleString(forKey: .model))
        identityMode = AgentIdentityOption.known(c.flexibleString(forKey: .identityMode))
        identityUserId = c.flexibleString(forKey: .identityUserId) ?? ""
        identityUserName = c.flexibleString(forKey: .identityUserName) ?? ""
        identityCustomName = c.flexibleString(forKey: .identityCustomName) ?? ""
        position = c.flexibleInt(forKey: .position) ?? 0
        objective = AgentObjectiveOption.known(c.flexibleString(forKey: .objective))
        customObjective = c.flexibleString(forKey: .customObjective) ?? ""
        successAction = c.flexibleString(forKey: .successAction) ?? AgentSuccessActionOption.readyForHuman.rawValue
        successExtras = (try? c.decodeIfPresent([AgentSuccessExtra].self, forKey: .successExtras)) ?? []
        requiredData = c.flexibleString(forKey: .requiredData) ?? ""
        handoffRules = c.flexibleString(forKey: .handoffRules) ?? ""
        extraInstructions = c.flexibleString(forKey: .extraInstructions) ?? ""
        allowEmojis = c.flexibleBool(forKey: .allowEmojis) ?? false
        hideAttended = c.flexibleBool(forKey: .hideAttended) ?? false
        hideAttendedNotifications = c.flexibleBool(forKey: .hideAttendedNotifications) ?? false
        defaultCalendarId = c.flexibleString(forKey: .defaultCalendarId)
        persuasionLevel = AgentPersuasionOption.known(c.flexibleString(forKey: .persuasionLevel))
        languageLevel = AgentLanguageOption.known(c.flexibleString(forKey: .languageLevel))
        contactScope = AgentContactScopeOption.known(c.flexibleString(forKey: .contactScope))
        contactScopeCutoffAt = c.flexibleString(forKey: .contactScopeCutoffAt)
        responseDelay = (try? c.decodeIfPresent(AgentResponseDelayConfig.self, forKey: .responseDelay)) ?? .default
        replyDelivery = (try? c.decodeIfPresent(AgentReplyDeliveryConfig.self, forKey: .replyDelivery)) ?? .default
        followUp = (try? c.decodeIfPresent(AgentFollowUpConfig.self, forKey: .followUp)) ?? .default
        goalWorkflow = (try? c.decodeIfPresent(AgentGoalWorkflowConfig.self, forKey: .goalWorkflow)) ?? .default
        filters = (try? c.decodeIfPresent(AgentFilters.self, forKey: .filters)) ?? .empty
        createdAt = c.flexibleString(forKey: .createdAt)
        updatedAt = c.flexibleString(forKey: .updatedAt)
    }

    /// Nombre visible con fallback.
    var displayName: String { name.isEmpty ? "Agente" : name }
}

/// Body parcial de PUT /agents/:id.
struct ConversationalAgentDefInput: Encodable, Sendable {
    var name: String?
    var enabled: Bool?
    var aiProvider: String?
    var model: String?
    var identityMode: String?
    var identityUserId: String?
    var identityUserName: String?
    var identityCustomName: String?
    var position: Int?
    var objective: String?
    var customObjective: String?
    var successAction: String?
    var successExtras: [AgentSuccessExtra]?
    var requiredData: String?
    var handoffRules: String?
    var extraInstructions: String?
    var allowEmojis: Bool?
    var hideAttended: Bool?
    var hideAttendedNotifications: Bool?
    var defaultCalendarId: String?
    var persuasionLevel: String?
    var languageLevel: String?
    var contactScope: String?
    var responseDelay: AgentResponseDelayConfig?
    var replyDelivery: AgentReplyDeliveryConfig?
    var followUp: AgentFollowUpConfig?
    var goalWorkflow: AgentGoalWorkflowConfig?
    var filters: AgentFilters?
}

// MARK: - Configuraciones anidadas del formulario web

struct AgentResponseDelayConfig: Codable, Sendable, Equatable {
    var mode: String
    var fixedValue: Int
    var fixedUnit: String
    var minValue: Int
    var maxValue: Int
    var rangeUnit: String

    static let `default` = AgentResponseDelayConfig(
        mode: "none",
        fixedValue: 10,
        fixedUnit: "seconds",
        minValue: 1,
        maxValue: 10,
        rangeUnit: "minutes"
    )

    init(
        mode: String,
        fixedValue: Int,
        fixedUnit: String,
        minValue: Int,
        maxValue: Int,
        rangeUnit: String
    ) {
        self.mode = AgentResponseDelayModeOption.known(mode)
        self.fixedValue = fixedValue
        self.fixedUnit = AgentResponseDelayUnitOption.known(fixedUnit)
        self.minValue = minValue
        self.maxValue = maxValue
        self.rangeUnit = AgentResponseDelayUnitOption.known(rangeUnit)
    }

    enum CodingKeys: String, CodingKey {
        case mode, fixedValue, fixedUnit, minValue, maxValue, rangeUnit
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = AgentResponseDelayModeOption.known(c.flexibleString(forKey: .mode))
        fixedValue = max(0, c.flexibleInt(forKey: .fixedValue) ?? Self.default.fixedValue)
        fixedUnit = AgentResponseDelayUnitOption.known(c.flexibleString(forKey: .fixedUnit))
        minValue = max(0, c.flexibleInt(forKey: .minValue) ?? Self.default.minValue)
        maxValue = max(0, c.flexibleInt(forKey: .maxValue) ?? Self.default.maxValue)
        rangeUnit = AgentResponseDelayUnitOption.known(c.flexibleString(forKey: .rangeUnit))
    }
}

struct AgentReplyDeliveryConfig: Codable, Sendable, Equatable {
    var mode: String
    var splitMessagesEnabled: Bool
    var minMessageLengthToSplit: Int
    var maxBubbles: Int
    var minBubbleLength: Int
    var maxBubbleLength: Int
    var targetChars: Int
    var randomizeSplitting: Bool
    var delayBetweenBubblesEnabled: Bool
    var minDelaySeconds: Int
    var maxDelaySeconds: Int

    static let `default` = AgentReplyDeliveryConfig(
        mode: "split",
        splitMessagesEnabled: true,
        minMessageLengthToSplit: 120,
        maxBubbles: 6,
        minBubbleLength: 20,
        maxBubbleLength: 350,
        targetChars: 350,
        randomizeSplitting: true,
        delayBetweenBubblesEnabled: true,
        minDelaySeconds: 2,
        maxDelaySeconds: 7
    )

    init(
        mode: String,
        splitMessagesEnabled: Bool,
        minMessageLengthToSplit: Int,
        maxBubbles: Int,
        minBubbleLength: Int,
        maxBubbleLength: Int,
        targetChars: Int,
        randomizeSplitting: Bool,
        delayBetweenBubblesEnabled: Bool,
        minDelaySeconds: Int,
        maxDelaySeconds: Int
    ) {
        self.mode = AgentReplyDeliveryModeOption.known(mode)
        self.splitMessagesEnabled = splitMessagesEnabled
        self.minMessageLengthToSplit = minMessageLengthToSplit
        self.maxBubbles = maxBubbles
        self.minBubbleLength = minBubbleLength
        self.maxBubbleLength = maxBubbleLength
        self.targetChars = targetChars
        self.randomizeSplitting = randomizeSplitting
        self.delayBetweenBubblesEnabled = delayBetweenBubblesEnabled
        self.minDelaySeconds = minDelaySeconds
        self.maxDelaySeconds = maxDelaySeconds
    }

    enum CodingKeys: String, CodingKey {
        case mode, splitMessagesEnabled, minMessageLengthToSplit, maxBubbles
        case minBubbleLength, maxBubbleLength, targetChars, randomizeSplitting
        case delayBetweenBubblesEnabled, minDelaySeconds, maxDelaySeconds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = AgentReplyDeliveryModeOption.known(c.flexibleString(forKey: .mode))
        splitMessagesEnabled = c.flexibleBool(forKey: .splitMessagesEnabled) ?? (mode == "split")
        minMessageLengthToSplit = c.flexibleInt(forKey: .minMessageLengthToSplit) ?? Self.default.minMessageLengthToSplit
        maxBubbles = c.flexibleInt(forKey: .maxBubbles) ?? Self.default.maxBubbles
        minBubbleLength = c.flexibleInt(forKey: .minBubbleLength) ?? Self.default.minBubbleLength
        maxBubbleLength = c.flexibleInt(forKey: .maxBubbleLength) ?? Self.default.maxBubbleLength
        targetChars = c.flexibleInt(forKey: .targetChars) ?? Self.default.targetChars
        randomizeSplitting = c.flexibleBool(forKey: .randomizeSplitting) ?? Self.default.randomizeSplitting
        delayBetweenBubblesEnabled = c.flexibleBool(forKey: .delayBetweenBubblesEnabled) ?? Self.default.delayBetweenBubblesEnabled
        minDelaySeconds = c.flexibleInt(forKey: .minDelaySeconds) ?? Self.default.minDelaySeconds
        maxDelaySeconds = c.flexibleInt(forKey: .maxDelaySeconds) ?? Self.default.maxDelaySeconds
    }
}

struct AgentFollowUpStepConfig: Codable, Sendable, Equatable {
    var enabled: Bool
    var value: Int
    var unit: String

    init(enabled: Bool, value: Int, unit: String) {
        self.enabled = enabled
        self.value = value
        self.unit = AgentFollowUpUnitOption.known(unit)
    }

    enum CodingKeys: String, CodingKey {
        case enabled, value, unit
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.flexibleBool(forKey: .enabled) ?? false
        value = max(1, c.flexibleInt(forKey: .value) ?? 1)
        unit = AgentFollowUpUnitOption.known(c.flexibleString(forKey: .unit))
    }
}

struct AgentFollowUpConfig: Codable, Sendable, Equatable {
    var enabled: Bool
    var first: AgentFollowUpStepConfig
    var second: AgentFollowUpStepConfig
    var strategy: String

    static let defaultStrategy = [
        "Lee el historial y el contexto actual antes de escribir.",
        "Abre la conversación con un solo mensaje natural, corto y contextual.",
        "No menciones que es seguimiento automático ni que pasó cierto tiempo.",
        "Retoma el último punto útil que dejó la persona y deja una razón clara para responder.",
        "No cobres, no agendes y no ejecutes acciones de avance en este mensaje."
    ].joined(separator: " ")

    static let `default` = AgentFollowUpConfig(
        enabled: false,
        first: AgentFollowUpStepConfig(enabled: true, value: 30, unit: "minutes"),
        second: AgentFollowUpStepConfig(enabled: false, value: 2, unit: "hours"),
        strategy: defaultStrategy
    )

    init(
        enabled: Bool,
        first: AgentFollowUpStepConfig,
        second: AgentFollowUpStepConfig,
        strategy: String
    ) {
        self.enabled = enabled
        self.first = first
        self.second = second
        self.strategy = strategy
    }

    enum CodingKeys: String, CodingKey {
        case enabled, first, second, strategy
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.flexibleBool(forKey: .enabled) ?? Self.default.enabled
        first = (try? c.decodeIfPresent(AgentFollowUpStepConfig.self, forKey: .first)) ?? Self.default.first
        second = (try? c.decodeIfPresent(AgentFollowUpStepConfig.self, forKey: .second)) ?? Self.default.second
        strategy = c.flexibleString(forKey: .strategy) ?? Self.default.strategy
    }
}

struct AgentGoalWorkflowConfig: Codable, Sendable, Equatable {
    var appointments: AgentGoalAppointmentsWorkflow
    var sales: AgentGoalSalesWorkflow
    var data: AgentGoalDataWorkflow
    var qualification: AgentGoalQualificationWorkflow
    var triggerLink: AgentGoalTriggerLinkWorkflow
    var deposit: AgentGoalDepositWorkflow
    var completion: AgentGoalCompletionWorkflow
    var attention: AgentGoalAttentionWorkflow

    static let `default` = AgentGoalWorkflowConfig(
        appointments: .default,
        sales: .default,
        data: .default,
        qualification: .default,
        triggerLink: .default,
        deposit: .default,
        completion: .default,
        attention: .default
    )

    init(
        appointments: AgentGoalAppointmentsWorkflow,
        sales: AgentGoalSalesWorkflow,
        data: AgentGoalDataWorkflow,
        qualification: AgentGoalQualificationWorkflow,
        triggerLink: AgentGoalTriggerLinkWorkflow,
        deposit: AgentGoalDepositWorkflow,
        completion: AgentGoalCompletionWorkflow,
        attention: AgentGoalAttentionWorkflow
    ) {
        self.appointments = appointments
        self.sales = sales
        self.data = data
        self.qualification = qualification
        self.triggerLink = triggerLink
        self.deposit = deposit
        self.completion = completion
        self.attention = attention
    }

    enum CodingKeys: String, CodingKey {
        case appointments, sales, data, qualification, triggerLink, deposit, completion, attention
    }

    /// Decode tolerante: cada sub-config cae a su default si falta o viene mal
    /// formada, para que un backend viejo (sin `attention` o sin `deposit.methods`)
    /// no tire todo el workflow al default y el PUT completo no borre nada.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appointments = (try? c.decodeIfPresent(AgentGoalAppointmentsWorkflow.self, forKey: .appointments)) ?? .default
        sales = (try? c.decodeIfPresent(AgentGoalSalesWorkflow.self, forKey: .sales)) ?? .default
        data = (try? c.decodeIfPresent(AgentGoalDataWorkflow.self, forKey: .data)) ?? .default
        qualification = (try? c.decodeIfPresent(AgentGoalQualificationWorkflow.self, forKey: .qualification)) ?? .default
        triggerLink = (try? c.decodeIfPresent(AgentGoalTriggerLinkWorkflow.self, forKey: .triggerLink)) ?? .default
        deposit = (try? c.decodeIfPresent(AgentGoalDepositWorkflow.self, forKey: .deposit)) ?? .default
        completion = (try? c.decodeIfPresent(AgentGoalCompletionWorkflow.self, forKey: .completion)) ?? .default
        attention = (try? c.decodeIfPresent(AgentGoalAttentionWorkflow.self, forKey: .attention)) ?? .default
    }
}

struct AgentGoalAppointmentsWorkflow: Codable, Sendable, Equatable {
    var owner: String
    var calendarId: String?
    var url: String
    var trackingParam: String
    var allowOverlappingAppointments: Bool

    static let `default` = AgentGoalAppointmentsWorkflow(
        owner: "human",
        calendarId: nil,
        url: "",
        trackingParam: "ristak_goal_id",
        allowOverlappingAppointments: false
    )
}

struct AgentGoalSalesWorkflow: Codable, Sendable, Equatable {
    var owner: String
    var productId: String
    var priceId: String
    var productName: String
    var priceName: String
    var amount: Double?
    var currency: String
    var paymentMode: String
    var url: String
    var trackingParam: String

    static let `default` = AgentGoalSalesWorkflow(
        owner: "human",
        productId: "",
        priceId: "",
        productName: "",
        priceName: "",
        amount: nil,
        currency: "",
        paymentMode: "full_payment",
        url: "",
        trackingParam: "ristak_goal_id"
    )
}

struct AgentGoalDataWorkflow: Codable, Sendable, Equatable {
    var afterComplete: String
    static let `default` = AgentGoalDataWorkflow(afterComplete: "human")
}

struct AgentGoalQualificationWorkflow: Codable, Sendable, Equatable {
    var questions: String
    var qualifies: String
    var disqualifies: String
    static let `default` = AgentGoalQualificationWorkflow(questions: "", qualifies: "", disqualifies: "")
}

struct AgentGoalTriggerLinkWorkflow: Codable, Sendable, Equatable {
    var triggerLinkId: String
    var triggerLinkPublicId: String
    var triggerLinkName: String
    var triggerLinkUrl: String
    static let `default` = AgentGoalTriggerLinkWorkflow(triggerLinkId: "", triggerLinkPublicId: "", triggerLinkName: "", triggerLinkUrl: "")
}

struct AgentGoalDepositWorkflow: Codable, Sendable, Equatable {
    var enabled: Bool
    var mode: String
    var amount: Double?
    var minAmount: Double?
    var maxAmount: Double?
    var currency: String
    var methods: AgentGoalDepositMethods
    var bankTransferDetails: String

    static let `default` = AgentGoalDepositWorkflow(
        enabled: false,
        mode: "fixed",
        amount: nil,
        minAmount: nil,
        maxAmount: nil,
        currency: "",
        methods: .default,
        bankTransferDetails: ""
    )

    init(
        enabled: Bool,
        mode: String,
        amount: Double?,
        minAmount: Double?,
        maxAmount: Double?,
        currency: String,
        methods: AgentGoalDepositMethods = .default,
        bankTransferDetails: String = ""
    ) {
        self.enabled = enabled
        self.mode = mode
        self.amount = amount
        self.minAmount = minAmount
        self.maxAmount = maxAmount
        self.currency = currency
        self.methods = methods
        self.bankTransferDetails = bankTransferDetails
    }

    enum CodingKeys: String, CodingKey {
        case enabled, mode, amount, minAmount, maxAmount, currency, methods, bankTransferDetails
    }

    /// Decode tolerante: `methods` y `bankTransferDetails` son campos nuevos del
    /// backend; si faltan caen a sus defaults en vez de tumbar el decode. Todos
    /// los campos se codifican en el PUT para no borrar configuración hecha en web.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.flexibleBool(forKey: .enabled) ?? Self.default.enabled
        mode = c.flexibleString(forKey: .mode) ?? Self.default.mode
        amount = c.flexibleDouble(forKey: .amount)
        minAmount = c.flexibleDouble(forKey: .minAmount)
        maxAmount = c.flexibleDouble(forKey: .maxAmount)
        currency = c.flexibleString(forKey: .currency) ?? Self.default.currency
        methods = (try? c.decodeIfPresent(AgentGoalDepositMethods.self, forKey: .methods)) ?? .default
        bankTransferDetails = c.flexibleString(forKey: .bankTransferDetails) ?? Self.default.bankTransferDetails
    }
}

/// Métodos con los que la IA puede cobrar el anticipo.
/// `paymentLink` default true para no cambiar el comportamiento de configs previas.
struct AgentGoalDepositMethods: Codable, Sendable, Equatable {
    var paymentLink: Bool
    var bankTransfer: Bool

    static let `default` = AgentGoalDepositMethods(paymentLink: true, bankTransfer: false)

    init(paymentLink: Bool, bankTransfer: Bool) {
        self.paymentLink = paymentLink
        self.bankTransfer = bankTransfer
    }

    enum CodingKeys: String, CodingKey {
        case paymentLink, bankTransfer
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paymentLink = c.flexibleBool(forKey: .paymentLink) ?? Self.default.paymentLink
        bankTransfer = c.flexibleBool(forKey: .bankTransfer) ?? Self.default.bankTransfer
    }
}

/// Reglas de atención transversales al objetivo. `pastClientsToHuman`: si la IA
/// detecta que ya es cliente (o dice serlo), pasa el chat directo a un humano.
struct AgentGoalAttentionWorkflow: Codable, Sendable, Equatable {
    var pastClientsToHuman: Bool

    static let `default` = AgentGoalAttentionWorkflow(pastClientsToHuman: false)

    init(pastClientsToHuman: Bool) {
        self.pastClientsToHuman = pastClientsToHuman
    }

    enum CodingKeys: String, CodingKey {
        case pastClientsToHuman
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pastClientsToHuman = c.flexibleBool(forKey: .pastClientsToHuman) ?? Self.default.pastClientsToHuman
    }
}

struct AgentGoalCompletionWorkflow: Codable, Sendable, Equatable {
    var mode: String
    var userId: String
    var userName: String
    static let `default` = AgentGoalCompletionWorkflow(mode: "notify_only", userId: "", userName: "")
}

struct AgentSuccessExtra: Codable, Sendable, Equatable, Identifiable {
    var id: String { "\(type)-\(tag)-\(field)-\(value)" }
    var type: String
    var tag: String
    var field: String
    var value: String

    init(type: String = "add_tag", tag: String = "", field: String = "", value: String = "") {
        self.type = AgentSuccessExtraOption.known(type)
        self.tag = tag
        self.field = field
        self.value = value
    }

    enum CodingKeys: String, CodingKey {
        case type, tag, field, value
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = AgentSuccessExtraOption.known(c.flexibleString(forKey: .type))
        tag = c.flexibleString(forKey: .tag) ?? ""
        field = c.flexibleString(forKey: .field) ?? ""
        value = c.flexibleString(forKey: .value) ?? ""
    }
}

struct AgentFilters: Codable, Sendable, Equatable {
    var entry: AgentFilterSide
    var exit: AgentFilterSide

    static let empty = AgentFilters(entry: AgentFilterSide(), exit: AgentFilterSide())
}

struct AgentFilterSide: Codable, Sendable, Equatable {
    var groups: [AgentConditionGroup] = []
}

struct AgentConditionGroup: Codable, Sendable, Equatable {
    var conditions: [AgentCondition] = []
}

struct AgentCondition: Codable, Sendable, Equatable {
    var category: String
    var params: [AgentConditionParam]
}

struct AgentConditionParam: Codable, Sendable, Equatable {
    var field: String?
    var operatorValue: String?
    var value: String?
    var values: [String]?
    var date: String?
    var dateEnd: String?
    var amount: Double?
    var amountMax: Double?
    var offsetValue: Int?
    var offsetUnit: String?
    var timeStart: String?
    var timeEnd: String?
    var fieldKey: String?
    var replyMode: String?
    var postId: String?
    var postName: String?

    enum CodingKeys: String, CodingKey {
        case field
        case operatorValue = "operator"
        case value, values, date, dateEnd, amount, amountMax
        case offsetValue, offsetUnit, timeStart, timeEnd, fieldKey
        case replyMode, postId, postName
    }

    init(
        field: String? = nil,
        operatorValue: String? = nil,
        value: String? = nil,
        values: [String]? = nil,
        date: String? = nil,
        dateEnd: String? = nil,
        amount: Double? = nil,
        amountMax: Double? = nil,
        offsetValue: Int? = nil,
        offsetUnit: String? = nil,
        timeStart: String? = nil,
        timeEnd: String? = nil,
        fieldKey: String? = nil,
        replyMode: String? = nil,
        postId: String? = nil,
        postName: String? = nil
    ) {
        self.field = field
        self.operatorValue = operatorValue
        self.value = value
        self.values = values
        self.date = date
        self.dateEnd = dateEnd
        self.amount = amount
        self.amountMax = amountMax
        self.offsetValue = offsetValue
        self.offsetUnit = offsetUnit
        self.timeStart = timeStart
        self.timeEnd = timeEnd
        self.fieldKey = fieldKey
        self.replyMode = replyMode
        self.postId = postId
        self.postName = postName
    }
}

struct AgentFilterOptions: Decodable, Sendable, Equatable {
    let ads: [AgentFilterAdOption]
    let businessPhones: [AgentFilterBusinessPhoneOption]
    let customFields: [AgentFilterCustomFieldOption]

    enum CodingKeys: String, CodingKey {
        case ads, businessPhones, customFields
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ads = (try? c.decodeIfPresent([AgentFilterAdOption].self, forKey: .ads)) ?? []
        businessPhones = (try? c.decodeIfPresent([AgentFilterBusinessPhoneOption].self, forKey: .businessPhones)) ?? []
        customFields = (try? c.decodeIfPresent([AgentFilterCustomFieldOption].self, forKey: .customFields)) ?? []
    }

    static let empty = AgentFilterOptions(ads: [], businessPhones: [], customFields: [])

    init(ads: [AgentFilterAdOption], businessPhones: [AgentFilterBusinessPhoneOption], customFields: [AgentFilterCustomFieldOption]) {
        self.ads = ads
        self.businessPhones = businessPhones
        self.customFields = customFields
    }
}

struct AgentFilterAdOption: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let campaign: String?
    let detected: Bool
}

struct AgentFilterBusinessPhoneOption: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let label: String
}

struct AgentFilterCustomFieldOption: Decodable, Sendable, Equatable, Identifiable {
    var id: String { key }
    let key: String
    let label: String
}

struct AgentFilterCategoryDef: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let baseLabel: String
    let params: [AgentFilterParamDef]
    let defaultParams: [AgentConditionParam]?
}

struct AgentFilterParamDef: Sendable, Equatable, Identifiable {
    var id: String { field }
    let field: String
    let label: String
    let operators: [AgentFilterOperatorDef]
}

struct AgentFilterOperatorDef: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let valueKind: String
    let placeholder: String
}

enum AgentFilterCatalog {
    static let channelOptions: [PickerOption] = [
        .init(id: "chat", label: "Chats y SMS"),
        .init(id: "whatsapp", label: "WhatsApp"),
        .init(id: "instagram", label: "Instagram DM"),
        .init(id: "messenger", label: "Messenger"),
        .init(id: "facebook_comment", label: "Comentario de Facebook"),
        .init(id: "instagram_comment", label: "Comentario de Instagram"),
        .init(id: "sms", label: "SMS"),
        .init(id: "webchat", label: "Chat web"),
        .init(id: "email", label: "Correo")
    ]

    static let commentReplyModeOptions: [PickerOption] = [
        .init(id: "public", label: "Responder en el comentario"),
        .init(id: "private", label: "Responder por privado (DM)"),
        .init(id: "public_then_private", label: "Responder comentario y seguir por privado")
    ]

    static let offsetUnitOptions: [PickerOption] = [
        .init(id: "minutes", label: "minutos"),
        .init(id: "hours", label: "horas"),
        .init(id: "days", label: "días")
    ]

    static let weekdayOptions: [PickerOption] = [
        .init(id: "mon", label: "lunes"),
        .init(id: "tue", label: "martes"),
        .init(id: "wed", label: "miércoles"),
        .init(id: "thu", label: "jueves"),
        .init(id: "fri", label: "viernes"),
        .init(id: "sat", label: "sábado"),
        .init(id: "sun", label: "domingo")
    ]

    static let commentChannels = Set(["facebook_comment", "instagram_comment"])

    static let categories: [AgentFilterCategoryDef] = [
        .init(
            id: "channel",
            label: "Canal",
            baseLabel: "llegó por cualquier canal",
            params: [
                .init(
                    field: "channel",
                    label: "Canal",
                    operators: [
                        op("is", "es", "channel"),
                        op("is_not", "no es", "channel")
                    ]
                )
            ],
            defaultParams: [AgentConditionParam(field: "channel", operatorValue: "is", value: "chat")]
        ),
        .init(
            id: "message",
            label: "Mensaje",
            baseLabel: "llegó cualquier mensaje",
            params: [
                .init(
                    field: "text",
                    label: "Texto del mensaje",
                    operators: [
                        op("contains", "contiene", "text", "Texto a buscar"),
                        op("not_contains", "no contiene", "text", "Texto a evitar"),
                        op("contains_any", "contiene alguna de estas palabras", "list", "Palabra y Enter"),
                        op("contains_all", "contiene todas estas palabras", "list", "Palabra y Enter"),
                        op("starts_with", "empieza con", "text", "Primeras palabras"),
                        op("ends_with", "termina con", "text", "Últimas palabras"),
                        op("equals", "es exactamente", "text", "Mensaje exacto")
                    ]
                ),
                .init(
                    field: "business_phone",
                    label: "Número donde llegó el mensaje",
                    operators: [
                        op("is", "llegó al número", "businessPhone"),
                        op("is_not", "no llegó al número", "businessPhone")
                    ]
                )
            ],
            defaultParams: nil
        ),
        .init(
            id: "tags",
            label: "Etiquetas",
            baseLabel: "tiene alguna etiqueta",
            params: [
                .init(
                    field: "tag",
                    label: "Etiqueta",
                    operators: [
                        op("has", "Tiene", "tag", "Etiqueta"),
                        op("not_has", "No tiene", "tag", "Etiqueta"),
                        op("has_any", "Tiene alguna", "tagList", "Etiqueta y Enter"),
                        op("has_all", "Tiene todas", "tagList", "Etiqueta y Enter"),
                        op("has_none", "No tiene ninguna", "tagList", "Etiqueta y Enter")
                    ]
                )
            ],
            defaultParams: nil
        ),
        .init(
            id: "contact",
            label: "Contacto",
            baseLabel: "cualquier contacto",
            params: [
                textParam("name", "Nombre completo", "Nombre completo"),
                textParam("first_name", "Nombre", "Nombre"),
                textParam("last_name", "Apellido", "Apellido"),
                .init(
                    field: "email",
                    label: "Correo electrónico",
                    operators: [
                        op("contains", "contiene", "text", "ej. @gmail.com"),
                        op("not_contains", "no contiene", "text", "ej. @gmail.com"),
                        op("is", "es igual a", "text", "correo@ejemplo.com"),
                        op("is_not", "no es igual a", "text", "correo@ejemplo.com"),
                        op("starts_with", "empieza con", "text", "inicio del correo"),
                        op("ends_with", "termina con", "text", "@dominio.com"),
                        op("has", "no está vacío", "none"),
                        op("no_has", "está vacío", "none")
                    ]
                ),
                textParam("phone", "Teléfono", "ej. 33 o +52"),
                .init(
                    field: "custom_field",
                    label: "Campo personalizado",
                    operators: [
                        op("is", "es igual a", "customFieldValue", "Valor"),
                        op("is_not", "no es igual a", "customFieldValue", "Valor"),
                        op("contains", "contiene", "customFieldValue", "Valor"),
                        op("not_contains", "no contiene", "customFieldValue", "Valor"),
                        op("starts_with", "empieza con", "customFieldValue", "Valor"),
                        op("ends_with", "termina con", "customFieldValue", "Valor"),
                        op("has_value", "no está vacío", "customField"),
                        op("empty", "está vacío", "customField")
                    ]
                ),
                textParam("source", "Fuente", "ej. meta_ads, google"),
                textParam("attribution_source", "Fuente de sesión", "ej. facebook, google"),
                textParam("attribution_medium", "Medio", "ej. cpc, organic"),
                textParam("attribution_ad", "Anuncio atribuido", "Nombre o ID del anuncio"),
                textParam("visitor_id", "Visitor ID", "ID del visitante"),
                textParam("ghl_contact_id", "ID de HighLevel", "ID de contacto"),
                .init(
                    field: "preferred_phone",
                    label: "Número WhatsApp preferido",
                    operators: [
                        op("is", "es", "businessPhone"),
                        op("is_not", "no es", "businessPhone"),
                        op("not_empty", "no está vacío", "none"),
                        op("empty", "está vacío", "none")
                    ]
                ),
                .init(
                    field: "customer",
                    label: "Es comprador",
                    operators: [
                        op("is_customer", "ya compró", "none"),
                        op("not_customer", "todavía no compra", "none")
                    ]
                ),
                dateParam("created", "Fecha de creación", "se creó"),
                dateParam("updated", "Fecha de actualización", "se actualizó"),
                dateParam("last_purchase", "Última compra", "compró"),
                .init(
                    field: "assigned",
                    label: "Quién lo atiende",
                    operators: [
                        op("to", "lo atiende", "text", "Nombre del usuario"),
                        op("not_to", "no lo atiende", "text", "Nombre del usuario"),
                        op("any", "tiene a alguien asignado", "none"),
                        op("none", "no tiene a nadie asignado", "none")
                    ]
                )
            ],
            defaultParams: nil
        ),
        .init(
            id: "appointments",
            label: "Citas",
            baseLabel: "tiene una cita agendada",
            params: [
                .init(
                    field: "presence",
                    label: "Tiene o no tiene cita",
                    operators: [
                        op("has", "sí tiene cita", "none"),
                        op("none", "no tiene ninguna cita", "none")
                    ]
                ),
                .init(
                    field: "calendar",
                    label: "Calendario específico",
                    operators: [
                        op("is", "la cita está en", "calendar"),
                        op("is_not", "la cita no está en", "calendar")
                    ]
                ),
                .init(
                    field: "status",
                    label: "Estado de la cita",
                    operators: [
                        op("confirmed", "confirmada", "none"),
                        op("pending", "pendiente de confirmar", "none"),
                        op("cancelled", "cancelada", "none"),
                        op("showed", "asistió a la cita", "none"),
                        op("noshow", "no asistió a la cita", "none")
                    ]
                ),
                .init(
                    field: "timing",
                    label: "Cuándo es la cita",
                    operators: [
                        op("upcoming", "es en el futuro", "none"),
                        op("past_due", "ya pasó", "none"),
                        op("today", "es hoy", "none")
                    ]
                ),
                .init(
                    field: "date",
                    label: "Fecha de la cita",
                    operators: [
                        op("is", "es exactamente el", "date", "YYYY-MM-DD"),
                        op("not", "no es el", "date", "YYYY-MM-DD"),
                        op("before", "es antes del", "date", "YYYY-MM-DD"),
                        op("after", "es después del", "date", "YYYY-MM-DD"),
                        op("between", "está entre", "dateRange", "YYYY-MM-DD")
                    ]
                ),
                .init(
                    field: "window",
                    label: "Tiempo antes o después de la cita",
                    operators: [
                        op("before", "antes de la cita", "offset"),
                        op("after", "después de la cita", "offset")
                    ]
                )
            ],
            defaultParams: nil
        ),
        .init(
            id: "payments",
            label: "Pagos",
            baseLabel: "tiene un pago registrado",
            params: [
                .init(
                    field: "presence",
                    label: "Tiene o no tiene pago",
                    operators: [
                        op("has", "sí tiene pago", "none"),
                        op("none", "no tiene ningún pago", "none")
                    ]
                ),
                .init(
                    field: "status",
                    label: "Estado del pago",
                    operators: [
                        op("received", "pago recibido", "none"),
                        op("pending", "pago pendiente", "none"),
                        op("failed", "pago fallido", "none"),
                        op("refunded", "pago devuelto", "none")
                    ]
                ),
                .init(
                    field: "product",
                    label: "Producto comprado",
                    operators: [
                        op("is", "es igual a", "text", "Nombre del producto"),
                        op("is_not", "no es igual a", "text", "Nombre del producto"),
                        op("contains", "contiene", "text", "Parte del nombre"),
                        op("not_contains", "no contiene", "text", "Parte del nombre")
                    ]
                ),
                .init(
                    field: "amount",
                    label: "Monto del pago",
                    operators: [
                        op("eq", "es igual a", "amount"),
                        op("gt", "es mayor que", "amount"),
                        op("lt", "es menor que", "amount"),
                        op("between", "está entre", "amountRange")
                    ]
                )
            ],
            defaultParams: nil
        ),
        .init(
            id: "ads",
            label: "Anuncios",
            baseLabel: "existe atribución de anuncio",
            params: [
                .init(
                    field: "presence",
                    label: "Atribución de anuncio",
                    operators: [
                        op("exists", "existe", "none"),
                        op("not_exists", "no existe", "none")
                    ]
                ),
                .init(
                    field: "ad",
                    label: "Anuncio",
                    operators: [
                        op("is", "es igual a", "ad"),
                        op("is_not", "no es igual a", "ad"),
                        op("contains", "contiene", "adText", "Nombre, campaña o ID"),
                        op("not_contains", "no contiene", "adText", "Nombre, campaña o ID"),
                        op("starts_with", "empieza con", "adText", "Nombre, campaña o ID"),
                        op("ends_with", "termina con", "adText", "Nombre, campaña o ID")
                    ]
                )
            ],
            defaultParams: nil
        ),
        .init(
            id: "schedule",
            label: "Horario",
            baseLabel: "a cualquier hora",
            params: [
                .init(
                    field: "time",
                    label: "Rango de horas",
                    operators: [
                        op("between", "la hora está entre", "timeRange"),
                        op("outside", "la hora está fuera de", "timeRange")
                    ]
                ),
                .init(
                    field: "day",
                    label: "Día de la semana",
                    operators: [
                        op("is", "el día es", "weekdays", "Día y Enter")
                    ]
                )
            ],
            defaultParams: [AgentConditionParam(field: "time", operatorValue: "between", timeStart: "09:00", timeEnd: "18:00")]
        )
    ]

    static func category(_ id: String?) -> AgentFilterCategoryDef {
        categories.first(where: { $0.id == id }) ?? categories[0]
    }

    static func param(categoryId: String?, field: String?) -> AgentFilterParamDef {
        let categoryDef = category(categoryId)
        return categoryDef.params.first(where: { $0.field == field }) ?? categoryDef.params[0]
    }

    static func operatorDef(categoryId: String?, field: String?, operatorId: String?) -> AgentFilterOperatorDef {
        let paramDef = param(categoryId: categoryId, field: field)
        return paramDef.operators.first(where: { $0.id == operatorId }) ?? paramDef.operators[0]
    }

    static func defaultCondition(categoryId: String) -> AgentCondition {
        let categoryDef = category(categoryId)
        return AgentCondition(
            category: categoryDef.id,
            params: categoryDef.defaultParams ?? [defaultParam(categoryId: categoryDef.id, field: categoryDef.params[0].field)]
        )
    }

    static func defaultParam(categoryId: String, field: String, operatorId: String? = nil) -> AgentConditionParam {
        let op = operatorId.map { operatorDef(categoryId: categoryId, field: field, operatorId: $0) }
            ?? param(categoryId: categoryId, field: field).operators[0]
        var param = AgentConditionParam(field: field, operatorValue: op.id)
        switch op.valueKind {
        case "channel":
            param.value = "chat"
        case "list", "tagList", "weekdays":
            param.values = []
        case "offset":
            let isContactDate = field == "created" || field == "updated" || field == "last_purchase"
            param.offsetValue = isContactDate ? 7 : 30
            param.offsetUnit = isContactDate ? "days" : "minutes"
        case "timeRange":
            param.timeStart = "09:00"
            param.timeEnd = "18:00"
        default:
            break
        }
        return param
    }

    static func conditionSummary(
        _ condition: AgentCondition,
        calendars: [RistakCalendar],
        options: AgentFilterOptions
    ) -> String {
        let categoryDef = category(condition.category)
        guard !condition.params.isEmpty else {
            return "\(categoryDef.label): \(categoryDef.baseLabel)"
        }
        let pieces = condition.params.map { param in
            paramSummary(param, categoryId: condition.category, calendars: calendars, options: options)
        }
        return "\(categoryDef.label): \(pieces.joined(separator: " · "))"
    }

    static func paramSummary(
        _ param: AgentConditionParam,
        categoryId: String,
        calendars: [RistakCalendar],
        options: AgentFilterOptions
    ) -> String {
        let paramDef = Self.param(categoryId: categoryId, field: param.field)
        let op = operatorDef(categoryId: categoryId, field: param.field, operatorId: param.operatorValue)
        let value = valueSummary(param, kind: op.valueKind, calendars: calendars, options: options)
        if value.isEmpty {
            return "\(paramDef.label) \(op.label)"
        }
        return "\(paramDef.label) \(op.label) \(value)"
    }

    static func valueSummary(
        _ param: AgentConditionParam,
        kind: String,
        calendars: [RistakCalendar],
        options: AgentFilterOptions
    ) -> String {
        switch kind {
        case "none", "customField":
            if kind == "customField" {
                return options.customFields.first(where: { $0.key == param.fieldKey })?.label ?? param.fieldKey ?? "campo"
            }
            return ""
        case "channel":
            return channelOptions.first(where: { $0.id == param.value })?.label ?? param.value ?? "..."
        case "calendar":
            return calendars.first(where: { $0.id == param.value })?.name ?? param.value ?? "..."
        case "businessPhone":
            return options.businessPhones.first(where: { $0.id == param.value })?.label ?? param.value ?? "..."
        case "ad":
            return options.ads.first(where: { $0.id == param.value })?.name ?? param.value ?? "..."
        case "list", "tagList", "weekdays":
            let values = param.values ?? []
            if kind == "weekdays" {
                return values.map { value in weekdayOptions.first(where: { $0.id == value })?.label ?? value }.joined(separator: ", ")
            }
            return values.joined(separator: ", ")
        case "date":
            return param.date ?? "..."
        case "dateRange":
            return "\((param.date ?? "...")) y \((param.dateEnd ?? "..."))"
        case "offset":
            let unit = offsetUnitOptions.first(where: { $0.id == param.offsetUnit })?.label ?? param.offsetUnit ?? "minutos"
            return "\(param.offsetValue ?? 0) \(unit)"
        case "amount":
            return param.amount.map { String($0) } ?? "0"
        case "amountRange":
            return "\((param.amount.map { String($0) } ?? "0")) y \((param.amountMax.map { String($0) } ?? "0"))"
        case "timeRange":
            return "\((param.timeStart ?? "09:00")) y \((param.timeEnd ?? "18:00"))"
        default:
            return param.value ?? ""
        }
    }

    private static func op(_ id: String, _ label: String, _ valueKind: String, _ placeholder: String = "") -> AgentFilterOperatorDef {
        AgentFilterOperatorDef(id: id, label: label, valueKind: valueKind, placeholder: placeholder)
    }

    private static func textParam(_ field: String, _ label: String, _ placeholder: String) -> AgentFilterParamDef {
        AgentFilterParamDef(
            field: field,
            label: label,
            operators: [
                op("contains", "contiene", "text", placeholder),
                op("not_contains", "no contiene", "text", placeholder),
                op("is", "es igual a", "text", placeholder),
                op("is_not", "no es igual a", "text", placeholder),
                op("starts_with", "empieza con", "text", placeholder),
                op("ends_with", "termina con", "text", placeholder),
                op("not_empty", "no está vacío", "none"),
                op("empty", "está vacío", "none")
            ]
        )
    }

    private static func dateParam(_ field: String, _ label: String, _ subject: String) -> AgentFilterParamDef {
        AgentFilterParamDef(
            field: field,
            label: label,
            operators: [
                op("within", "\(subject) hace menos de", "offset"),
                op("older_than", "\(subject) hace más de", "offset"),
                op("before", "\(subject) antes de", "date", "YYYY-MM-DD"),
                op("after", "\(subject) después de", "date", "YYYY-MM-DD"),
                op("between", "\(subject) entre fechas", "dateRange", "YYYY-MM-DD")
            ]
        )
    }
}

struct PickerOption: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
}

// MARK: - Catálogos de opciones (mismo orden que el formulario web)

enum AgentObjectiveOption: String, CaseIterable, Sendable {
    case citas, ventas, datos, filtrar, custom

    var label: String {
        switch self {
        case .citas: return "Agendar citas"
        case .ventas: return "Cerrar ventas"
        case .datos: return "Pedir datos"
        case .filtrar: return "Filtrar curiosos"
        case .custom: return "Objetivo propio"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.citas.rawValue
    }
}

enum AgentIdentityOption: String, CaseIterable, Sendable {
    case business, user, custom, agent

    var label: String {
        switch self {
        case .business: return "Representante del negocio"
        case .user: return "Persona del equipo"
        case .custom: return "Nombre personalizado"
        case .agent: return "Nombre del agente"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.business.rawValue
    }
}

enum AgentPersuasionOption: String, CaseIterable, Sendable {
    case low, medium, high

    var label: String {
        switch self {
        case .low: return "Anfitrión"
        case .medium: return "Estratega"
        case .high: return "Cerrador"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.high.rawValue
    }
}

enum AgentLanguageOption: String, CaseIterable, Sendable {
    case professional, intermediate, colloquial

    var label: String {
        switch self {
        case .professional: return "Ejecutivo"
        case .intermediate: return "Cómplice"
        case .colloquial: return "Callejero"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.intermediate.rawValue
    }
}

enum AgentContactScopeOption: String, CaseIterable, Sendable {
    case new_only, all, existing_only

    var label: String {
        switch self {
        case .new_only: return "A todos los nuevos contactos desde ahora"
        case .all: return "A todos los nuevos mensajes desde ahora"
        case .existing_only: return "A todos los contactos existentes"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.all.rawValue
    }
}

enum AgentSuccessActionOption: String, CaseIterable, Sendable {
    case readyForHuman = "ready_for_human"
    case bookAppointment = "book_appointment"
    case readyToBuy = "ready_to_buy"
    case sendGoalURL = "send_goal_url"
    case sendTriggerLink = "send_trigger_link"

    var label: String {
        switch self {
        case .readyForHuman: return "Un humano"
        case .bookAppointment: return "El agente IA"
        case .readyToBuy: return "El agente IA"
        case .sendGoalURL: return "La IA mandando un enlace"
        case .sendTriggerLink: return "La IA mandando un enlace"
        }
    }
}

enum AgentResponseDelayModeOption: String, CaseIterable, Sendable {
    case none, fixed, random

    var label: String {
        switch self {
        case .none: return "No esperar"
        case .fixed: return "Esperar tiempo fijo"
        case .random: return "Aleatorio en un rango"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.none.rawValue
    }
}

enum AgentResponseDelayUnitOption: String, CaseIterable, Sendable {
    case seconds, minutes

    var label: String {
        switch self {
        case .seconds: return "Segundos"
        case .minutes: return "Minutos"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.seconds.rawValue
    }
}

enum AgentReplyDeliveryModeOption: String, CaseIterable, Sendable {
    case single, split

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.single.rawValue
    }
}

enum AgentFollowUpUnitOption: String, CaseIterable, Sendable {
    case minutes, hours

    var label: String {
        switch self {
        case .minutes: return "Minutos"
        case .hours: return "Horas"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.minutes.rawValue
    }
}

enum AgentCompletionModeOption: String, CaseIterable, Sendable {
    case notify_only, assign_user

    var label: String {
        switch self {
        case .notify_only: return "Pasar a humano y notificar"
        case .assign_user: return "Asignar usuario y notificar"
        }
    }
}

enum AgentSuccessExtraOption: String, CaseIterable, Sendable {
    case add_tag, remove_tag, set_custom_field

    var label: String {
        switch self {
        case .add_tag: return "Agregar etiqueta"
        case .remove_tag: return "Quitar etiqueta"
        case .set_custom_field: return "Cambiar campo personalizado"
        }
    }

    static func known(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Self(rawValue: normalized)?.rawValue ?? Self.add_tag.rawValue
    }
}

enum AgentDepositModeOption: String, CaseIterable, Sendable {
    case fixed, range

    var label: String {
        switch self {
        case .fixed: return "Valor único"
        case .range: return "Rango"
        }
    }
}

enum AgentSalesPaymentModeOption: String, CaseIterable, Sendable {
    case full_payment, deposit

    var label: String {
        switch self {
        case .full_payment: return "Venta completa"
        case .deposit: return "Solicitar anticipo"
        }
    }
}

struct AgentAIModelOption: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
}

struct AgentAIProviderOption: Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let defaultModel: String
    let models: [AgentAIModelOption]
}

enum AgentAIProviderCatalog {
    static let providers: [AgentAIProviderOption] = [
        AgentAIProviderOption(
            id: "openai",
            label: "OpenAI",
            defaultModel: "gpt-5.4-mini",
            models: [
                .init(id: "gpt-5.5", label: "GPT-5.5"),
                .init(id: "gpt-5.5-pro", label: "GPT-5.5 pro"),
                .init(id: "gpt-5.4", label: "GPT-5.4"),
                .init(id: "gpt-5.4-pro", label: "GPT-5.4 pro"),
                .init(id: "gpt-5.4-mini", label: "GPT-5.4 Mini"),
                .init(id: "gpt-5.4-nano", label: "GPT-5.4 nano"),
                .init(id: "gpt-5.2", label: "GPT-5.2"),
                .init(id: "gpt-5.2-pro", label: "GPT-5.2 pro"),
                .init(id: "gpt-5.1", label: "GPT-5.1"),
                .init(id: "gpt-5", label: "GPT-5"),
                .init(id: "gpt-5-pro", label: "GPT-5 pro"),
                .init(id: "gpt-5-mini", label: "GPT-5 mini"),
                .init(id: "gpt-5-nano", label: "GPT-5 nano"),
                .init(id: "chat-latest", label: "chat-latest"),
                .init(id: "gpt-5.3-chat-latest", label: "GPT-5.3 Chat"),
                .init(id: "gpt-5.2-chat-latest", label: "GPT-5.2 Chat"),
                .init(id: "gpt-5.1-chat-latest", label: "GPT-5.1 Chat"),
                .init(id: "gpt-5-chat-latest", label: "GPT-5 Chat"),
                .init(id: "chatgpt-4o-latest", label: "ChatGPT-4o"),
                .init(id: "gpt-4.1", label: "GPT-4.1"),
                .init(id: "gpt-4.1-mini", label: "GPT-4.1 mini"),
                .init(id: "gpt-4.1-nano", label: "GPT-4.1 nano"),
                .init(id: "gpt-4o", label: "GPT-4o"),
                .init(id: "gpt-4o-mini", label: "GPT-4o mini"),
                .init(id: "gpt-4.5-preview", label: "GPT-4.5 Preview"),
                .init(id: "gpt-4-turbo", label: "GPT-4 Turbo"),
                .init(id: "gpt-4-turbo-preview", label: "GPT-4 Turbo Preview"),
                .init(id: "gpt-4", label: "GPT-4"),
                .init(id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo"),
                .init(id: "o3-pro", label: "o3-pro"),
                .init(id: "o3", label: "o3"),
                .init(id: "o4-mini", label: "o4-mini"),
                .init(id: "o3-mini", label: "o3-mini"),
                .init(id: "o1-pro", label: "o1-pro"),
                .init(id: "o1", label: "o1"),
                .init(id: "o1-mini", label: "o1-mini"),
                .init(id: "o1-preview", label: "o1 preview"),
                .init(id: "gpt-4o-search-preview", label: "GPT-4o Search Preview"),
                .init(id: "gpt-4o-mini-search-preview", label: "GPT-4o mini Search Preview"),
                .init(id: "gpt-5.3-codex", label: "GPT-5.3-Codex"),
                .init(id: "gpt-5.2-codex", label: "GPT-5.2-Codex"),
                .init(id: "gpt-5.1-codex", label: "GPT-5.1 Codex"),
                .init(id: "gpt-5.1-codex-max", label: "GPT-5.1-Codex-Max"),
                .init(id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex mini"),
                .init(id: "gpt-5-codex", label: "GPT-5-Codex"),
                .init(id: "codex-mini-latest", label: "codex-mini-latest"),
                .init(id: "o3-deep-research", label: "o3-deep-research"),
                .init(id: "o4-mini-deep-research", label: "o4-mini-deep-research"),
                .init(id: "gpt-oss-120b", label: "gpt-oss-120b"),
                .init(id: "gpt-oss-20b", label: "gpt-oss-20b")
            ]
        ),
        AgentAIProviderOption(
            id: "gemini",
            label: "Gemini",
            defaultModel: "gemini-3.5-flash",
            models: [
                .init(id: "gemini-3.5-flash", label: "Gemini 3.5 Flash"),
                .init(id: "gemini-3-flash", label: "Gemini 3 Flash"),
                .init(id: "gemini-3.1-pro", label: "Gemini 3.1 Pro"),
                .init(id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite"),
                .init(id: "gemini-2.5-flash", label: "Gemini 2.5 Flash"),
                .init(id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite"),
                .init(id: "gemini-2.5-pro", label: "Gemini 2.5 Pro")
            ]
        ),
        AgentAIProviderOption(
            id: "claude",
            label: "Claude",
            defaultModel: "claude-haiku-4-5",
            models: [
                .init(id: "claude-haiku-4-5", label: "Claude Haiku 4.5"),
                .init(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6"),
                .init(id: "claude-opus-4-8", label: "Claude Opus 4.8"),
                .init(id: "claude-fable-5", label: "Claude Fable 5")
            ]
        ),
        AgentAIProviderOption(
            id: "deepseek",
            label: "DeepSeek",
            defaultModel: "deepseek-v4-flash",
            models: [
                .init(id: "deepseek-v4-flash", label: "DeepSeek V4 Flash"),
                .init(id: "deepseek-v4-pro", label: "DeepSeek V4 Pro"),
                .init(id: "deepseek-chat", label: "deepseek-chat"),
                .init(id: "deepseek-reasoner", label: "deepseek-reasoner")
            ]
        )
    ]

    static func knownProvider(_ value: String?) -> String {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return providers.contains(where: { $0.id == normalized }) ? normalized : "openai"
    }

    static func option(for provider: String?) -> AgentAIProviderOption {
        let id = knownProvider(provider)
        return providers.first(where: { $0.id == id }) ?? providers[0]
    }

    static func defaultModel(provider: String?) -> String {
        option(for: provider).defaultModel
    }

    static func knownModel(provider: String?, _ value: String?) -> String {
        let option = option(for: provider)
        let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return option.models.contains(where: { $0.id == raw }) ? raw : option.defaultModel
    }

    static func modelLabel(provider: String?, model: String?) -> String {
        let option = option(for: provider)
        let id = knownModel(provider: option.id, model)
        return option.models.first(where: { $0.id == id })?.label ?? id
    }
}
