import Foundation
import Observation

/// Reloj de polling de reconciliación (doc research/11 §1, §10.3). El polling
/// NO es opcional: el SSE no re-entrega eventos perdidos.
///
/// Cadencias estándar: bandeja 12 s, hilo abierto 4 s, acuses 12 s. Un tick
/// sin cambios debe ser no-op visual (responsabilidad del `action`).
///
/// Hook de scenePhase: el shell llama `setPaused(true)` al pasar a background
/// y `setPaused(false)` al volver (des-pausar dispara todos los ticks una vez
/// para recuperar lo perdido).
@MainActor
@Observable
final class PollingClock {
    /// Intervalos estándar en segundos.
    enum Cadence {
        /// Bandeja de chats: 12 s.
        static let inbox: TimeInterval = 12
        /// Hilo de conversación abierto: 4 s.
        static let thread: TimeInterval = 4
        /// Acuses (receipts) de mensajes salientes: 12 s.
        static let receipts: TimeInterval = 12
    }

    private struct TickerDefinition {
        let interval: TimeInterval
        let action: @MainActor () async -> Void
    }

    private var definitions: [String: TickerDefinition] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private(set) var isPaused = false

    init() {}

    /// Programa (o reprograma) un ticker con id propio.
    /// - Parameters:
    ///   - id: identificador estable (`"inbox"`, `"thread"`, …).
    ///   - interval: segundos entre ticks.
    ///   - fireImmediately: dispara el `action` una vez al programar.
    func schedule(
        _ id: String,
        every interval: TimeInterval,
        fireImmediately: Bool = false,
        action: @escaping @MainActor () async -> Void
    ) {
        cancel(id)
        definitions[id] = TickerDefinition(interval: interval, action: action)
        tasks[id] = makeLoopTask(interval: interval, action: action)
        if fireImmediately && !isPaused {
            Task { await action() }
        }
    }

    /// Detiene un ticker.
    func cancel(_ id: String) {
        tasks[id]?.cancel()
        tasks[id] = nil
        definitions[id] = nil
    }

    /// Detiene todos los tickers (logout).
    func cancelAll() {
        for task in tasks.values { task.cancel() }
        tasks = [:]
        definitions = [:]
    }

    /// Pausa/reanuda los ticks (scenePhase). Al reanudar dispara todos los
    /// `action` una vez (equivalente al refresh al volver a foreground).
    func setPaused(_ paused: Bool) {
        guard isPaused != paused else { return }
        isPaused = paused
        guard !paused else { return }
        let actions = definitions.values.map { $0.action }
        Task {
            for action in actions {
                await action()
            }
        }
    }

    private func makeLoopTask(
        interval: TimeInterval,
        action: @escaping @MainActor () async -> Void
    ) -> Task<Void, Never> {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { return }
                guard let self else { return }
                if self.isPaused { continue }
                await action()
            }
        }
    }
}
