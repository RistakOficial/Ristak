import Foundation

/// Estados del agente conversacional por contacto
/// (`/api/conversational-agent/states/:contactId`, doc 05 §6).
/// Requiere feature `conversational_ai` + módulo `ai_agent`: si el usuario no
/// tiene acceso, la app no debe mostrar los controles (los GET fallan con 403
/// silencioso vía hook global del APIClient).
struct AgentStateService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// `GET /states/:contactId` — estado primario (opcional `agentId`).
    func fetchPrimaryState(contactId: String, agentId: String? = nil) async throws -> ConversationAgentState? {
        try await client.get(
            "/conversational-agent/states/\(contactId)",
            query: ["agentId": agentId]
        )
    }

    /// `GET /states/:contactId?includeAll=1` — todos los agentes del contacto.
    func fetchAllStates(contactId: String) async throws -> [ConversationAgentState] {
        try await client.get(
            "/conversational-agent/states/\(contactId)",
            query: ["includeAll": "1"]
        )
    }

    /// `POST /states/:contactId` — `pause`/`resume`/`take_over`/`skip`/
    /// `activate`/`clear_signal`. En multi-agente, la confirmación
    /// "pausar y enviar" debe iterar TODOS los estados activos (un POST por
    /// `agentId`, gap doc 05 §10.11).
    @discardableResult
    func updateState(
        contactId: String,
        action: ConversationAgentAction,
        agentId: String? = nil,
        pausedUntilAt: String? = nil
    ) async throws -> ConversationAgentState {
        try await client.post(
            "/conversational-agent/states/\(contactId)",
            body: ConversationAgentStateUpdateBody(
                action: action,
                agentId: agentId,
                pausedUntilAt: pausedUntilAt
            )
        )
    }
}

/// Body de `POST /states/:contactId`.
struct ConversationAgentStateUpdateBody: Encodable, Sendable {
    var action: ConversationAgentAction
    var agentId: String?
    var pausedUntilAt: String?
}
