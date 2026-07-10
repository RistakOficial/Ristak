import Foundation
import SwiftUI

/// ViewModel del Hub del agente conversacional (activar/pausar cada agente,
/// reiniciar omisiones, entrar a editar). Gatea por
/// disponibilidad de OpenAI igual que el web (`useAIAgentAvailability`).
@MainActor
@Observable
final class AgentHubViewModel {
    enum Phase: Equatable {
        case loading
        /// OpenAI no conectado / requiere reconexión → dirige a Ajustes.
        case needsOpenAI(reconnect: Bool)
        case accessDenied
        case failed(String)
        case ready
    }

    struct HubAlert: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    private(set) var phase: Phase = .loading
    private(set) var config: ConversationalAgentConfig?
    private(set) var agents: [ConversationalAgentDef] = []

    private(set) var savingAgentIDs: Set<String> = []
    private(set) var resettingAgentIDs: Set<String> = []

    private var agentEnabledOverrides: [String: Bool] = [:]

    var alert: HubAlert?

    var businessPromptReady: Bool { config?.canEnable ?? true }

    func isAgentEnabled(_ agent: ConversationalAgentDef) -> Bool {
        agentEnabledOverrides[agent.id] ?? agent.enabled
    }

    // MARK: - Carga

    func load() async {
        phase = .loading
        // Gate OpenAI (misma conexión que el Asistente Personal).
        do {
            let ai = try await AIAgentService.config()
            guard ai.isReady else {
                phase = .needsOpenAI(reconnect: ai.needsReconnect)
                return
            }
        } catch let error as RistakAPIError where error.isAccessDenied {
            phase = .accessDenied
            return
        } catch {
            // Falla de red en el gate: seguimos e intentamos /config, que
            // devolverá el error real (o 409 needsOpenAIConfig).
        }

        do {
            async let cfg = ConversationalAgentService.config()
            async let list = ConversationalAgentService.agents()
            let (loadedConfig, loadedAgents) = try await (cfg, list)
            config = loadedConfig
            agents = loadedAgents.sorted { $0.position < $1.position }
            agentEnabledOverrides.removeAll()
            phase = .ready
        } catch let error as RistakAPIError {
            switch error.kind {
            case .accessDenied, .featureUnavailable, .adminRequired:
                phase = .accessDenied
            default:
                if error.status == 409 {
                    phase = .needsOpenAI(reconnect: false)
                } else {
                    phase = .failed(error.message)
                }
            }
        } catch {
            phase = .failed("No se pudo cargar el agente conversacional.")
        }
    }

    func retry() {
        Task { await load() }
    }

    // MARK: - Por agente

    func setAgentEnabled(_ agent: ConversationalAgentDef, enabled: Bool) {
        guard !savingAgentIDs.contains(agent.id) else { return }
        savingAgentIDs.insert(agent.id)
        agentEnabledOverrides[agent.id] = enabled
        // Encender un agente con el runtime apagado por legado lo repara como
        // detalle interno; la UI solo controla este agente.
        let shouldEnableRuntime = enabled && !(config?.enabled ?? false)
        Task {
            defer { savingAgentIDs.remove(agent.id) }
            do {
                let updated = try await ConversationalAgentService.updateAgent(id: agent.id, .init(enabled: enabled))
                replaceAgent(updated)
                agentEnabledOverrides[agent.id] = nil
                if shouldEnableRuntime {
                    config = try await ConversationalAgentService.saveConfig(.init(enabled: true))
                }
            } catch {
                agentEnabledOverrides[agent.id] = nil
                present(error, whenEnabling: enabled)
            }
        }
    }

    func resetSkipped(_ agent: ConversationalAgentDef) {
        guard !resettingAgentIDs.contains(agent.id) else { return }
        resettingAgentIDs.insert(agent.id)
        Task {
            defer { resettingAgentIDs.remove(agent.id) }
            do {
                try await ConversationalAgentService.resetSkipped(agentId: agent.id)
                alert = HubAlert(
                    title: "Omisiones reiniciadas",
                    message: "\(agent.displayName) puede volver a tomar los chats que había omitido."
                )
            } catch {
                present(error, whenEnabling: nil)
            }
        }
    }

    /// El editor devuelve el agente actualizado: lo reflejamos sin recargar.
    func applyUpdatedAgent(_ def: ConversationalAgentDef) {
        replaceAgent(def)
    }

    // MARK: - Helpers

    private func replaceAgent(_ def: ConversationalAgentDef) {
        if let index = agents.firstIndex(where: { $0.id == def.id }) {
            agents[index] = def
        } else {
            agents.append(def)
        }
        agents.sort { $0.position < $1.position }
    }

    private func present(_ error: Error, whenEnabling enabling: Bool?) {
        let apiError = error as? RistakAPIError
        if apiError?.code == ConversationalAgentErrorCode.businessPromptNotReady {
            alert = HubAlert(
                title: "Falta el contexto del negocio",
                message: "Completa la descripción de tu negocio en Ajustes → Asistente Personal AI antes de encender el agente."
            )
            return
        }
        let fallback = (enabling ?? false) ? "No se pudo encender el agente." : "No se pudo actualizar el agente."
        alert = HubAlert(
            title: "Agente conversacional",
            message: apiError?.message ?? fallback
        )
    }
}
