import SwiftUI

// Cascada de notas de voz (autoplay encadenado): cuando se apilan audios
// consecutivos (uno tras otro SIN un mensaje que no sea audio en medio), al
// terminar uno arranca automáticamente el SIGUIENTE. Si el siguiente mensaje no
// es audio (texto, media, etc.), se detiene: nunca cruza un límite no-audio.

/// Coordinador de reproducción de audios del hilo. Conoce el ORDEN de los
/// mensajes (derivado del timeline combinado) y, al terminar un audio, decide si
/// encadenar con el siguiente audio contiguo o parar.
///
/// Además garantiza que solo suene UN audio a la vez (al iniciar uno, detiene el
/// que estuviera activo), como en WhatsApp.
@MainActor
@Observable
final class AudioCascadeCoordinator {
    /// Descriptor mínimo de un mensaje del timeline para calcular contigüidad.
    struct Entry: Equatable, Sendable {
        let id: String
        let isAudio: Bool
    }

    /// Handlers de reproducción por id de mensaje (registrados por cada
    /// `AudioMessageView` visible).
    private struct Handlers {
        let play: () -> Void
        let stop: () -> Void
    }

    /// Orden de SOLO mensajes (sin separadores de día ni markers de actividad),
    /// ascendente. Un audio encadena con el siguiente si este también es audio.
    private var order: [Entry] = []
    private var handlers: [String: Handlers] = [:]

    /// Id del audio que está sonando ahora mismo (nil si ninguno).
    private(set) var activeMessageID: String?

    /// Actualiza el orden de mensajes visible (llamado cuando cambia el timeline).
    func updateOrder(_ entries: [Entry]) {
        order = entries
    }

    /// Registra los handlers de un audio (en `onAppear` de su vista).
    func register(id: String, play: @escaping () -> Void, stop: @escaping () -> Void) {
        handlers[id] = Handlers(play: play, stop: stop)
    }

    /// Da de baja un audio (en `onDisappear`). Si era el activo, lo olvida.
    func unregister(id: String) {
        handlers.removeValue(forKey: id)
        if activeMessageID == id {
            activeMessageID = nil
        }
    }

    /// El audio `id` empezó a sonar: detiene el que estuviera activo (uno a la vez).
    func didStartPlaying(id: String) {
        if let current = activeMessageID, current != id {
            handlers[current]?.stop()
        }
        activeMessageID = id
    }

    /// El audio `id` se pausó manualmente: si era el activo, deja de serlo (para
    /// no encadenar al reanudar ni al terminar tras una pausa involuntaria).
    func didPause(id: String) {
        if activeMessageID == id {
            activeMessageID = nil
        }
    }

    /// El audio `id` llegó al final: encadena con el SIGUIENTE mensaje solo si es
    /// audio (run contiguo); en cualquier otro caso se detiene la cascada.
    func didFinishPlaying(id: String) {
        // Solo encadena desde el audio que estaba activo (no desde uno pausado).
        guard activeMessageID == id else { return }
        activeMessageID = nil

        guard let index = order.firstIndex(where: { $0.id == id }) else { return }
        let nextIndex = index + 1
        guard nextIndex < order.count else { return }

        let next = order[nextIndex]
        // Límite no-audio → parar (no cruzar hacia texto/media/etc.).
        guard next.isAudio, let handler = handlers[next.id] else { return }

        activeMessageID = next.id
        handler.play()
    }
}
