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

// MARK: - Glifo de bot

/// Glifo de "bot" del agente conversacional dibujado con formas — no existe un SF
/// Symbol de robot. Cabeza redondeada con antena y dos ojos, en un SOLO color
/// (se tiñe con `color`) y escalable. Se usa en el header del hilo y en el banner
/// del composer para que el agente se lea como un botcito y no como "sparkles".
struct AgentBotGlyph: View {
    var color: Color = RistakTheme.accent
    var size: CGFloat = 20
    var paused = false

    var body: some View {
        let headW = size * 0.9
        let headH = size * 0.72
        let stroke = max(1.5, size * 0.1)
        let eye = size * 0.14
        ZStack {
            // Antena (puntito + tallo) saliendo por arriba de la cabeza.
            VStack(spacing: size * 0.02) {
                Circle()
                    .fill(color)
                    .frame(width: size * 0.16, height: size * 0.16)
                Capsule()
                    .fill(color)
                    .frame(width: stroke * 0.9, height: size * 0.12)
            }
            .offset(y: -headH / 2 - size * 0.05)

            // Cabeza en contorno (estilo SF Symbol outline).
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .strokeBorder(color, lineWidth: stroke)
                .frame(width: headW, height: headH)

            // Ojos.
            HStack(spacing: size * 0.2) {
                Circle().fill(color).frame(width: eye, height: eye)
                Circle().fill(color).frame(width: eye, height: eye)
            }
            .offset(y: -size * 0.02)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if paused {
                ZStack {
                    Circle()
                        .fill(RistakTheme.warn)
                    Image(systemName: "pause.fill")
                        .font(.system(size: max(5, size * 0.24), weight: .bold))
                        .foregroundStyle(RistakTheme.onAccent)
                }
                .frame(width: max(10, size * 0.48), height: max(10, size * 0.48))
                .overlay {
                    Circle().stroke(RistakTheme.bg, lineWidth: 1.5)
                }
                .offset(x: size * 0.2, y: size * 0.2)
            }
        }
        .accessibilityHidden(true)
    }
}
