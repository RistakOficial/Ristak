import SwiftUI

/// Estilos compartidos para el estado del agente conversacional por conversación
/// (`ConversationAgentState.status` / `.signal`). Un solo lugar para que el
/// controlador del hilo, el Hub y la Info del contacto muestren lo mismo.
enum AgentStatusStyle {
    /// Etiqueta corta para pastillas: "Activo" / "Pausado" / …
    static func label(_ status: String) -> String {
        switch status.lowercased() {
        case "active": return "Activo"
        case "paused": return "Pausado"
        case "human": return "En humano"
        case "skipped": return "Omitido"
        case "completed": return "Completado"
        case "discarded": return "Descartado"
        default: return status.isEmpty ? "—" : status.capitalized
        }
    }

    /// Color semántico del estado (tokens Ristak, nunca hex).
    static func color(_ status: String) -> Color {
        switch status.lowercased() {
        case "active": return RistakTheme.pos
        case "paused": return RistakTheme.warn
        case "human": return RistakTheme.info
        case "skipped", "discarded": return RistakTheme.neg
        default: return RistakTheme.textDim
        }
    }

    /// Ícono SF Symbol del estado.
    static func icon(_ status: String) -> String {
        switch status.lowercased() {
        case "active": return "sparkles"
        case "paused": return "pause.circle.fill"
        case "human": return "person.fill"
        case "skipped": return "nosign"
        case "completed": return "checkmark.seal.fill"
        case "discarded": return "trash"
        default: return "sparkles"
        }
    }

    /// Copy larga para el encabezado del sheet de controles (paridad /movil
    /// `agentStatusLabels`).
    static func chatLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "active": return "El agente atiende este chat."
        case "paused": return "Agente pausado por 24 hrs en este chat."
        case "human": return "Conversación tomada por un humano."
        case "skipped": return "Agente omitido en este chat."
        case "completed": return "El agente ya cumplió el objetivo aquí."
        case "discarded": return "Conversación descartada por el agente."
        default: return "El agente atiende este chat."
        }
    }

    /// Metadatos de la señal de cierre (banner de "objetivo cumplido").
    /// `nil` para señales que no se muestran (p. ej. `discarded`).
    static func signalMeta(_ signal: String) -> (icon: String, title: String)? {
        switch signal.lowercased() {
        case "ready_for_human": return ("checkmark.seal.fill", "Objetivo concretado")
        case "ready_to_schedule": return ("calendar", "Listo para agendar")
        case "ready_to_buy": return ("creditcard.fill", "Listo para cobrar")
        case "appointment_booked": return ("calendar.badge.checkmark", "Cita agendada")
        case "purchase_completed": return ("dollarsign.circle.fill", "Pago completado")
        default: return nil
        }
    }
}
