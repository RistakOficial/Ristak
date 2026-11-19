import Foundation

/// Cada panel tiene una sola respuesta vigente y su propio reintento. Una
/// respuesta tardía del filtro anterior nunca reemplaza una consulta más nueva.
@MainActor
final class AnalyticsRecovery {
    enum Panel: Hashable {
        case metrics, chart, funnel, origin, phones, phoneBreakdown, labels
    }

    struct Request {
        let panel: Panel
        fileprivate let id: UUID
    }

    private var latest: [Panel: UUID] = [:]
    private var attempts: [Panel: Int] = [:]
    private var timers: [Panel: Task<Void, Never>] = [:]
    private let delays: [Duration]

    init(delays: [Duration] = [.seconds(2), .seconds(5), .seconds(15), .seconds(30), .seconds(60)]) {
        precondition(!delays.isEmpty)
        self.delays = delays
    }

    func begin(_ panel: Panel) -> Request {
        timers.removeValue(forKey: panel)?.cancel()
        let request = Request(panel: panel, id: UUID())
        latest[panel] = request.id
        return request
    }

    func isCurrent(_ request: Request) -> Bool {
        !Task.isCancelled && latest[request.panel] == request.id
    }

    func finish(_ request: Request) {
        if isCurrent(request) { attempts[request.panel] = nil }
    }

    func invalidate(_ panel: Panel) {
        timers.removeValue(forKey: panel)?.cancel()
        latest[panel] = nil
        attempts[panel] = nil
    }

    func stop() {
        for task in timers.values { task.cancel() }
        timers.removeAll()
        attempts.removeAll()
        latest.removeAll()
    }

    func retry(_ request: Request, action: @escaping @MainActor () async -> Void) {
        guard isCurrent(request), timers[request.panel] == nil else { return }
        let attempt = attempts[request.panel, default: 0]
        let delay = delays[attempt]
        attempts[request.panel] = min(attempt + 1, delays.count - 1)
        timers[request.panel] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, self.isCurrent(request) else { return }
            self.timers[request.panel] = nil
            await action()
        }
    }
}
