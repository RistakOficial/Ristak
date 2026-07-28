import Foundation

enum CalendarAppointmentOutboxStatus: String, Codable, Sendable {
    case pending
    case failed
}

struct CalendarAppointmentOutboxEntry: Codable, Identifiable, Sendable, Equatable {
    var id: String { clientRequestId }

    let clientRequestId: String
    var draft: AppointmentDraftRequest
    var status: CalendarAppointmentOutboxStatus
    let createdAt: String
    var updatedAt: String
    var attempts: Int
    var lastError: String?
}

struct CalendarAppointmentOutboxFlushResult: Sendable {
    let synced: [CalendarAppointment]
    let pending: [CalendarAppointmentOutboxEntry]
    let failed: [CalendarAppointmentOutboxEntry]
    let attempted: Bool
    let requestSucceeded: Bool
    let didChange: Bool

    var changed: Bool { didChange }
}

/// Cola durable de citas creadas sin red.
///
/// Vive dentro del namespace de `RistakSnapshotCache`, por lo que nunca mezcla
/// cuentas. El bearer no forma parte del borrador persistido. Cada replay usa
/// el mismo `clientRequestId` reservado por backend para que un timeout después
/// del commit no duplique la cita ni sus efectos externos.
@MainActor
final class CalendarAppointmentOutbox {
    static let shared = CalendarAppointmentOutbox()
    static let localEventPrefix = "offline-appointment:"

    private var flushTask: Task<CalendarAppointmentOutboxFlushResult, Never>?

    private init() {}

    var entries: [CalendarAppointmentOutboxEntry] {
        RistakSnapshotCache.shared.value(
            [CalendarAppointmentOutboxEntry].self,
            for: RistakCacheKey.calendarAppointmentOutbox
        ) ?? []
    }

    var pendingCount: Int {
        entries.filter { $0.status == .pending }.count
    }

    var failedCount: Int {
        entries.filter { $0.status == .failed }.count
    }

    func enqueue(
        draft originalDraft: AppointmentDraftRequest,
        clientRequestId: String
    ) async -> CalendarAppointment {
        var current = entries
        if let existing = current.first(where: { $0.clientRequestId == clientRequestId }) {
            return localAppointment(for: existing)
        }

        var draft = originalDraft
        draft.clientRequestId = clientRequestId
        let now = RistakDateParsing.isoString(from: Date())
        let entry = CalendarAppointmentOutboxEntry(
            clientRequestId: clientRequestId,
            draft: draft,
            status: .pending,
            createdAt: now,
            updatedAt: now,
            attempts: 0,
            lastError: nil
        )
        current.append(entry)
        persist(current)
        let appointment = localAppointment(for: entry)
        updateMonthCache(entry: entry, replacement: appointment)
        await RistakSnapshotCache.shared.flushPendingWrites()
        return appointment
    }

    func merge(
        canonical: [CalendarAppointment],
        calendarID: String?,
        interval: DateInterval? = nil
    ) -> [CalendarAppointment] {
        let local = entries
            .filter { entry in
                guard let calendarID, !calendarID.isEmpty else { return true }
                return entry.draft.calendarId == calendarID
            }
            .map { localAppointment(for: $0) }
            .filter { event in
                guard let interval, let start = event.startDate else { return true }
                return interval.contains(start)
            }
        let canonicalOnly = canonical.filter { !$0.isOfflinePlaceholder }
        return (local + canonicalOnly).sorted {
            ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast)
        }
    }

    func retryFailed() {
        let now = RistakDateParsing.isoString(from: Date())
        let next = entries.map { entry in
            guard entry.status == .failed else { return entry }
            var retry = entry
            retry.status = .pending
            retry.updatedAt = now
            retry.lastError = nil
            updateMonthCache(entry: retry, replacement: localAppointment(for: retry))
            return retry
        }
        persist(next)
    }

    @discardableResult
    func discard(localEventID: String) -> Bool {
        guard localEventID.hasPrefix(Self.localEventPrefix) else { return false }
        let requestID = String(localEventID.dropFirst(Self.localEventPrefix.count))
        var current = entries
        guard let entry = current.first(where: { $0.clientRequestId == requestID }) else {
            return false
        }
        current.removeAll { $0.clientRequestId == requestID }
        persist(current)
        updateMonthCache(entry: entry, replacement: nil)
        return true
    }

    func flush(client: APIClient = .shared) async -> CalendarAppointmentOutboxFlushResult {
        if let flushTask {
            return await flushTask.value
        }

        let task = Task { @MainActor in
            await performFlush(client: client)
        }
        flushTask = task
        let result = await task.value
        flushTask = nil
        return result
    }

    private func performFlush(client: APIClient) async -> CalendarAppointmentOutboxFlushResult {
        var current = entries
        var synced: [CalendarAppointment] = []
        var attempted = false
        var requestSucceeded = false
        var didChange = false

        for snapshot in current where snapshot.status == .pending {
            if Task.isCancelled { break }
            attempted = true
            do {
                let created = try await CalendarsService.createAppointment(
                    snapshot.draft,
                    client: client
                )
                requestSucceeded = true
                didChange = true
                synced.append(created)
                current.removeAll { $0.clientRequestId == snapshot.clientRequestId }
                persist(current)
                updateMonthCache(entry: snapshot, replacement: created)
            } catch is CancellationError {
                break
            } catch {
                let retryable = shouldQueue(error)
                if !retryable { requestSucceeded = true }
                if !retryable { didChange = true }
                let now = RistakDateParsing.isoString(from: Date())
                current = current.map { entry in
                    guard entry.clientRequestId == snapshot.clientRequestId else { return entry }
                    var updated = entry
                    updated.status = retryable ? .pending : .failed
                    updated.updatedAt = now
                    updated.attempts += 1
                    updated.lastError = (error as? RistakAPIError)?.message
                        ?? error.localizedDescription
                    return updated
                }
                persist(current)
                if let updated = current.first(where: {
                    $0.clientRequestId == snapshot.clientRequestId
                }) {
                    updateMonthCache(
                        entry: updated,
                        replacement: localAppointment(for: updated)
                    )
                }
                if retryable { break }
            }
        }

        await RistakSnapshotCache.shared.flushPendingWrites()
        return CalendarAppointmentOutboxFlushResult(
            synced: synced,
            pending: current.filter { $0.status == .pending },
            failed: current.filter { $0.status == .failed },
            attempted: attempted,
            requestSucceeded: requestSucceeded,
            didChange: didChange
        )
    }

    func shouldQueue(_ error: Error) -> Bool {
        guard let api = error as? RistakAPIError else { return true }
        if api.status == 0 { return true }
        return api.status == 408
            || api.status == 425
            || api.status == 429
            || api.status >= 500
    }

    private func persist(_ entries: [CalendarAppointmentOutboxEntry]) {
        RistakSnapshotCache.shared.store(
            entries,
            for: RistakCacheKey.calendarAppointmentOutbox
        )
    }

    private func localAppointment(
        for entry: CalendarAppointmentOutboxEntry
    ) -> CalendarAppointment {
        let draft = entry.draft
        let status = draft.appointmentStatus ?? "confirmed"
        return CalendarAppointment(
            id: "\(Self.localEventPrefix)\(entry.clientRequestId)",
            calendarId: draft.calendarId ?? "",
            contactId: draft.contactId,
            title: draft.title ?? "Cita",
            status: status,
            appointmentStatusRaw: status,
            assignedUserId: draft.assignedUserId,
            notes: draft.notes ?? "",
            address: draft.address ?? "",
            startTime: draft.startTime ?? "",
            endTime: draft.endTime ?? draft.startTime ?? "",
            dateAdded: entry.createdAt,
            dateUpdated: entry.updatedAt,
            syncStatus: entry.status == .failed ? "local_failed" : "local_pending",
            syncError: entry.lastError
        )
    }

    private func updateMonthCache(
        entry: CalendarAppointmentOutboxEntry,
        replacement: CalendarAppointment?
    ) {
        guard let startISO = entry.draft.startTime,
              let start = RistakDateParsing.date(fromISO: startISO),
              let zoneID = entry.draft.timeZone,
              let zone = TimeZone(identifier: zoneID) else { return }
        let day = CalendarDateMath.day(from: start, timeZone: zone)
        let month = String(format: "%04d-%02d", day.year, day.month)
        let key = RistakCacheKey.calendarEvents(
            month: month,
            calendarID: entry.draft.calendarId
        )
        let localID = "\(Self.localEventPrefix)\(entry.clientRequestId)"
        let replacementID = replacement?.id
        var cached = RistakSnapshotCache.shared.value(
            [CalendarAppointment].self,
            for: key
        ) ?? []
        cached.removeAll { event in
            event.id == localID || (replacementID != nil && event.id == replacementID)
        }
        if let replacement {
            cached.insert(replacement, at: 0)
        }
        guard let data = CalendarSnapshotCodec.encode(appointments: cached) else { return }
        RistakSnapshotCache.shared.storeRaw(data, for: key)
    }
}
