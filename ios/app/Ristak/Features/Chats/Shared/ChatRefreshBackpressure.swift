import Foundation

/// Backpressure compartido por inbox e hilo para nudges de SSE/push/poll.
///
/// Una ráfaga admite como máximo el GET primario y UN follow-up inmediato. Si
/// llega actividad mientras el follow-up ya está en vuelo, no se pierde: el gate
/// entra en cooldown y el ViewModel agenda un único trailing refresh. Cualquier
/// cantidad de nudges durante ese cooldown queda cubierta por la misma tarea.
/// Así conservamos eventual consistency sin revivir un `while` de GETs infinitos.
struct ChatRefreshBurstGate: Equatable {
    enum Phase: Equatable {
        case idle
        case primary
        case followUp
        case cooldown
    }

    /// Medio segundo agrupa push + SSE del mismo mensaje sin volver perceptible
    /// la reconciliación al usuario.
    static let trailingCooldownNanoseconds: UInt64 = 500_000_000

    private(set) var phase: Phase = .idle
    private(set) var hasPendingFollowUp = false
    private(set) var needsTrailingRefresh = false

    var isInFlight: Bool {
        phase == .primary || phase == .followUp
    }

    var isCoolingDown: Bool { phase == .cooldown }

    mutating func beginOrQueue() -> Bool {
        switch phase {
        case .idle:
            phase = .primary
            hasPendingFollowUp = false
            needsTrailingRefresh = false
            return true
        case .primary:
            hasPendingFollowUp = true
            return false
        case .followUp:
            needsTrailingRefresh = true
            return false
        case .cooldown:
            // Ya existe exactamente una tarea trailing que cubrirá este nudge.
            return false
        }
    }

    mutating func consumeFollowUp() -> Bool {
        guard phase == .primary, hasPendingFollowUp else { return false }
        hasPendingFollowUp = false
        phase = .followUp
        return true
    }

    /// Cierra la parte inmediata de la ráfaga. `true` significa que llegó un
    /// nudge durante el follow-up y el caller debe agendar UN trailing refresh.
    @discardableResult
    mutating func finishBurst() -> Bool {
        guard isInFlight else { return false }
        let shouldScheduleTrailing = needsTrailingRefresh
        phase = shouldScheduleTrailing ? .cooldown : .idle
        hasPendingFollowUp = false
        needsTrailingRefresh = false
        return shouldScheduleTrailing
    }

    /// La única tarea de cooldown adquiere el siguiente GET. Nudges recibidos
    /// mientras dormía ya están plegados en esta lectura.
    mutating func beginTrailingRefresh() -> Bool {
        guard phase == .cooldown else { return false }
        phase = .primary
        hasPendingFollowUp = false
        needsTrailingRefresh = false
        return true
    }

    /// Cancela únicamente un trailing pendiente. Nunca libera un request que ya
    /// está en vuelo, evitando abrir una segunda carga concurrente al pausar.
    mutating func cancelCooldown() {
        guard phase == .cooldown else { return }
        phase = .idle
        hasPendingFollowUp = false
        needsTrailingRefresh = false
    }

    /// Reset terminal (logout/teardown cuando el owner ya canceló sus tareas).
    mutating func reset() {
        phase = .idle
        hasPendingFollowUp = false
        needsTrailingRefresh = false
    }
}
