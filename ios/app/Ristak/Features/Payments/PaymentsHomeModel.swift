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
    /// Cambia cuando llega `subscription_changed` (las vistas de suscripciones
    /// lo observan para refrescarse).
    private(set) var subscriptionsRefreshTick = 0

    // MARK: Dependencias

    private let timeZoneProvider: () -> TimeZone

    init(timeZoneProvider: @escaping () -> TimeZone) {
        self.timeZoneProvider = timeZoneProvider
    }

    // MARK: - Carga inicial

    func loadIfNeeded() async {
        if capabilities == nil {
            await refreshCapabilities()
        }
        if recentPayments.isEmpty, recentError == nil, !isLoadingRecent {
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
        integrations = integrationsResult
        capabilities = PaymentCapabilities.resolve(integrations: integrationsResult, license: license)
    }

    var isHighLevelConnected: Bool {
        integrations?.isHighLevelConnected == true
    }

    // MARK: - Últimos pagos (doc 08 §6.1: paid|partial, monto > 0, desc)

    private static let pageSize = 50

    func loadRecentPayments(reset: Bool) async {
        loadGeneration += 1
        let generation = loadGeneration

        if reset {
            currentPage = 1
            isLoadingRecent = true
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

        let range = PaymentsDateMath.range(for: period, timeZone: timeZoneProvider())
        let page = reset ? 1 : currentPage + 1

        do {
            let result = try await PaymentsService.transactions(
                page: page,
                limit: Self.pageSize,
                startDate: range.start,
                endDate: range.end,
                sortBy: "date",
                sortOrder: "DESC"
            )
            guard generation == loadGeneration else { return }

            let received = result.transactions.filter { transaction in
                transaction.amount > 0 && (transaction.transactionStatus?.countsAsReceived == true)
            }

            if reset {
                recentPayments = received
            } else {
                var merged = recentPayments
                let known = Set(merged.map(\.id))
                merged.append(contentsOf: received.filter { !known.contains($0.id) })
                recentPayments = merged
            }
            recentPayments.sort { lhs, rhs in
                (lhs.sortDate ?? .distantPast) > (rhs.sortDate ?? .distantPast)
            }

            currentPage = page
            hasMorePages = result.pagination?.hasNext ?? false
            accessDenied = false
            recentError = nil
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
        Task { await loadRecentPayments(reset: true) }
    }

    // MARK: - SSE (doc 11 §4): eventos → refresh REST coalescido

    func startRealtime() {
        guard eventsTask == nil else { return }
        eventsTask = Task { [weak self] in
            guard let self else { return }
            let stream = await self.eventsClient.start()
            for await event in stream {
                guard !Task.isCancelled else { break }
                switch event {
                case .connected:
                    break
                case .paymentChanged:
                    self.refreshRecentSilently()
                case .subscriptionChanged:
                    self.subscriptionsRefreshTick &+= 1
                }
            }
        }
    }

    func stopRealtime() {
        eventsTask?.cancel()
        eventsTask = nil
        Task { await eventsClient.stop() }
    }
}
