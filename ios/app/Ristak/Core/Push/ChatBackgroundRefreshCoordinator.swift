import BackgroundTasks
import Foundation
import UIKit

/// Compuerta idempotente para el contrato de BackgroundTasks. La expiración
/// debe reportar completion inmediatamente aunque una URLSession tarde unos
/// milisegundos más en observar la cancelación; la terminación normal posterior
/// no puede completar la misma tarea por segunda vez.
@MainActor
final class ChatBackgroundTaskCompletionGate {
    private(set) var isCompleted = false

    @discardableResult
    func finish(
        success: Bool,
        completion: (Bool) -> Void
    ) -> Bool {
        guard !isCompleted else { return false }
        isCompleted = true
        completion(success)
        return true
    }
}

enum ChatBackgroundNotificationPolicy {
    static func contactID(in userInfo: [AnyHashable: Any]) -> String? {
        let category = string("category", in: userInfo)?.lowercased() ?? ""
        let candidate = string("contactId", in: userInfo)
            ?? string("contact_id", in: userInfo)
        guard category == "chat", let candidate else { return nil }
        return candidate
    }

    private static func string(
        _ key: String,
        in userInfo: [AnyHashable: Any]
    ) -> String? {
        let value: String?
        if let string = userInfo[key] as? String {
            value = string
        } else if let number = userInfo[key] as? NSNumber {
            value = number.stringValue
        } else {
            value = nil
        }
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Trabajo de chats que iOS sí permite fuera del foreground:
///
/// - cada push de chat con `content-available` precalienta el hilo concreto;
/// - al ir a background termina un lote breve con el tiempo residual otorgado;
/// - `BGAppRefreshTask` revalida inbox + hilos recientes cuando el sistema lo
///   considere oportuno.
///
/// No promete ejecución continua (iOS no la ofrece), pero cada oportunidad real
/// aterriza en el mismo snapshot que consume `ConversationViewModel` al primer
/// frame. El completion se llama sólo después de `flushPendingWrites()`.
@MainActor
final class ChatBackgroundRefreshCoordinator {
    static let shared = ChatBackgroundRefreshCoordinator()
    static let refreshTaskIdentifier = "com.ristak.app.chat-refresh"
    private static let inboxRequestTimeout: TimeInterval = 10

    private enum RefreshOutcome: Equatable {
        case newData
        case noData
        case failed

        var fetchResult: UIBackgroundFetchResult {
            switch self {
            case .newData: .newData
            case .noData: .noData
            case .failed: .failed
            }
        }

        var completedSuccessfully: Bool { self != .failed }
    }

    private struct StoredSessionContext {
        let baseURL: URL
        let token: String
        let userID: String
        let namespace: RistakSnapshotCache.NamespaceToken
        let client: APIClient
        let clientGeneration: UInt64
    }

    private struct StoredClientIdentity: Equatable {
        let baseURL: URL
        let token: String
        let userID: String
    }

    private struct StoredClientLease {
        let identity: StoredClientIdentity
        let client: APIClient
        let preparation: Task<UInt64?, Never>
    }

    private struct ThreadRefreshOutcome {
        let succeeded: Bool
        let changed: Bool

        static let notAttempted = ThreadRefreshOutcome(
            succeeded: false,
            changed: false
        )
    }

    private var registered = false
    private var foregroundWork: Task<Void, Never>?
    private var foregroundWorkID: UUID?
    private var foregroundBackgroundTaskID: UIBackgroundTaskIdentifier = .invalid
    /// Reutiliza cliente + configuración entre pushes silenciosos. Sin esto,
    /// cada push tenía otro ObjectIdentifier y el single-flight por contacto no
    /// podía deduplicar una ráfaga real.
    private var storedClientLease: StoredClientLease?

    private init() {}

    func register() {
        guard !registered else { return }
        registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshTaskIdentifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                ChatBackgroundRefreshCoordinator.shared.handle(refreshTask)
            }
        }
    }

    func scheduleNextRefresh() {
        guard registered else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshTaskIdentifier)
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskIdentifier)
        // Es sólo una preferencia; iOS decide cuándo (o si) concede la ventana.
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Aprovecha el tiempo residual al salir de la app para dejar recientes los
    /// hilos que ya estaban arriba en la bandeja.
    func finishRecentThreadsAfterEnteringBackground(contactIDs: [String]) {
        let ids = ChatInboxSelection.normalizedIDs(contactIDs)
        guard !ids.isEmpty,
              let namespace = RistakSnapshotCache.shared.namespaceToken() else { return }
        cancelForegroundWork()

        let workID = UUID()
        foregroundWorkID = workID
        foregroundBackgroundTaskID = UIApplication.shared.beginBackgroundTask(
            withName: "RistakRecentChats"
        ) {
            Task { @MainActor in
                ChatBackgroundRefreshCoordinator.shared.cancelForegroundWork()
            }
        }

        foregroundWork = Task { [weak self] in
            _ = await ChatThreadPrewarmer.prewarm(
                contactIDs: ids,
                flushToDisk: false,
                ifCurrent: namespace
            )
            if !Task.isCancelled,
               RistakSnapshotCache.shared.isCurrent(namespace) {
                await RistakSnapshotCache.shared.flushPendingWrites()
            }
            guard let self, self.foregroundWorkID == workID else { return }
            self.finishForegroundWork()
        }
    }

    func refreshForRemoteNotification(
        userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        guard let contactID = ChatBackgroundNotificationPolicy.contactID(in: userInfo) else {
            return .noData
        }
        return await performStoredSessionRefresh(
            preferredContactID: contactID,
            includeRecentFanout: false
        ).fetchResult
    }

    // MARK: BGTask

    private func handle(_ task: BGAppRefreshTask) {
        scheduleNextRefresh()
        let completionGate = ChatBackgroundTaskCompletionGate()
        let operation = Task { [weak self] in
            guard let self else {
                completionGate.finish(success: false) {
                    task.setTaskCompleted(success: $0)
                }
                return
            }
            let outcome = await self.performStoredSessionRefresh(
                preferredContactID: nil,
                includeRecentFanout: true
            )
            completionGate.finish(
                success: !Task.isCancelled && outcome.completedSuccessfully
            ) {
                task.setTaskCompleted(success: $0)
            }
        }
        task.expirationHandler = {
            operation.cancel()
            Task { @MainActor in
                // No espera a que la red termine de desenrollar cancelación.
                completionGate.finish(success: false) {
                    task.setTaskCompleted(success: $0)
                }
            }
        }
    }

    // MARK: Refresh durable

    private func performStoredSessionRefresh(
        preferredContactID: String?,
        includeRecentFanout: Bool
    ) async -> RefreshOutcome {
        guard let context = await prepareStoredSession() else { return .noData }
        guard !Task.isCancelled else { return .failed }

        async let preferredThreadOutcome: ThreadRefreshOutcome = {
            guard let preferredContactID else { return ThreadRefreshOutcome.notAttempted }
            return await refreshPreferredThread(
                contactID: preferredContactID,
                context: context
            )
        }()

        let freshRows: [ChatContact]?
        var inboxSucceeded = false
        var inboxChanged = false
        do {
            let rows = try await ChatsService(client: context.client).fetchChats(
                limit: 12,
                warmProfilePictures: false,
                timeout: Self.inboxRequestTimeout
            )
            guard await storedSessionStillMatches(context) else {
                return .noData
            }

            let cached = ChatInboxDiskCache.load()
            let merged = rows.isEmpty
                ? cached
                : ChatInboxPaginator.mergeRefresh(cached, freshFirstPage: rows)
            if !rows.isEmpty, merged != cached {
                guard ChatInboxDiskCache.save(
                    merged,
                    ifCurrent: context.namespace
                ) else {
                    return .noData
                }
                inboxChanged = true
            }
            freshRows = rows
            inboxSucceeded = true
        } catch {
            freshRows = nil
        }
        if Task.isCancelled { return .failed }

        let preferredOutcome = await preferredThreadOutcome
        guard await storedSessionStillMatches(context) else { return .noData }

        var recentCount = 0
        var fanoutWasAttempted = false
        if includeRecentFanout {
            let candidates = ChatThreadPrewarmPolicy.candidateContactIDs(
                from: freshRows ?? ChatInboxDiskCache.load(),
                preferredContactID: preferredContactID,
                limit: ChatThreadPrewarmPolicy.routineLimit
            ).filter { $0 != preferredContactID }
            fanoutWasAttempted = !candidates.isEmpty
            recentCount = await ChatThreadPrewarmer.prewarm(
                contactIDs: candidates,
                flushToDisk: false,
                ifCurrent: context.namespace,
                service: JourneyService(client: context.client)
            )
        }

        guard !Task.isCancelled else { return .failed }
        guard await storedSessionStillMatches(context) else { return .noData }
        await RistakSnapshotCache.shared.flushPendingWrites()
        guard await storedSessionStillMatches(context) else { return .noData }

        if inboxChanged || preferredOutcome.changed || recentCount > 0 {
            return .newData
        }
        if inboxSucceeded || preferredOutcome.succeeded || fanoutWasAttempted {
            return .noData
        }
        return .failed
    }

    private func refreshPreferredThread(
        contactID: String,
        context: StoredSessionContext
    ) async -> ThreadRefreshOutcome {
        guard let writePermit = ChatThreadSnapshotCache.beginWrite(
            contactID: contactID,
            ifCurrent: context.namespace
        ) else {
            return ThreadRefreshOutcome(succeeded: false, changed: false)
        }
        do {
            let payload = try await ChatRecentConversationLoader.shared.load(
                contactID: contactID,
                service: JourneyService(client: context.client)
            )
            guard !Task.isCancelled,
                  await storedSessionStillMatches(context) else {
                return ThreadRefreshOutcome(succeeded: false, changed: false)
            }

            let messages = ChatJourneyParser.buildMessages(
                contactId: contactID,
                events: payload.events,
                appBaseURL: payload.appBaseURL
            )
            // Igual que al abrir un hilo: un vacío transitorio no destruye lo
            // último bueno que ya estaba en disco.
            guard !messages.isEmpty else {
                return ThreadRefreshOutcome(succeeded: true, changed: false)
            }
            let previous = ChatThreadSnapshotCache.load(contactID: contactID)
            let stored = await ChatThreadSnapshotCache.savePrepared(
                messages,
                contactID: contactID,
                flushToDisk: false,
                using: writePermit
            )
            return ThreadRefreshOutcome(
                succeeded: stored,
                changed: stored && previous != messages
            )
        } catch {
            return ThreadRefreshOutcome(succeeded: false, changed: false)
        }
    }

    /// Una ventana de background puede iniciar el proceso sin que el bootstrap
    /// visual haya corrido. Recupera exactamente la misma sesión de Keychain,
    /// crea un cliente HTTP aislado y sólo activa la caché si aún no había una
    /// sesión foreground configurada.
    private func prepareStoredSession() async -> StoredSessionContext? {
        let keychain = KeychainStore()
        guard let rawBaseURL = keychain.string(for: .baseURL),
              let baseURL = TenantResolver.cleanBaseURL(rawBaseURL),
              let token = keychain.string(for: .token),
              !token.isEmpty,
              let userData = keychain.data(for: .cachedUser),
              let user = try? JSONDecoder().decode(RistakUser.self, from: userData),
              let namespace = RistakSnapshotCache.namespace(
                baseURL: baseURL,
                userID: user.id
              ) else {
            return nil
        }

        // El cliente dedicado evita tocar la generación, requests y hooks de la
        // sesión foreground. La caché global sólo se activa si todavía estaba
        // sin configurar; jamás se cambia de cuenta desde un callback de push.
        let cache = RistakSnapshotCache.shared
        let cacheWasUnconfigured = cache.namespaceToken() == nil
        if cacheWasUnconfigured {
            cache.configure(namespace: namespace)
        } else if !cache.isConfigured(for: namespace) {
            return nil
        }
        guard let namespaceToken = cache.namespaceToken() else { return nil }
        if cacheWasUnconfigured {
            await cache.preloadIntoMemory()
            guard cache.isCurrent(namespaceToken) else { return nil }
        }

        // Una ventana silenciosa de iOS ronda decenas de segundos; sin reintentos
        // de 503, target (15 s) e inbox (10 s) siempre caben al correr en paralelo.
        // La preparación también es single-flight: callbacks reentrantes reciben
        // el MISMO cliente aun si el primero sigue configurándolo.
        let identity = StoredClientIdentity(
            baseURL: baseURL,
            token: token,
            userID: user.id
        )
        let lease: StoredClientLease
        if let current = storedClientLease, current.identity == identity {
            lease = current
        } else {
            storedClientLease?.preparation.cancel()
            let client = APIClient(maxStartupRetries: 0)
            let preparation = Task { () -> UInt64? in
                await client.configure(baseURL: baseURL, token: token)
                guard !Task.isCancelled, await client.hasSession else { return nil }
                return await client.currentConfigurationGeneration
            }
            let created = StoredClientLease(
                identity: identity,
                client: client,
                preparation: preparation
            )
            storedClientLease = created
            lease = created
        }
        guard let clientGeneration = await lease.preparation.value,
              !Task.isCancelled,
              storedClientLease?.identity == identity,
              storedClientLease?.client === lease.client else { return nil }
        let context = StoredSessionContext(
            baseURL: baseURL,
            token: token,
            userID: user.id,
            namespace: namespaceToken,
            client: lease.client,
            clientGeneration: clientGeneration
        )
        return await storedSessionStillMatches(context) ? context : nil
    }

    /// Revalida tanto el Keychain como las dos generaciones involucradas antes
    /// de cada persistencia y justo antes del completion de iOS.
    private func storedSessionStillMatches(
        _ context: StoredSessionContext
    ) async -> Bool {
        guard RistakSnapshotCache.shared.isCurrent(context.namespace) else { return false }
        let keychain = KeychainStore()
        guard let rawBaseURL = keychain.string(for: .baseURL),
              TenantResolver.cleanBaseURL(rawBaseURL) == context.baseURL,
              keychain.string(for: .token) == context.token,
              let userData = keychain.data(for: .cachedUser),
              let user = try? JSONDecoder().decode(RistakUser.self, from: userData),
              user.id == context.userID else { return false }

        let generation = await context.client.currentConfigurationGeneration
        let currentBaseURL = await context.client.currentBaseURL
        let hasSession = await context.client.hasSession
        return generation == context.clientGeneration
            && currentBaseURL == context.baseURL
            && hasSession
    }

    // MARK: Tiempo residual foreground → background

    private func cancelForegroundWork() {
        foregroundWork?.cancel()
        finishForegroundWork()
    }

    private func finishForegroundWork() {
        foregroundWork = nil
        foregroundWorkID = nil
        guard foregroundBackgroundTaskID != .invalid else { return }
        UIApplication.shared.endBackgroundTask(foregroundBackgroundTaskID)
        foregroundBackgroundTaskID = .invalid
    }
}
