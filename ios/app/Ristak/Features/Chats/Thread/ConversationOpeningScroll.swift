import Foundation

/// Una página anterior requiere un arrastre hacia el historial. La geometría
/// puede cambiar al abrir el teclado o reemplazar la copia guardada sin que el
/// usuario haya pedido desplazarse.
struct ConversationHistoryScrollIntent {
    private var pending = false

    mutating func beginDrag(towardHistory: Bool) {
        pending = towardHistory
    }

    mutating func cancel() {
        pending = false
    }

    mutating func consume() -> Bool {
        defer { pending = false }
        return pending
    }
}

/// Decide cómo tratar un `200 []` durante la primera apertura. La bandeja puede
/// saber que sí existe historial mientras la proyección de conversación todavía
/// está alcanzando el mensaje recién recibido. En ese caso vaciar un snapshot
/// bueno produce exactamente el síntoma de “salgo y vuelvo a entrar y aparece”.
enum ConversationPagePolicy {
    static func needsSourceVerification(pageIsEmpty: Bool, historyExpected: Bool) -> Bool {
        pageIsEmpty && historyExpected
    }

    static func replacesPreviousMessages(isInitialLoad: Bool, verifiedEmpty: Bool) -> Bool {
        isInitialLoad || verifiedEmpty
    }
}
