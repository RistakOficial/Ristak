import Foundation
import Observation

/// Body de `POST /api/chat-events/viewing`.
private struct ChatPresenceReportBody: Encodable {
    let contactId: String
    let foreground: Bool
}

/// Reporte de presencia (doc research/11 §3): informa qué chat está abierto
/// para que el backend NO mande push de ese contacto y lo marque leído.
///
/// Reglas:
/// - Reportar al abrir/cambiar/cerrar conversación y en cambios de scenePhase.
/// - Keep-alive cada 20 s mientras el chat está visible y la app al frente
///   (TTL del servidor: 45 s).
/// - Al salir: `{ contactId: "", foreground: false }` borra la presencia.
/// - 100 % best-effort: TODO error se traga en silencio, incluido el 403
///   `write_access_required` de usuarios chat solo-lectura (audit doc 11 #2).
@MainActor
@Observable
final class PresenceReporter {
    /// Cadencia del keep-alive (TTL servidor 45 s ⇒ 20 s da margen).
    static let keepAliveInterval: TimeInterval = 20

    /// Contacto actualmente reportado (nil = sin presencia).
    private(set) var activeContactID: String?

    private var isForeground = true
    private var keepAliveTask: Task<Void, Never>?

    init() {}

    /// Empieza (o cambia) la presencia sobre un contacto.
    func startViewing(contactID: String) {
        let trimmed = contactID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            stopViewing()
            return
        }
        activeContactID = trimmed
        restartKeepAlive()
        Task { await report(contactID: trimmed, foreground: isForeground) }
    }

    /// Cierra la presencia (salir del chat / desmontar / logout).
    func stopViewing() {
        keepAliveTask?.cancel()
        keepAliveTask = nil
        guard activeContactID != nil else { return }
        activeContactID = nil
        Task { await report(contactID: "", foreground: false) }
    }

    /// Hook de scenePhase: `foreground: false` borra la presencia server-side
    /// de inmediato (vuelven los push); al regresar se re-reporta.
    func setForeground(_ foreground: Bool) {
        guard isForeground != foreground else { return }
        isForeground = foreground
        guard let contactID = activeContactID else { return }
        if foreground {
            restartKeepAlive()
        } else {
            keepAliveTask?.cancel()
            keepAliveTask = nil
        }
        Task { await report(contactID: contactID, foreground: foreground) }
    }

    private func restartKeepAlive() {
        keepAliveTask?.cancel()
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.keepAliveInterval * 1_000_000_000))
                if Task.isCancelled { return }
                guard let self else { return }
                guard let contactID = self.activeContactID, self.isForeground else { continue }
                await self.report(contactID: contactID, foreground: true)
            }
        }
    }

    /// `POST /api/chat-events/viewing` — respuesta 204; errores silenciados.
    private func report(contactID: String, foreground: Bool) async {
        try? await APIClient.shared.post(
            "/api/chat-events/viewing",
            body: ChatPresenceReportBody(contactId: contactID, foreground: foreground)
        )
    }
}
