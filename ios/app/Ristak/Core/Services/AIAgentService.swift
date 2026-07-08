import Foundation

/// Endpoints del Asistente Personal AI (doc research/10 §2.5). Módulo
/// `ai_agent`; `business-context-answer`/`transcribe`/`chat` exigen además
/// OpenAI conectado — 409 con `needsOpenAIConfig`/`needsReconnect` (detectar
/// con `error.isOpenAIConfigurationIssue` / `error.needsOpenAIReconnect`).
enum AIAgentService {
    /// `GET /api/ai-agent/config` → estado/config del agente.
    static func config() async throws -> AIAgentConfigStatus {
        try await APIClient.shared.get("/api/ai-agent/config")
    }

    /// `POST /api/ai-agent/config` — el móvil suele mandar solo `{ apiKey }`
    /// para conectar OpenAI. Errores 400: «El API Token de OpenAI no tiene un
    /// formato válido», «API Token de OpenAI inválido».
    static func updateConfig(_ update: AIAgentConfigUpdate) async throws -> AIAgentConfigStatus {
        try await APIClient.shared.post(
            "/api/ai-agent/config",
            body: update,
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `DELETE /api/ai-agent/config/token` — borra solo el token OpenAI.
    static func deleteToken() async throws -> AIAgentConfigStatus {
        try await APIClient.shared.delete("/api/ai-agent/config/token")
    }

    /// `DELETE /api/ai-agent/config` — desconecta el agente por completo.
    static func deleteConfig() async throws -> APIAcknowledgment {
        try await APIClient.shared.delete("/api/ai-agent/config")
    }

    /// `POST /api/ai-agent/business-context-answer` — pule con OpenAI y guarda
    /// el contexto del negocio. El texto devuelto reemplaza el draft.
    static func saveBusinessContext(answer: String, field: String = "businessContext") async throws -> AIAgentContextAnswerResult {
        try await APIClient.shared.post(
            "/api/ai-agent/business-context-answer",
            body: AIAgentContextAnswerRequest(field: field, answer: answer),
            timeout: APIClient.mediaTimeout
        )
    }

    /// `POST /api/ai-agent/transcribe` — upload BINARIO crudo (NO multipart):
    /// el m4a va como body con `Content-Type: audio/m4a` (forma recomendada
    /// para nativo, doc 10 §2.5). Límite 25 MB → 413 «El audio es demasiado
    /// pesado.».
    static func transcribe(audioData: Data, contentType: String = "audio/m4a") async throws -> AIAgentTranscriptionResult {
        try await APIClient.shared.upload(
            "/api/ai-agent/transcribe",
            rawBody: audioData,
            contentType: contentType
        )
    }

    /// `POST /api/ai-agent/chat` `{ messages, viewContext, category }` — chat
    /// del asistente personal (RN `sendAIAgentMessage`).
    static func chat(_ request: AIAgentChatRequest) async throws -> AIAgentChatResult {
        try await APIClient.shared.post(
            "/api/ai-agent/chat",
            body: request,
            timeout: APIClient.mediaTimeout
        )
    }
}
