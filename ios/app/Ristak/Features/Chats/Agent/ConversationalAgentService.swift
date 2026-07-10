import Foundation

/// Endpoints de gestión del agente conversacional (runtime interno + definiciones).
/// Complementa `AgentStateService` (estado por conversación). Todo el router
/// `/api/conversational-agent` exige feature `conversational_ai` + módulo
/// `ai_agent` + OpenAI conectado (409 `needsOpenAIConfig` si falta) — por eso el
/// Hub verifica primero la disponibilidad de OpenAI vía `AIAgentService.config()`.
enum ConversationalAgentService {
    private static let base = "/conversational-agent"

    /// `GET /config` → runtime interno + estado del prompt del negocio.
    static func config() async throws -> ConversationalAgentConfig {
        try await APIClient.shared.get("\(base)/config")
    }

    /// `POST /config` — guarda config parcial (el Hub manda solo `{ enabled }`).
    /// Encender con el prompt del negocio no listo → 409 `CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY`.
    @discardableResult
    static func saveConfig(_ input: ConversationalAgentConfigInput) async throws -> ConversationalAgentConfig {
        try await APIClient.shared.post("\(base)/config", body: input, timeout: APIClient.dashboardTimeout)
    }

    /// `GET /agents` → todas las definiciones de agente.
    static func agents() async throws -> [ConversationalAgentDef] {
        try await APIClient.shared.get("\(base)/agents")
    }

    /// `GET /filter-options` → opciones auxiliares para reglas de entrada/salida
    /// (anuncios, teléfonos del negocio y campos personalizados).
    static func filterOptions() async throws -> AgentFilterOptions {
        try await APIClient.shared.get("\(base)/filter-options")
    }

    /// `PUT /agents/:id` — actualiza un agente (body parcial). Puede 409 con
    /// `CONVERSATIONAL_AGENT_ENTRY_CONFLICT` / `CONVERSATIONAL_AGENT_LIMIT_REACHED`
    /// / `CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY`.
    @discardableResult
    static func updateAgent(id: String, _ input: ConversationalAgentDefInput) async throws -> ConversationalAgentDef {
        try await APIClient.shared.put("\(base)/agents/\(id)", body: input, timeout: APIClient.dashboardTimeout)
    }

    /// `POST /agents/:id/reset-skipped` — reactiva los contactos omitidos por ese agente.
    static func resetSkipped(agentId: String) async throws {
        try await APIClient.shared.post("\(base)/agents/\(agentId)/reset-skipped")
    }
}
