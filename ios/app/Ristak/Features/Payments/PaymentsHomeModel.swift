import Foundation
import Observation

/// Estado del home de Pagos: capacidades (pasarelas + licencia), últimos pagos
/// por periodo (con paginación) y refresh en vivo vía SSE de pagos.
@MainActor
@Observable
final class PaymentsHomeModel {
    // MARK: Capacidades (doc 08 §5.1-5.2 + doc 13 §7.2)

    /// `nil` mientras carga; fallback offline si ambas lecturas fallan.
    private(set) var capabilities: PaymentCapabilities?
    /// Estado crudo de integraciones (para saber si HighLevel está conectado).
    private(set) var integrations: IntegrationsStatus?

    // MARK: Últimos pagos

    var period: RecentPaymentsPeriod = .month {
        didSet {
            guard oldValue != period else { return }
            Task { await loadRecentPayments(reset: true) }
        }
    }

    private(set) var recentPayments: [PaymentTransaction] = []
    private(set) var isLoadingRecent = false
    private(set) var isLoadingMore = false
    private(set) var recentError: RistakAPIError?
    /// 403 de módulo `payments`: la vista pinta el estado «sin acceso».
    private(set) var accessDenied = false
    private(set) var hasMorePages = false
    private var currentPage = 1
    private var loadGeneration = 0

    // MARK: Realtime

    private let eventsClient = PaymentEventsClient()
    private var eventsTask: Task<Void, Never>?
    private var eventsControl: Task<Void, Never>?
    private var eventsGeneration: UInt64 = 0
    private var refreshDebounceTask: Task<Void, Never>?
    /// Cambia cuando llega `subscription_changed` (las vistas de suscripciones
    /// lo observan para refrescarse).
    private(set) var subscriptionsRefreshTick = 0

    /// Último HighLevel conectado conocido (se conserva de la caché para que el
    /// gating dependiente de HL pinte al instante sin esperar a integraciones).
    private var cachedHighLevelConnected: Bool?

    // MARK: Dependencias

    private let timeZoneProvider: () -> TimeZone
    private let cache = RistakSnapshotCache.shared

    init(timeZoneProvider: @escaping () -> TimeZone) {
        self.timeZoneProvider = timeZoneProvider
        hydrateFromCache()
    }

    // MARK: - Caché instantánea (stale-while-revalidate, Round 6 #4)

    /// Pinta AL INSTANTE lo último que el usuario vio (capacidades + últimos
    /// pagos del periodo actual) desde memoria, ANTES de golpear la red. Cero
    /// spinner cuando hay caché; la revalidación reemplaza en su lugar.
    private func hydrateFromCache() {
        if capabilities == nil,
           let snapshot = cache.value(PaymentCapabilitiesSnapshot.self, for: PaymentsCache.capabilitiesKey) {
            capabilities = snapshot.capabilities
            cachedHighLevelConnected = snapshot.isHighLevelConnected
        }
        if recentPayments.isEmpty, let cached = cachedRecentPayments(for: period) {
            recentPayments = cached
        }
    }

    /// Últimos pagos cacheados para un periodo (o `nil` si no hay).
    private func cachedRecentPayments(for period: RecentPaymentsPeriod) -> [PaymentTransaction]? {
        cache.value([PaymentTransaction].self, for: PaymentsCache.recentKey(for: period))
    }

    /// Persiste la lista actual (capada) como DTO Encodable; se lee de vuelta
    /// como `[PaymentTransaction]`.
    private func storeRecentPayments(for period: RecentPaymentsPeriod) {
        let capped = recentPayments.prefix(PaymentsCache.recentCap).map(PaymentTransactionSnapshot.init)
        cache.store(Array(capped), for: PaymentsCache.recentKey(for: period))
    }

    // MARK: - Carga inicial

    func loadIfNeeded() async {
        let performanceSpan = RistakObservability.begin(.paymentsLoad)
        defer {
            let outcome: RistakPerformanceOutcome
            if accessDenied {
                outcome = .unavailable
            } else if recentError != nil {
                outcome = .failed
            } else {
                outcome = .success
            }
            performanceSpan.finish(outcome: outcome, itemCount: recentPayments.count)
        }
        // SWR: capacidades y recientes ya pintaron desde caché en `init`. Aquí
        // solo revalidamos contra la red (sin spinner si hubo caché).
        await refreshCapabilities()
        if !isLoadingRecent {
            await loadRecentPayments(reset: true)
        }
    }

    func refreshAll() async {
        async let capsTask: Void = refreshCapabilities()
        async let recentTask: Void = loadRecentPayments(reset: true)
        _ = await (capsTask, recentTask)
    }

    func refreshCapabilities() async {
        // Integraciones + licencia en paralelo, tolerante a fallos (RN
        // `resolveMobilePaymentAccess`).
        async let integrationsTask = try? IntegrationsService.status()
        async let licenseTask = try? IntegrationsService.licenseStatus()
        let (integrationsResult, license) = await (integrationsTask, licenseTask)

        // Las pasarelas SOLO vienen de integraciones. Si esa lectura falla, NO
        // degradamos a "offline": conservamos lo último conocido (caché/memoria)
        // para no ocultar una función que el usuario tenía la sesión anterior.
        if let integrationsResult {
            integrations = integrationsResult
            let resolved = PaymentCapabilities.resolve(integrations: integrationsResult, license: license)
            let hlConnected = integrationsResult.isHighLevelConnected
            capabilities = resolved
            cachedHighLevelConnected = hlConnected
            cache.store(
                PaymentCapabilitiesSnapshot(capabilities: resolved, isHighLevelConnected: hlConnected),
                for: PaymentsCache.capabilitiesKey
            )
        } else if capabilities == nil {
            // Nada cacheado y la red falló: fallback offline seguro.
            capabilities = .offlineFallback
        }
    }

    var isHighLevelConnected: Bool {
        integrations?.isHighLevelConnected ?? cachedHighLevelConnected ?? false
    }

    // MARK: - Últimos pagos (doc 08 §6.1: paid|partial, monto > 0, desc)

    private static let pageSize = 50

    func loadRecentPayments(reset: Bool) async {
        loadGeneration += 1
        let generation = loadGeneration
        // Periodo fijado para ESTA carga (evita cachear/guardar bajo un chip que
        // el usuario ya cambió a media petición).
        let requestedPeriod = period

        if reset {
            currentPage = 0
            // SWR: pinta al instante lo cacheado de ESTE periodo (p. ej. al
            // cambiar de chip). Spinner SOLO cuando el periodo no tiene caché.
            if let cached = cachedRecentPayments(for: requestedPeriod) {
                recentPayments = cached
                isLoadingRecent = false
            } else {
                recentPayments = []
                isLoadingRecent = true
            }
            recentError = nil
        } else {
            guard hasMorePages, !isLoadingMore else { return }
            isLoadingMore = true
        }
        defer {
            if generation == loadGeneration {
                isLoadingRecent = false
                isLoadingMore = false
            }
        }

        let range = PaymentsDateMath.range(for: requestedPeriod, timeZone: timeZoneProvider())

        do {
            // El backend filtra `paid,partial` antes de paginar. El filtro local
            // queda como defensa de contrato y para excluir montos cero; ya no se
            // recorren decenas de paginas de pendientes para hallar un recibido.
            var collected: [PaymentTransaction] = []
            var page = currentPage
            var hasNext = false

            repeat {
                page += 1
                let result = try await PaymentsService.transactions(
                    page: page,
                    limit: Self.pageSize,
                    statuses: "paid,partial",
                    startDate: range.start,
                    endDate: range.end,
                    sortBy: "date",
                    sortOrder: "DESC"
                )
                guard generation == loadGeneration else { return }

                let received = result.transactions.filter { transaction in
                    transaction.amount > 0 && (transaction.transactionStatus?.countsAsReceived == true)
                }
                collected.append(contentsOf: received)
                currentPage = page
                hasNext = result.pagination?.hasNext ?? false
                // Sigue solo mientras no hayamos encontrado ninguna recibida todavía
                // y aún queden páginas por delante.
            } while hasNext && collected.isEmpty

            if reset {
                recentPayments = collected
            } else {
                var merged = recentPayments
                let known = Set(merged.map(\.id))
                merged.append(contentsOf: collected.filter { !known.contains($0.id) })
                recentPayments = merged
            }
            recentPayments.sort { lhs, rhs in
                (lhs.sortDate ?? .distantPast) > (rhs.sortDate ?? .distantPast)
            }

            hasMorePages = hasNext
            accessDenied = false
            recentError = nil

            // SWR: persiste la lista fresca (capada) bajo el periodo de ESTA
            // petición para el próximo arranque en frío.
            storeRecentPayments(for: requestedPeriod)
        } catch let error as RistakAPIError {
            guard generation == loadGeneration else { return }
            if error.isAccessDenied {
                accessDenied = true
            } else if error.kind == .featureUnavailable {
                // Silencioso en cargas (doc 13 §6.2): lista vacía sin regaño.
                recentPayments = []
                hasMorePages = false
            } else if reset {
                recentError = error
            }
        } catch {
            guard generation == loadGeneration, reset else { return }
            recentError = RistakAPIError(
                kind: .server,
                status: 0,
                message: "No se pudieron cargar los pagos.",
                underlying: error
            )
        }
    }

    func loadMoreIfNeeded(current transaction: PaymentTransaction) {
        guard hasMorePages, !isLoadingMore, !isLoadingRecent else { return }
        guard transaction.id == recentPayments.last?.id else { return }
        Task { await loadRecentPayments(reset: false) }
    }

    /// Refresh silencioso (SSE / al volver de un flujo de cobro).
    func refreshRecentSilently() {
        // Un burst de webhooks/SSE se convierte en una sola reconciliacion. La
        // lista no necesita lanzar una descarga completa por cada frame.
        refreshDebounceTask?.cancel()
        refreshDebounceTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 250_000_000)
                try Task.checkCancellation()
            } catch {
                return
            }
            await self?.loadRecentPayments(reset: true)
        }
    }

    // MARK: - SSE (doc 11 §4): eventos → refresh REST coalescido

    func startRealtime() {
        guard eventsTask == nil else { return }
        eventsGeneration &+= 1
        let generation = eventsGeneration
        // Capturar el CLIENTE (no self) y hacer `guard let self` DENTRO del loop,
        // como los otros clientes SSE del proyecto (Chats/Bandeja): así `self` solo
        // es fuerte durante el cuerpo de cada iteración y NO durante la suspensión
        // del `for await`. Antes el `guard let self` estaba FUERA del loop → self
        // quedaba retenido todo el Task (self→eventsTask→Task→self = retain cycle),
        // y si `onDisappear`/`stopRealtime()` no llegaban (teardown abrupto), la
        // conexión SSE seguía reconectando para siempre sobre un modelo fantasma.
        let client = eventsClient
        let previous = eventsControl
        let task = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled else { return }
            let stream = await client.start()
            for await event in stream {
                guard !Task.isCancelled else { break }
                guard let self else { return }
                switch event {
                case .connected:
                    // SSE no tiene replay: al reconectar, REST confirma lo que
                    // pudo ocurrir durante el corte.
                    self.refreshRecentSilently()
                case .paymentChanged:
                    self.refreshRecentSilently()
                case .subscriptionChanged:
                    self.subscriptionsRefreshTick &+= 1
                }
            }
            guard let self, !Task.isCancelled, generation == self.eventsGeneration else { return }
            self.eventsTask = nil
        }
        eventsTask = task
        eventsControl = task
    }

    func stopRealtime() {
        eventsGeneration &+= 1
        eventsTask?.cancel()
        eventsTask = nil
        refreshDebounceTask?.cancel()
        refreshDebounceTask = nil
        let client = eventsClient
        let previous = eventsControl
        eventsControl = Task {
            await previous?.value
            await client.stop()
        }
    }
}
