import Foundation

// MARK: - Agente conversacional: config global + definiciones (doc 05 §6)
//
// El agente conversacional (auto-respuesta por contacto) es un sistema DISTINTO
// del "Asistente Personal AI" (`AIAgentService`, /api/ai-agent). Aquí modelamos
// la CONFIG GLOBAL (`ConversationalAgentConfig`) y las DEFINICIONES de agente
// (`ConversationalAgentDef`) que el Hub del chat enciende/pausa/edita. El estado
// POR CONVERSACIÓN (`ConversationAgentState`) y sus acciones viven en
// `Core/Models/MessageSendModels.swift` + `AgentStateService`.
//
// Decode tolerante (flexible*): el backend camelCasea a mano (mapConfigRow /
// mapAgentRow) y puede omitir claves; solo decodificamos el subconjunto que la
// app usa e ignoramos el resto (goalWorkflow/filters/delay/delivery/followUp se
// preservan server-side porque el PUT es parcial y nunca los enviamos).

// MARK: Códigos de error del backend (para create/update)

enum ConversationalAgentErrorCode {
    static let entryConflict = "CONVERSATIONAL_AGENT_ENTRY_CONFLICT"
    static let limitReached = "CONVERSATIONAL_AGENT_LIMIT_REACHED"
    static let businessPromptNotReady = "CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY"
}

// MARK: Estado del "prompt del negocio" (bloquea encender/crear si no está listo)

struct ConversationalBusinessPromptStatus: Decodable, Sendable, Equatable {
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

// MARK: Config global — GET/POST /conversational-agent/config

struct ConversationalAgentConfig: Decodable, Sendable, Equatable {
    /// Interruptor maestro del agente conversacional.
    let enabled: Bool
    let objective: String
    let customObjective: String
    let successAction: String
    let persuasionLevel: String
    let languageLevel: String
    let allowEmojis: Bool
    let updatedAt: String?
    let businessPromptStatus: ConversationalBusinessPromptStatus?

    enum CodingKeys: String, CodingKey {
        case enabled, objective, customObjective, successAction
        case persuasionLevel, languageLevel, allowEmojis, updatedAt
        case businessPromptStatus
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.flexibleBool(forKey: .enabled) ?? false
        objective = c.flexibleString(forKey: .objective) ?? ""
        customObjective = c.flexibleString(forKey: .customObjective) ?? ""
        successAction = c.flexibleString(forKey: .successAction) ?? ""
        persuasionLevel = c.flexibleString(forKey: .persuasionLevel) ?? "high"
        languageLevel = c.flexibleString(forKey: .languageLevel) ?? "intermediate"
        allowEmojis = c.flexibleBool(forKey: .allowEmojis) ?? false
        updatedAt = c.flexibleString(forKey: .updatedAt)
        businessPromptStatus = try? c.decodeIfPresent(ConversationalBusinessPromptStatus.self, forKey: .businessPromptStatus)
    }

    /// ¿Se puede encender el agente? Requiere el prompt del negocio listo
    /// (si el backend no lo manda, asumimos listo y dejamos que 409 corrija).
    var canEnable: Bool { businessPromptStatus?.ready ?? true }
}

/// Body parcial de POST /conversational-agent/config (el Hub solo manda `enabled`).
/// Los opcionales nil se omiten en el JSON (encode sintetizado usa encodeIfPresent).
struct ConversationalAgentConfigInput: Encodable, Sendable {
    var enabled: Bool?
    var objective: String?
    var customObjective: String?
    var successAction: String?
    var persuasionLevel: String?
    var languageLevel: String?
    var allowEmojis: Bool?
}

// MARK: Definición de agente — GET /agents, PUT /agents/:id

struct ConversationalAgentDef: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let name: String
    let enabled: Bool
    let aiProvider: String
    let model: String
    let identityMode: String
    let identityCustomName: String
    let identityUserName: String
    let position: Int
    let objective: String
    let customObjective: String
    let successAction: String
    let requiredData: String
    let handoffRules: String
    let extraInstructions: String
    let allowEmojis: Bool
    let hideAttendedNotifications: Bool
    let persuasionLevel: String
    let languageLevel: String
    let contactScope: String
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, enabled, aiProvider, model
        case identityMode, identityCustomName, identityUserName, position
        case objective, customObjective, successAction
        case requiredData, handoffRules, extraInstructions
        case allowEmojis, hideAttendedNotifications
        case persuasionLevel, languageLevel, contactScope, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.flexibleString(forKey: .id) ?? ""
        name = c.flexibleString(forKey: .name) ?? ""
        enabled = c.flexibleBool(forKey: .enabled) ?? false
        aiProvider = c.flexibleString(forKey: .aiProvider) ?? "openai"
        model = c.flexibleString(forKey: .model) ?? ""
        identityMode = c.flexibleString(forKey: .identityMode) ?? "business"
        identityCustomName = c.flexibleString(forKey: .identityCustomName) ?? ""
        identityUserName = c.flexibleString(forKey: .identityUserName) ?? ""
        position = c.flexibleInt(forKey: .position) ?? 0
        objective = c.flexibleString(forKey: .objective) ?? ""
        customObjective = c.flexibleString(forKey: .customObjective) ?? ""
        successAction = c.flexibleString(forKey: .successAction) ?? ""
        requiredData = c.flexibleString(forKey: .requiredData) ?? ""
        handoffRules = c.flexibleString(forKey: .handoffRules) ?? ""
        extraInstructions = c.flexibleString(forKey: .extraInstructions) ?? ""
        allowEmojis = c.flexibleBool(forKey: .allowEmojis) ?? false
        hideAttendedNotifications = c.flexibleBool(forKey: .hideAttendedNotifications) ?? false
        persuasionLevel = c.flexibleString(forKey: .persuasionLevel) ?? "high"
        languageLevel = c.flexibleString(forKey: .languageLevel) ?? "intermediate"
        contactScope = c.flexibleString(forKey: .contactScope) ?? "all"
        updatedAt = c.flexibleString(forKey: .updatedAt)
    }

    /// Nombre visible con fallback.
    var displayName: String { name.isEmpty ? "Agente" : name }
}

/// Body parcial de PUT /agents/:id. Solo los campos editados; los nil se omiten
/// (el backend hace merge y preserva goalWorkflow/filters no enviados).
struct ConversationalAgentDefInput: Encodable, Sendable {
    var name: String?
    var enabled: Bool?
    var objective: String?
    var customObjective: String?
    var identityMode: String?
    var identityCustomName: String?
    var persuasionLevel: String?
    var languageLevel: String?
    var contactScope: String?
    var allowEmojis: Bool?
    var requiredData: String?
    var handoffRules: String?
    var extraInstructions: String?
}

// MARK: - Catálogos de opciones (para los selectores del editor)

enum AgentObjectiveOption: String, CaseIterable, Sendable {
    case citas, ventas, datos, filtrar, custom
    var label: String {
        switch self {
        case .citas: return "Agendar citas"
        case .ventas: return "Vender"
        case .datos: return "Recopilar datos"
        case .filtrar: return "Filtrar / Calificar"
        case .custom: return "Personalizado"
        }
    }
}

enum AgentIdentityOption: String, CaseIterable, Sendable {
    case business, custom, agent
    var label: String {
        switch self {
        case .business: return "Del negocio"
        case .custom: return "Nombre propio"
        case .agent: return "Se presenta como agente"
        }
    }
}

enum AgentPersuasionOption: String, CaseIterable, Sendable {
    case low, medium, high
    var label: String {
        switch self {
        case .low: return "Suave"
        case .medium: return "Media"
        case .high: return "Alta"
        }
    }
}

enum AgentLanguageOption: String, CaseIterable, Sendable {
    case professional, intermediate, colloquial
    var label: String {
        switch self {
        case .professional: return "Formal"
        case .intermediate: return "Intermedio"
        case .colloquial: return "Coloquial"
        }
    }
}

enum AgentContactScopeOption: String, CaseIterable, Sendable {
    case all, new_only
    var label: String {
        switch self {
        case .all: return "Todos"
        case .new_only: return "Solo nuevos"
        }
    }
}
