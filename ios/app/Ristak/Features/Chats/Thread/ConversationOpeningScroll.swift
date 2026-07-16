import Foundation

/// Máquina de estado pura para la primera posición del hilo.
///
/// SwiftUI puede materializar el centinela superior antes de aplicar el
/// `defaultScrollAnchor`. Si ese centinela pagina en ese instante, el prepend
/// instala un anchor histórico y la conversación termina abierta arriba. Esta
/// máquina mantiene cerrada la paginación hasta que el fondo quedó realmente
/// establecido (o hasta que el usuario decide desplazarse por sí mismo).
struct ConversationOpeningScrollState: Equatable {
    private var generation: UInt64 = 0
    private var activeAnchorGeneration: UInt64?
    private var isTrackingOpeningLayout = true
    private var hasEstablishedBottom = false

    /// Devuelve una generación nueva mientras la apertura siga bajo control
    /// automático. No se limita al último id: la vista llama esto también al
    /// cambiar el timeline completo o la altura materializada del contenido.
    mutating func contentDidChange(hasContent: Bool) -> UInt64? {
        guard hasContent, isTrackingOpeningLayout else { return nil }
        generation &+= 1
        activeAnchorGeneration = generation
        return generation
    }

    func shouldContinueAnchoring(generation expected: UInt64) -> Bool {
        isTrackingOpeningLayout && activeAnchorGeneration == expected
    }

    mutating func didEstablishBottom(generation expected: UInt64) {
        guard shouldContinueAnchoring(generation: expected) else { return }
        activeAnchorGeneration = nil
        hasEstablishedBottom = true
    }

    /// Cierra el periodo automático únicamente después de que la carga primaria
    /// terminó y el layout permaneció quieto durante toda la reafirmación. Una
    /// revisión anterior no puede cerrar una generación más nueva.
    mutating func didFinishOpeningTracking(generation expected: UInt64) {
        guard isTrackingOpeningLayout,
              generation == expected,
              activeAnchorGeneration == nil else { return }
        isTrackingOpeningLayout = false
    }

    /// Un arrastre vertical explícito manda sobre cualquier reposicionamiento
    /// automático pendiente.
    mutating func userDidBeginScrolling() {
        generation &+= 1
        activeAnchorGeneration = nil
        isTrackingOpeningLayout = false
        hasEstablishedBottom = true
    }

    var canLoadOlderMessages: Bool { hasEstablishedBottom }
    var isAnchoring: Bool { activeAnchorGeneration != nil }
    var tracksOpeningLayout: Bool { isTrackingOpeningLayout }
}

/// Decide cómo tratar un `200 []` durante la primera apertura. La bandeja puede
/// saber que sí existe historial mientras la proyección de conversación todavía
/// está alcanzando el mensaje recién recibido. En ese caso vaciar un snapshot
/// bueno produce exactamente el síntoma de “salgo y vuelvo a entrar y aparece”.
enum ConversationInitialEmptyResponsePolicy {
    static func expectsMessages(
        existingMessageCount: Int,
        seedMessageCount: Int,
        seedHasLastMessageDate: Bool
    ) -> Bool {
        existingMessageCount > 0 || seedMessageCount > 0 || seedHasLastMessageDate
    }

    static func shouldRetry(
        freshMessageCount: Int,
        existingMessageCount: Int,
        seedMessageCount: Int,
        seedHasLastMessageDate: Bool
    ) -> Bool {
        freshMessageCount == 0 && expectsMessages(
            existingMessageCount: existingMessageCount,
            seedMessageCount: seedMessageCount,
            seedHasLastMessageDate: seedHasLastMessageDate
        )
    }

    static func shouldPreserveExisting(
        freshMessageCount: Int,
        existingMessageCount: Int
    ) -> Bool {
        freshMessageCount == 0 && existingMessageCount > 0
    }

    /// Dos respuestas vacías siguen siendo contradictorias cuando no existe un
    /// snapshot local que mostrar, pero la fila de inbox afirma que hay historial.
    /// Eso es un estado recuperable de sincronización, no una conversación vacía.
    static func shouldFailAsTemporarilyUnavailable(
        finalFreshMessageCount: Int,
        existingMessageCount: Int,
        seedMessageCount: Int,
        seedHasLastMessageDate: Bool
    ) -> Bool {
        finalFreshMessageCount == 0
            && existingMessageCount == 0
            && expectsMessages(
                existingMessageCount: existingMessageCount,
                seedMessageCount: seedMessageCount,
                seedHasLastMessageDate: seedHasLastMessageDate
            )
    }
}

struct ConversationHistoryTemporarilyUnavailableError: Error {}
