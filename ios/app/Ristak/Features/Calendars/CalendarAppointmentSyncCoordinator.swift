import Foundation
@preconcurrency import Network

/// Detecta reconexión mientras la app vive y vacía la cola durable.
///
/// iOS puede suspender o matar el proceso, así que esta ruta se complementa con
/// foreground y `BGAppRefreshTask`; ninguna promete ejecución continua.
@MainActor
final class CalendarAppointmentSyncCoordinator {
    static let shared = CalendarAppointmentSyncCoordinator()
    static let didFinishSyncNotification = Notification.Name(
        "ristak.calendarAppointmentSync.didFinish"
    )

    private let queue = DispatchQueue(
        label: "com.ristak.app.calendar-connectivity",
        qos: .utility
    )
    private var monitor: NWPathMonitor?
    private var syncTask: Task<Void, Never>?

    private init() {}

    func start() {
        guard monitor == nil else { return }
        let next = NWPathMonitor()
        next.pathUpdateHandler = { path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in
                CalendarAppointmentSyncCoordinator.shared.syncNow()
            }
        }
        monitor = next
        next.start(queue: queue)
    }

    func stop() {
        monitor?.cancel()
        monitor = nil
        syncTask?.cancel()
        syncTask = nil
    }

    func syncNow() {
        guard syncTask == nil else { return }
        syncTask = Task { @MainActor [weak self] in
            let result = await CalendarAppointmentOutbox.shared.flush()
            if result.didChange {
                NotificationCenter.default.post(
                    name: Self.didFinishSyncNotification,
                    object: nil
                )
            }
            self?.syncTask = nil
        }
    }
}
