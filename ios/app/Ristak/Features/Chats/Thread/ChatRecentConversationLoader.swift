import Foundation

struct ChatRecentConversationPayload: Sendable {
    let events: [JourneyEvent]
    let appBaseURL: URL?
}

/// Single-flight de la página reciente. La precarga de bandeja y la apertura del
/// hilo comparten el mismo request si ocurren a la vez, en vez de pegarle dos
/// veces al backend justo en el toque del usuario.
actor ChatRecentConversationLoader {
    static let shared = ChatRecentConversationLoader()

    typealias FetchOperation = @Sendable (
        _ contactID: String,
        _ limit: Int,
        _ service: JourneyService
    ) async throws -> ChatRecentConversationPayload

    private struct Key: Hashable, Sendable {
        let clientIdentity: ObjectIdentifier
        let configurationGeneration: UInt64
        let contactID: String
        let limit: Int
    }

    private struct Entry {
        let id: UUID
        let task: Task<Void, Never>
        var waiters: [UUID: CheckedContinuation<ChatRecentConversationPayload, Error>]
    }

    private var inFlight: [Key: Entry] = [:]
    private let fetchOperation: FetchOperation

    init() {
        fetchOperation = { contactID, limit, service in
            let events = try await service.fetchConversationEvents(
                contactId: contactID,
                limit: limit
            )
            let appBaseURL = await service.currentBaseURL()
            return ChatRecentConversationPayload(events: events, appBaseURL: appBaseURL)
        }
    }

    /// Inyección interna para probar cancelación/single-flight sin pegarle a la
    /// red. Producción siempre usa `shared` y el fetch real de arriba.
    init(fetchOperation: @escaping FetchOperation) {
        self.fetchOperation = fetchOperation
    }

    func load(
        contactID: String,
        limit: Int = JourneyService.defaultMessageLimit,
        service: JourneyService = JourneyService()
    ) async throws -> ChatRecentConversationPayload {
        let generation = await service.client.currentConfigurationGeneration
        let key = Key(
            clientIdentity: ObjectIdentifier(service.client),
            configurationGeneration: generation,
            contactID: contactID,
            limit: limit
        )
        try Task.checkCancellation()
        let waiterID = UUID()

        // Cada consumidor tiene su propia continuación. Cancelar una ventana de
        // background la libera inmediatamente; el request compartido sólo se
        // cancela cuando ya no queda ningún consumidor legítimo.
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                registerWaiter(
                    continuation,
                    waiterID: waiterID,
                    key: key,
                    contactID: contactID,
                    limit: limit,
                    service: service
                )
            }
        } onCancel: {
            Task {
                await self.cancelWaiter(waiterID: waiterID, key: key)
            }
        }
    }

    private func registerWaiter(
        _ continuation: CheckedContinuation<ChatRecentConversationPayload, Error>,
        waiterID: UUID,
        key: Key,
        contactID: String,
        limit: Int,
        service: JourneyService
    ) {
        if var entry = inFlight[key] {
            entry.waiters[waiterID] = continuation
            inFlight[key] = entry
            return
        }

        let operationID = UUID()
        let operation = fetchOperation
        let task = Task { [weak self] in
            let result: Result<ChatRecentConversationPayload, Error>
            do {
                result = .success(try await operation(contactID, limit, service))
            } catch {
                result = .failure(error)
            }
            await self?.finish(key: key, operationID: operationID, result: result)
        }
        inFlight[key] = Entry(
            id: operationID,
            task: task,
            waiters: [waiterID: continuation]
        )
    }

    private func cancelWaiter(waiterID: UUID, key: Key) {
        guard var entry = inFlight[key],
              let continuation = entry.waiters.removeValue(forKey: waiterID) else { return }
        continuation.resume(throwing: CancellationError())
        if entry.waiters.isEmpty {
            inFlight[key] = nil
            entry.task.cancel()
        } else {
            inFlight[key] = entry
        }
    }

    private func finish(
        key: Key,
        operationID: UUID,
        result: Result<ChatRecentConversationPayload, Error>
    ) {
        guard let entry = inFlight[key], entry.id == operationID else { return }
        inFlight[key] = nil
        entry.waiters.values.forEach { $0.resume(with: result) }
    }

    /// Sólo para pruebas de la semántica de leases; no participa en producción.
    func waiterCountForTesting(
        contactID: String,
        limit: Int = JourneyService.defaultMessageLimit,
        service: JourneyService
    ) async -> Int {
        let generation = await service.client.currentConfigurationGeneration
        let key = Key(
            clientIdentity: ObjectIdentifier(service.client),
            configurationGeneration: generation,
            contactID: contactID,
            limit: limit
        )
        return inFlight[key]?.waiters.count ?? 0
    }
}

enum ChatThreadPrewarmPolicy {
    static let routineLimit = 6
    static let routineFreshness: TimeInterval = 4 * 60

    static func candidateContactIDs(
        from contacts: [ChatContact],
        preferredContactID: String? = nil,
        limit: Int = routineLimit
    ) -> [String] {
        guard limit > 0 else { return [] }
        var ids: [String] = []
        var seen: Set<String> = []

        func append(_ raw: String?) {
            let id = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !id.isEmpty, seen.insert(id).inserted, ids.count < limit else { return }
            ids.append(id)
        }

        append(preferredContactID)
        for contact in contacts where ids.count < limit {
            append(contact.id)
        }
        return ids
    }

    static func isFresh(
        updatedAt: Date?,
        now: Date = Date(),
        maxAge: TimeInterval = routineFreshness
    ) -> Bool {
        guard let updatedAt, maxAge > 0 else { return false }
        let age = now.timeIntervalSince(updatedAt)
        return age >= 0 && age < maxAge
    }
}

/// Precarga acotada de hilos recientes. Sólo mantiene dos requests simultáneos
/// para no convertir una mejora local en una tormenta contra el tenant.
enum ChatThreadPrewarmer {
    nonisolated static func prewarm(
        contactIDs: [String],
        forceContactID: String? = nil,
        flushToDisk: Bool = false,
        ifCurrent expectedNamespace: RistakSnapshotCache.NamespaceToken? = nil,
        service: JourneyService = JourneyService()
    ) async -> Int {
        let ids = ChatInboxSelection.normalizedIDs(contactIDs)
        guard !ids.isEmpty else { return 0 }
        let namespace = await MainActor.run {
            expectedNamespace ?? RistakSnapshotCache.shared.namespaceToken()
        }
        guard let namespace else { return 0 }

        var loadedCount = 0
        for batchStart in stride(from: 0, to: ids.count, by: 2) {
            if Task.isCancelled { break }
            let batch = Array(ids[batchStart..<min(batchStart + 2, ids.count)])
            loadedCount += await withTaskGroup(of: Bool.self, returning: Int.self) { group in
                for contactID in batch {
                    group.addTask {
                        if Task.isCancelled { return false }
                        let stillCurrent = await MainActor.run {
                            RistakSnapshotCache.shared.isCurrent(namespace)
                        }
                        guard stillCurrent else { return false }
                        let shouldForce = forceContactID == contactID
                        if !shouldForce {
                            let updatedAt = await MainActor.run {
                                ChatThreadSnapshotCache.lastUpdatedAt(contactID: contactID)
                            }
                            if ChatThreadPrewarmPolicy.isFresh(updatedAt: updatedAt) {
                                return false
                            }
                        }

                        // El turno se reserva antes del GET. Si otro request del
                        // mismo hilo arranca después y termina primero, esta
                        // respuesta ya no podrá pisarlo al codificar/persistir.
                        guard let writePermit = await MainActor.run(body: {
                            ChatThreadSnapshotCache.beginWrite(
                                contactID: contactID,
                                ifCurrent: namespace
                            )
                        }) else { return false }

                        do {
                            let payload = try await ChatRecentConversationLoader.shared.load(
                                contactID: contactID,
                                service: service
                            )
                            if Task.isCancelled { return false }
                            let messages = ChatJourneyParser.buildMessages(
                                contactId: contactID,
                                events: payload.events,
                                appBaseURL: payload.appBaseURL
                            )
                            // Un vacío transitorio nunca destruye un hilo bueno.
                            guard !messages.isEmpty else { return false }
                            return await ChatThreadSnapshotCache.savePrepared(
                                messages,
                                contactID: contactID,
                                flushToDisk: flushToDisk,
                                using: writePermit
                            )
                        } catch {
                            return false
                        }
                    }
                }

                var completed = 0
                for await didLoad in group where didLoad { completed += 1 }
                return completed
            }
        }
        return loadedCount
    }
}
