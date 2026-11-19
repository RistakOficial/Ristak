import Foundation
import Observation

// MARK: - Estado por panel

/// Estado de un panel independiente de Analíticas (KPIs, gráfica, embudo,
/// origen). Cada panel carga, falla y reintenta por separado (doc 09 §7.7).
struct AnalyticsPanelState<Value: Sendable & Equatable>: Equatable, Sendable {
    var query: AnalyticsCacheQuery?
    var previousRange: AnalyticsDateRange?
    var value: Value?
    var isLoading = true
    var errorMessage: String?
}

extension AnalyticsPanelState where Value: Decodable {
    @MainActor
    mutating func revealSnapshotIfWaiting() {
        guard value == nil, isLoading, let saved = query?.snapshot(Value.self) else { return }
        value = saved.value
        previousRange = saved.previousRange
        isLoading = false
    }
}

// MARK: - Vistas de la gráfica principal (doc 09 §7.3)

/// Las 5 vistas seleccionables por chips de la gráfica de doble línea.
enum AnalyticsChartKind: String, CaseIterable, Identifiable, Sendable {
    case revenueSpend
    case visitorsLeads
    case leadsAppointments
    case appointmentsAttendances
    case attendancesSales

    var id: String { rawValue }

    /// ¿Formatea con moneda (escala superior)?
    var isCurrency: Bool { self == .revenueSpend }

    /// El segmented de scope financiero solo aplica a "Ingresos vs gastos".
    var showsScope: Bool { self == .revenueSpend }

    /// Título del chip y H2 del panel (labels 2 y 3 usan custom labels).
    func title(labels: DashboardCustomLabels) -> String {
        switch self {
        case .revenueSpend: return "Ingresos vs gastos"
        case .visitorsLeads: return "Visitantes vs \(labels.leads)"
        case .leadsAppointments: return "\(labels.leads) vs citas"
        case .appointmentsAttendances: return "Citas vs asistencias"
        case .attendancesSales: return "Asistencias vs ventas"
        }
    }

    /// Etiquetas de la leyenda (serie 1, serie 2).
    func legendLabels(labels: DashboardCustomLabels) -> (String, String) {
        switch self {
        case .revenueSpend: return ("Ingresos", "Gastos")
        case .visitorsLeads: return ("Visitantes", labels.leads)
        case .leadsAppointments: return (labels.leads, "Citas")
        case .appointmentsAttendances: return ("Citas", "Asistencias")
        case .attendancesSales: return ("Asistencias", "Ventas")
        }
    }

    /// Par de series del dashboard (nil para revenue-spend, que usa
    /// `/financial-overview`).
    var seriesPair: (DashboardSeriesKind, DashboardSeriesKind)? {
        switch self {
        case .revenueSpend: return nil
        case .visitorsLeads: return (.visitors, .leads)
        case .leadsAppointments: return (.leads, .appointments)
        case .appointmentsAttendances: return (.appointments, .attendances)
        case .attendancesSales: return (.attendances, .sales)
        }
    }
}

/// Punto combinado de la gráfica de doble línea.
///
/// Codable de la feature: la caché SWR guarda/lee `[AnalyticsChartPoint]` con
/// round-trip nativo (el `id` es derivado y no se serializa).
struct AnalyticsChartPoint: Codable, Sendable, Equatable, Identifiable {
    let label: String
    let value1: Double
    let value2: Double

    var id: String { label }
}

// MARK: - Tabs de Origen (doc 09 §7.5)

enum AnalyticsOriginTab: String, CaseIterable, Identifiable, Sendable {
    case traffic
    case leads
    case appointments
    case conversions

    var id: String { rawValue }

    func title(labels: DashboardCustomLabels) -> String {
        switch self {
        case .traffic: return "Tráfico"
        case .leads: return labels.leads
        case .appointments: return "Citas"
        case .conversions: return labels.customers
        }
    }
}

// MARK: - Filas de "Origen por número" (doc 09 §7.6)

struct AnalyticsWhatsAppRow: Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    /// Número mostrado bajo el nombre (nil si no se conoce).
    let number: String?
    let value: Double
    /// `API y web` / `Web activo` / `API activa` / `Detectado`.
    let statusLabel: String
}

/// Consultas independientes de la pantalla. Cada una puede terminar, fallar o
/// reintentarse aunque las demás sigan esperando al servidor.
struct AnalyticsQueries {
    var metrics = AnalyticsService.metrics
    var financialOverview = AnalyticsService.financialOverview
    var series = AnalyticsService.series
    var funnel = AnalyticsService.funnel
    var originDistribution = AnalyticsService.originDistribution
    var originPhoneBreakdown = AnalyticsService.originPhoneBreakdown
    var customLabels = AnalyticsService.customLabels
    var phones = WhatsAppNumbersService.status
}

// MARK: - ViewModel

/// Orquestación de la pantalla Analíticas (doc research/09):
/// - Rango calculado en la zona horaria del NEGOCIO (`AnalyticsService`).
/// - Cargas por panel independientes y concurrentes, con guardas anti-stale.
/// - 403 `read_access_required` del módulo `dashboard` → estado «sin acceso»
///   de pantalla completa (trampa doc 09/13).
/// - 403 `feature_not_available` silencioso en cargas (paneles vacíos).
@MainActor
@Observable
final class AnalyticsViewModel {
    // MARK: Periodo y rango

    private(set) var period: AnalyticsPeriod = .d30
    private(set) var customRange: AnalyticsDateRange?
    private(set) var range: AnalyticsDateRange?

    // MARK: Labels personalizables

    private(set) var labels = DashboardCustomLabels.defaults
    private var labelsLoaded = false

    // MARK: Paneles

    var metrics = AnalyticsPanelState<DashboardMetricsSnapshot>()
    var chart = AnalyticsPanelState<[AnalyticsChartPoint]>()
    var funnel = AnalyticsPanelState<[DashboardFunnelRow]>()
    var origin = AnalyticsPanelState<OriginDistributionSnapshot>()
    private(set) var whatsappPhones: [WhatsAppPhoneNumber] = []

    // MARK: Selecciones locales

    private(set) var chartKind: AnalyticsChartKind = .revenueSpend
    private(set) var financialScope: DashboardScope = .all
    private(set) var funnelScope: DashboardScope = .all
    var originTab: AnalyticsOriginTab = .traffic
    private var phoneOriginRequested = false
    private var phoneOriginCompletedRangeKey: String?
    private var phoneOriginInFlightRangeKey: String?
    private var phoneOriginTask: Task<Void, Never>?
    private var phoneOriginGeneration = 0
    private var primaryReloadGeneration = 0
    private var primaryReloadInProgress = false

    /// 403 de módulo `dashboard` → pantalla completa «No tienes acceso…».
    private(set) var accessDenied = false

    private var configStore: AppConfigStore?
    private let queries: AnalyticsQueries
    private let recovery: AnalyticsRecovery
    private var cache: AnalyticsCache?
    private var rangeSelectionTask: Task<Void, Never>?
    private var chartSelectionTask: Task<Void, Never>?
    private var funnelSelectionTask: Task<Void, Never>?
    private let now: () -> Date
    private let snapshotGrace: Duration
    private var snapshotTasks: [AnalyticsRecovery.Panel: Task<Void, Never>] = [:]
    private var offline = false
    private var deniedGeneration: Int?
    private(set) var includeWeb = false

    init(
        queries: AnalyticsQueries = AnalyticsQueries(),
        recovery: AnalyticsRecovery? = nil,
        snapshotGrace: Duration = .milliseconds(350),
        now: @escaping () -> Date = Date.init
    ) {
        self.now = now
        self.queries = queries
        self.snapshotGrace = snapshotGrace
        self.recovery = recovery ?? AnalyticsRecovery()
    }

    private var sessionToken: RistakSnapshotCache.NamespaceToken?

    func start(config: AppConfigStore, includeWeb: Bool) async {
        guard !Task.isCancelled else { return }
        cancelSelectionLoads()
        recovery.stop()
        let token = RistakSnapshotCache.shared.namespaceToken()
        if token != sessionToken {
            metrics = .init()
            chart = .init()
            funnel = .init()
            origin = .init()
            labelsLoaded = false
            labels = .defaults
            whatsappPhones = []
        }
        sessionToken = token
        configStore = config
        self.includeWeb = includeWeb
        if !includeWeb {
            if chartKind == .visitorsLeads { chartKind = .revenueSpend }
            if originTab == .traffic { originTab = .leads }
        }
        cache = AnalyticsCache(config: config, includeWeb: includeWeb)
        accessDenied = AnalyticsCache.accessDenied
        if cache == nil {
            range = nil
            metrics = .init()
            chart = .init()
            funnel = .init()
            origin = .init()
            // El shell ya carga configuración al abrir sesión. Si esa consulta
            // falló, esta pantalla la recupera mientras permanezca visible.
            guard config.isLoaded else { return }
            var delay = 2
            while cache == nil {
                await config.load()
                guard !Task.isCancelled, isActiveSession else { return }
                cache = AnalyticsCache(config: config, includeWeb: includeWeb)
                if cache == nil {
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    delay = min(delay * 2, 60)
                }
            }
        }
        range = resolveRange()
        hydrateAllFromCache()
        await reloadAll()
    }

    private func cancelSelectionLoads() {
        rangeSelectionTask?.cancel()
        chartSelectionTask?.cancel()
        funnelSelectionTask?.cancel()
        rangeSelectionTask = nil
        chartSelectionTask = nil
        funnelSelectionTask = nil
    }

    func stop() {
        cancelSelectionLoads()
        configStore = nil
        primaryReloadGeneration += 1
        primaryReloadInProgress = false
        recovery.stop()
        for task in snapshotTasks.values { task.cancel() }
        snapshotTasks.removeAll()
        offline = false
        cancelOriginPhoneBreakdown(clearCompleted: false)
    }

    func setNetworkAvailable(_ available: Bool) {
        offline = !available
        guard offline, isActiveSession else { return }
        metrics.revealSnapshotIfWaiting()
        chart.revealSnapshotIfWaiting()
        funnel.revealSnapshotIfWaiting()
        origin.revealSnapshotIfWaiting()
    }

    private var isActiveSession: Bool {
        configStore != nil && sessionToken == RistakSnapshotCache.shared.namespaceToken()
    }

    var chartKinds: [AnalyticsChartKind] {
        AnalyticsChartKind.allCases.filter { includeWeb || $0 != .visitorsLeads }
    }

    var originTabs: [AnalyticsOriginTab] {
        AnalyticsOriginTab.allCases.filter { includeWeb || $0 != .traffic }
    }

    private func isCurrent(_ request: AnalyticsRecovery.Request) -> Bool {
        isActiveSession && recovery.isCurrent(request)
    }

    // MARK: - Periodo

    func selectPeriod(_ newPeriod: AnalyticsPeriod) {
        guard newPeriod != .custom else { return }
        guard newPeriod != period else { return }
        period = newPeriod
        customRange = nil
        range = resolveRange()
        cancelSelectionLoads()
        hydrateAllFromCache()
        rangeSelectionTask = Task { _ = await reloadAll() }
    }

    /// Aplica un rango personalizado (fechas elegidas con date pickers).
    /// Devuelve el mensaje de error de validación, o nil si aplicó.
    func applyCustomRange(start: Date, end: Date) -> String? {
        let timeZone = businessTimeZone
        let startString = RistakDateParsing.businessDateString(from: start, timeZone: timeZone)
        let endString = RistakDateParsing.businessDateString(from: end, timeZone: timeZone)
        guard let newRange = AnalyticsService.customDateRange(startDate: startString, endDate: endString) else {
            return "La fecha inicial no puede ser mayor que la final."
        }
        period = .custom
        customRange = newRange
        range = newRange
        cancelSelectionLoads()
        hydrateAllFromCache()
        rangeSelectionTask = Task { _ = await reloadAll() }
        return nil
    }

    /// Etiqueta corta del rango personalizado (`07-jul - 06-ago`) para el
    /// subtítulo y el menú (paridad Expo `formatDateOnlyRangeLabel`).
    var customRangeLabel: String? {
        guard period == .custom, let customRange else { return nil }
        return "\(Self.shortDayLabel(customRange.startDate)) - \(Self.shortDayLabel(customRange.endDate))"
    }

    /// Label de una opción del menú de periodo; `custom` incluye el rango
    /// elegido si ya existe.
    func menuLabel(for option: AnalyticsPeriod) -> String {
        if option == .custom, let customRangeLabel {
            return "\(option.menuLabel) - \(customRangeLabel)"
        }
        return option.menuLabel
    }

    var businessTimeZone: TimeZone {
        configStore?.businessTimeZone
            ?? TimeZone(identifier: AppConfigStore.defaultTimeZoneIdentifier)!
    }

    private func resolveRange() -> AnalyticsDateRange? {
        if period == .custom { return customRange }
        return AnalyticsService.dateRange(for: period, timeZone: businessTimeZone, now: now())
    }

    // MARK: - Selecciones que recargan un solo panel (doc 09 §7.7)

    func selectChartKind(_ kind: AnalyticsChartKind) {
        guard chartKinds.contains(kind), kind != chartKind else { return }
        chartKind = kind
        guard let range else { return }
        chartSelectionTask?.cancel()
        hydrateChart(range)
        chartSelectionTask = Task { _ = await loadChart(range) }
    }

    func selectFinancialScope(_ scope: DashboardScope) {
        guard scope != financialScope else { return }
        financialScope = scope
        guard let range, chartKind == .revenueSpend else { return }
        chartSelectionTask?.cancel()
        hydrateChart(range)
        chartSelectionTask = Task { _ = await loadChart(range) }
    }

    func selectFunnelScope(_ scope: DashboardScope) {
        guard scope != funnelScope else { return }
        funnelScope = scope
        guard let range else { return }
        funnelSelectionTask?.cancel()
        hydrateFunnel(range)
        funnelSelectionTask = Task { _ = await loadFunnel(range) }
    }

    /// El panel ya existente dispara esta carga cuando entra en pantalla. No
    /// depende de cuántos teléfonos estén conectados hoy: el historial puede
    /// contener números anteriores que también deben aparecer.
    func requestOriginPhoneBreakdown() {
        phoneOriginRequested = true
        scheduleOriginPhoneBreakdownIfNeeded()
    }

    func stopOriginPhoneBreakdown() {
        phoneOriginRequested = false
        cancelOriginPhoneBreakdown(clearCompleted: false)
    }

    // MARK: - Cargas

    /// Recarga TODOS los paneles en paralelo (cambio de rango, retry global
    /// del estado sin-acceso y pull-to-refresh).
    @discardableResult
    func reloadAll() async -> Bool {
        guard let range else { return false }
        guard cache != nil, isActiveSession, !Task.isCancelled else { return false }
        // Toda recarga primaria invalida también el enriquecimiento ya terminado,
        // incluso si Origen salió del viewport. Al reaparecer, el panel debe leer
        // nuevamente el breakdown del mismo rango en vez de quedarse con cache vieja.
        cancelOriginPhoneBreakdown(clearCompleted: true)
        primaryReloadGeneration += 1
        let reloadGeneration = primaryReloadGeneration
        primaryReloadInProgress = true
        let performanceSpan = RistakObservability.begin(.analyticsLoad)
        async let labelsLoad: Void = loadLabelsIfNeeded()
        async let metricsLoad: Bool = loadMetrics(range)
        async let chartLoad: Bool = loadChart(range)
        async let funnelLoad: Bool = loadFunnel(range)
        async let originLoad: Bool = loadOrigin(range)
        async let phonesLoad: Void = loadWhatsAppPhones(range)
        let (_, metricsOK, chartOK, funnelOK, originOK, _) = await (
            labelsLoad,
            metricsLoad,
            chartLoad,
            funnelLoad,
            originLoad,
            phonesLoad
        )
        let succeeded = metricsOK && chartOK && funnelOK && originOK
        if primaryReloadGeneration == reloadGeneration && isActiveSession && !Task.isCancelled {
            primaryReloadInProgress = false
            scheduleOriginPhoneBreakdownIfNeeded()
        }
        performanceSpan.finish(
            outcome: accessDenied ? .unavailable : (succeeded ? .success : .failed),
            itemCount: 4
        )
        return succeeded
    }

    func retryMetrics() async {
        guard let range else { return }
        _ = await loadMetrics(range)
    }

    func retryChart() async {
        guard let range else { return }
        _ = await loadChart(range)
    }

    func retryFunnel() async {
        guard let range else { return }
        _ = await loadFunnel(range)
    }

    func retryOrigin() async {
        guard let range else { return }
        _ = await loadOrigin(range)
    }

    // MARK: - Respaldo por contexto

    /// Etiquetas y teléfonos ya conocidos están disponibles al entrar. Para
    /// las cifras, la red tiene una ventana breve antes de recurrir al snapshot.
    private func hydrateAllFromCache() {
        guard let range else { return }
        // Etiquetas: títulos correctos al instante (sigue revalidando en red).
        if !labelsLoaded, let cachedLabels = AnalyticsCache.readLabels() {
            labels = cachedLabels
        }
        // Números de WhatsApp: son de cuenta (no de rango); solo hidrata si aún
        // no tenemos ninguno en memoria (no pisa datos frescos de la sesión).
        if whatsappPhones.isEmpty, let cachedPhones = AnalyticsCache.readPhones() {
            whatsappPhones = cachedPhones
        }
        hydrateMetrics(range)
        hydrateChart(range)
        hydrateFunnel(range)
        hydrateOrigin(range)
    }

    private func hydrateMetrics(_ range: AnalyticsDateRange) {
        preparePanel(.metrics, at: \.metrics, query: cache?.query(.metrics, range: range, period: period))
    }

    private func hydrateChart(_ range: AnalyticsDateRange) {
        preparePanel(.chart, at: \.chart, query: cache?.query(.chart(chartKind, financialScope), range: range, period: period))
    }

    private func hydrateFunnel(_ range: AnalyticsDateRange) {
        preparePanel(.funnel, at: \.funnel, query: cache?.query(.funnel(funnelScope), range: range, period: period))
    }

    private func hydrateOrigin(_ range: AnalyticsDateRange) {
        prepareOriginPhoneState(for: range)
        preparePanel(.origin, at: \.origin, query: cache?.query(.origin, range: range, period: period))
    }

    private func preparePanel<Value: Decodable>(
        _ panel: AnalyticsRecovery.Panel,
        at path: ReferenceWritableKeyPath<AnalyticsViewModel, AnalyticsPanelState<Value>>,
        query: AnalyticsCacheQuery?
    ) {
        recovery.invalidate(panel)
        snapshotTasks.removeValue(forKey: panel)?.cancel()
        if self[keyPath: path].query == query, self[keyPath: path].value != nil { return }
        self[keyPath: path] = AnalyticsPanelState(query: query)
        guard let query else { return }
        if offline {
            self[keyPath: path].revealSnapshotIfWaiting()
            return
        }
        let delay = snapshotGrace
        snapshotTasks[panel] = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self, self.isActiveSession, self[keyPath: path].query == query else { return }
            self[keyPath: path].revealSnapshotIfWaiting()
            self.snapshotTasks[panel] = nil
        }
    }

    private func loadLabelsIfNeeded() async {
        guard !labelsLoaded, isActiveSession else { return }
        let request = recovery.begin(.labels)
        do {
            let fetched = try await queries.customLabels()
            guard isCurrent(request) else { return }
            labels = fetched
            labelsLoaded = true
            AnalyticsCache.storeLabels(fetched)
            recovery.finish(request)
        } catch {
            retryTemporary(error, request)
        }
    }

    private func loadMetrics(_ range: AnalyticsDateRange) async -> Bool {
        guard cache != nil, isActiveSession, self.range == range, !Task.isCancelled else { return false }
        let request = recovery.begin(.metrics)
        // Spinner («…») SOLO si no hay valor cacheado; si lo hay, revalida en
        // silencio (nada de vacío → spinner → dato).
        if metrics.value == nil { metrics.isLoading = true }
        metrics.errorMessage = nil
        do {
            let snapshot = try await queries.metrics(
                range.startDate,
                range.endDate
            )
            guard isCurrent(request), self.range == range else { return false }
            if accessDenied && deniedGeneration != primaryReloadGeneration {
                accessDenied = false
                AnalyticsCache.accessDenied = false
            }
            metrics.value = snapshot
            metrics.previousRange = nil
            metrics.isLoading = false
            cache?.storeMetrics(snapshot, range)
            recovery.finish(request)
            return true
        } catch {
            guard isCurrent(request), self.range == range else { return false }
            metrics = applyFailure(error, request: request, to: metrics, empty: nil)
            return false
        }
    }

    private func loadChart(_ range: AnalyticsDateRange) async -> Bool {
        guard cache != nil, isActiveSession, self.range == range, !Task.isCancelled else { return false }
        let request = recovery.begin(.chart)
        let kind = chartKind
        let scope = financialScope
        if chart.value == nil { chart.isLoading = true }
        chart.errorMessage = nil
        do {
            let points: [AnalyticsChartPoint]
            if let pair = kind.seriesPair {
                async let first = queries.series(
                    pair.0,
                    range.startDate,
                    range.endDate,
                    range.groupBy
                )
                async let second = queries.series(
                    pair.1,
                    range.startDate,
                    range.endDate,
                    range.groupBy
                )
                let (a, b) = try await (first, second)
                points = Self.combineSeries(a, b)
            } else {
                let raw = try await queries.financialOverview(
                    range.startDate,
                    range.endDate,
                    scope
                )
                points = raw.map {
                    AnalyticsChartPoint(label: $0.label, value1: $0.value, value2: $0.value2)
                }
            }
            guard isCurrent(request), isCurrentChartRequest(range, kind, scope) else { return false }
            chart.value = points
            chart.previousRange = nil
            chart.isLoading = false
            cache?.storeChart(points, range, kind, scope)
            recovery.finish(request)
            return true
        } catch {
            guard isCurrent(request), isCurrentChartRequest(range, kind, scope) else { return false }
            chart = applyFailure(error, request: request, to: chart, empty: [])
            return false
        }
    }

    private func isCurrentChartRequest(
        _ range: AnalyticsDateRange,
        _ kind: AnalyticsChartKind,
        _ scope: DashboardScope
    ) -> Bool {
        self.range == range && chartKind == kind && financialScope == scope
    }

    private func loadFunnel(_ range: AnalyticsDateRange) async -> Bool {
        guard cache != nil, isActiveSession, self.range == range, !Task.isCancelled else { return false }
        let request = recovery.begin(.funnel)
        let scope = funnelScope
        if funnel.value == nil { funnel.isLoading = true }
        funnel.errorMessage = nil
        do {
            let rows = try await queries.funnel(
                range.startDate,
                range.endDate,
                scope, includeWeb
            )
            guard isCurrent(request), self.range == range, funnelScope == scope else { return false }
            funnel.value = rows
            funnel.previousRange = nil
            funnel.isLoading = false
            cache?.storeFunnel(rows, range, scope)
            recovery.finish(request)
            return true
        } catch {
            guard isCurrent(request), self.range == range, funnelScope == scope else { return false }
            funnel = applyFailure(error, request: request, to: funnel, empty: [])
            return false
        }
    }

    private func loadOrigin(_ range: AnalyticsDateRange) async -> Bool {
        guard cache != nil, isActiveSession, self.range == range, !Task.isCancelled else { return false }
        let request = recovery.begin(.origin)
        if origin.value == nil { origin.isLoading = true }
        origin.errorMessage = nil
        do {
            let snapshot = try await queries.originDistribution(
                range.startDate,
                range.endDate, includeWeb
            )
            guard isCurrent(request), self.range == range else { return false }
            // La respuesta principal excluye teléfonos. Conservar sólo esas
            // filas del snapshot SWR evita que una revalidación tardía borre
            // el enriquecimiento ya publicado para este mismo rango.
            let savedNumbers = origin.previousRange == nil ? origin.value?.whatsappNumbers : nil
            let merged = OriginDistributionSnapshot(
                traffic: snapshot.traffic,
                leads: snapshot.leads,
                appointments: snapshot.appointments,
                conversions: snapshot.conversions,
                whatsappNumbers: savedNumbers ?? snapshot.whatsappNumbers
            )
            origin.value = merged
            origin.previousRange = nil
            origin.isLoading = false
            cache?.storeOrigin(merged, range)
            scheduleOriginPhoneBreakdownIfNeeded()
            recovery.finish(request)
            return true
        } catch {
            guard isCurrent(request), self.range == range else { return false }
            origin = applyFailure(error, request: request, to: origin, empty: nil)
            return false
        }
    }

    private func scheduleOriginPhoneBreakdownIfNeeded() {
        guard
            phoneOriginRequested,
            isActiveSession, !accessDenied, !primaryReloadInProgress,
            let range,
            origin.value != nil, origin.previousRange == nil
        else { return }

        let key = phoneOriginKey(for: range)
        guard phoneOriginCompletedRangeKey != key, phoneOriginInFlightRangeKey != key else { return }

        if phoneOriginInFlightRangeKey != nil {
            cancelOriginPhoneBreakdown(clearCompleted: false)
        }
        phoneOriginGeneration += 1
        let generation = phoneOriginGeneration
        phoneOriginInFlightRangeKey = key
        phoneOriginTask = Task { [weak self] in
            guard let self else { return }
            await self.loadOriginPhoneBreakdown(range: range, key: key, generation: generation)
        }
    }

    private func loadOriginPhoneBreakdown(
        range: AnalyticsDateRange,
        key: String,
        generation: Int
    ) async {
        let request = recovery.begin(.phoneBreakdown)
        do {
            let snapshot = try await queries.originPhoneBreakdown(
                range.startDate,
                range.endDate
            )
            try Task.checkCancellation()
            guard
                isCurrent(request), phoneOriginGeneration == generation,
                phoneOriginInFlightRangeKey == key,
                self.range == range,
                origin.previousRange == nil, let current = origin.value
            else { return }

            let merged = OriginDistributionSnapshot(
                traffic: current.traffic,
                leads: current.leads,
                appointments: current.appointments,
                conversions: current.conversions,
                whatsappNumbers: snapshot.whatsappNumbers
            )
            origin.value = merged
            phoneOriginCompletedRangeKey = key
            phoneOriginInFlightRangeKey = nil
            phoneOriginTask = nil
            cache?.storeOrigin(merged, range)
            recovery.finish(request)
        } catch {
            guard
                isCurrent(request), phoneOriginGeneration == generation,
                phoneOriginInFlightRangeKey == key
            else { return }
            phoneOriginInFlightRangeKey = nil
            phoneOriginTask = nil
            retryTemporary(error, request)
        }
    }

    private func cancelOriginPhoneBreakdown(clearCompleted: Bool) {
        recovery.invalidate(.phoneBreakdown)
        phoneOriginGeneration += 1
        phoneOriginTask?.cancel()
        phoneOriginTask = nil
        phoneOriginInFlightRangeKey = nil
        if clearCompleted { phoneOriginCompletedRangeKey = nil }
    }

    private func prepareOriginPhoneState(for range: AnalyticsDateRange) {
        let key = phoneOriginKey(for: range)
        if let inFlight = phoneOriginInFlightRangeKey, inFlight != key {
            cancelOriginPhoneBreakdown(clearCompleted: false)
        }
        if phoneOriginCompletedRangeKey != key {
            phoneOriginCompletedRangeKey = nil
        }
    }

    private func phoneOriginKey(for range: AnalyticsDateRange) -> String {
        "\(range.startDate):\(range.endDate)"
    }

    /// El panel Origen no depende de WhatsApp. Esta carga secundaria publica
    /// por separado y solo pisa cache cuando el endpoint respondio de verdad.
    private func loadWhatsAppPhones(_ range: AnalyticsDateRange) async {
        guard isActiveSession, self.range == range, !Task.isCancelled else { return }
        let request = recovery.begin(.phones)
        do {
            let status = try await queries.phones()
            guard isCurrent(request), self.range == range else { return }
            whatsappPhones = status.phoneNumbers
            AnalyticsCache.storePhones(status.phoneNumbers)
            recovery.finish(request)
        } catch {
            retryTemporary(error, request)
        }
    }

    // MARK: - Recuperación por panel

    @discardableResult
    private func retryTemporary(_ error: Error, _ request: AnalyticsRecovery.Request) -> Bool {
        guard isCurrent(request), Self.isTemporary(error) else { return false }
        if deniedGeneration != primaryReloadGeneration {
            recovery.retry(request) { [weak self] in
                guard let self, self.isCurrent(request), let range = self.range,
                      self.deniedGeneration != self.primaryReloadGeneration else { return }
                switch request.panel {
                case .metrics: await self.retryMetrics()
                case .chart: await self.retryChart()
                case .funnel: await self.retryFunnel()
                case .origin: await self.retryOrigin()
                case .phones: await self.loadWhatsAppPhones(range)
                case .labels: await self.loadLabelsIfNeeded()
                case .phoneBreakdown: self.scheduleOriginPhoneBreakdownIfNeeded()
                }
            }
        }
        return true
    }

    static func isTemporary(_ error: Error) -> Bool {
        guard let api = error as? RistakAPIError else { return false }
        switch api.kind {
        case .network: return (api.underlying as? URLError)?.code != .cancelled
        case .starting, .rateLimited: return true
        case .server: return api.status == 0 || api.status == 408 || api.status >= 500
        default: return false
        }
    }

    private func applyFailure<Value: Decodable>(
        _ error: Error,
        request: AnalyticsRecovery.Request,
        to state: AnalyticsPanelState<Value>,
        empty: Value?
    ) -> AnalyticsPanelState<Value> {
        var next = state
        if retryTemporary(error, request) {
            next.revealSnapshotIfWaiting()
            return next
        }
        if error is CancellationError { return next }
        let api = error as? RistakAPIError
        if (api?.underlying as? URLError)?.code == .cancelled { return next }
        next.isLoading = false
        let dashboardUnavailable = api?.kind == .featureUnavailable && api?.feature == "dashboard"
        if dashboardUnavailable || api?.isAccessDenied == true || api?.isUnauthorized == true
            || api?.kind == .adminRequired || api?.kind == .licenseBlocked {
            deniedGeneration = primaryReloadGeneration
            accessDenied = true
            AnalyticsCache.accessDenied = true
            next.value = nil
            next.previousRange = nil
        } else if api?.kind == .featureUnavailable {
            for key in state.query?.matchingKeys() ?? [] {
                RistakSnapshotCache.shared.remove(key)
            }
            next.value = empty
            next.previousRange = nil
        } else if next.value == nil {
            next.errorMessage = api?.message ?? "No se pudo cargar la información."
        }
        return next
    }

    // MARK: - Derivados: gráfica

    var chartPoints: [AnalyticsChartPoint] { chart.value ?? [] }

    /// Vacío = sin puntos o todas las Y en 0 (→ «Sin datos para este periodo.»).
    var chartIsEmpty: Bool {
        let points = chartPoints
        return points.isEmpty || points.allSatisfy { $0.value1 == 0 && $0.value2 == 0 }
    }

    /// Máximo de ambas series (mínimo 1) — escala Y y etiqueta superior.
    var chartMaxValue: Double {
        max(1, chartPoints.flatMap { [$0.value1, $0.value2] }.max() ?? 1)
    }

    /// Combina dos series por unión de labels ordenados asc, faltantes = 0
    /// (paridad `combineSeries`, PhoneAnalytics.tsx:126-136).
    static func combineSeries(
        _ first: [DashboardSeriesPoint],
        _ second: [DashboardSeriesPoint]
    ) -> [AnalyticsChartPoint] {
        let labels = Set(first.map(\.label)).union(second.map(\.label)).sorted()
        let firstMap = Dictionary(first.map { ($0.label, $0.value) }, uniquingKeysWith: { _, last in last })
        let secondMap = Dictionary(second.map { ($0.label, $0.value) }, uniquingKeysWith: { _, last in last })
        return labels.map {
            AnalyticsChartPoint(label: $0, value1: firstMap[$0] ?? 0, value2: secondMap[$0] ?? 0)
        }
    }

    /// Etiqueta del eje X: `7 jul` (label diario) o `jul` (label mensual).
    static func chartAxisLabel(_ raw: String) -> String {
        let parts = raw.split(separator: "-").compactMap { Int($0) }
        if parts.count >= 3, (1...12).contains(parts[1]) {
            return "\(parts[2]) \(BusinessFormatters.shortMonths[parts[1] - 1])"
        }
        if parts.count == 2, (1...12).contains(parts[1]) {
            return BusinessFormatters.shortMonths[parts[1] - 1]
        }
        return raw
    }

    /// `07-jul` a partir de `YYYY-MM-DD`.
    static func shortDayLabel(_ iso: String) -> String {
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]) else { return iso }
        return String(format: "%02d-%@", parts[2], BusinessFormatters.shortMonths[parts[1] - 1])
    }

    // MARK: - Derivados: embudo

    /// Filas a renderizar; si el backend devolvió vacío se muestran las 5
    /// etapas en 0 con los labels personalizados (doc 09 §7.4).
    var funnelDisplayRows: [DashboardFunnelRow] {
        if let rows = funnel.value, !rows.isEmpty {
            return rows.filter { includeWeb || $0.stage.lowercased() != "visitantes" }
        }
        return [
            DashboardFunnelRow(stage: "Visitantes", value: 0),
            DashboardFunnelRow(stage: labels.leads, value: 0),
            DashboardFunnelRow(stage: "Citas", value: 0),
            DashboardFunnelRow(stage: "Asistencias", value: 0),
            DashboardFunnelRow(stage: labels.customers, value: 0),
        ].filter { includeWeb || $0.stage != "Visitantes" }
    }

    /// Pill de conversión total: `(última / primera) * 100`, `0.0%` si la
    /// primera etapa es 0.
    var funnelConversionLabel: String {
        let rows = funnelDisplayRows
        guard let first = rows.first, let last = rows.last, first.value > 0 else { return "0.0%" }
        return String(format: "%.1f%%", last.value / first.value * 100)
    }

    // MARK: - Derivados: origen

    func originItems(for tab: AnalyticsOriginTab) -> [SourceBreakdownItem] {
        guard let data = origin.value else { return [] }
        switch tab {
        case .traffic: return data.traffic.sources
        case .leads: return data.leads
        case .appointments: return data.appointments
        case .conversions: return data.conversions
        }
    }

    /// Máximo 8 filas visibles (paridad `slice(0,8)`).
    var originDisplayItems: [SourceBreakdownItem] {
        Array(originItems(for: originTab).prefix(8))
    }

    var originTotal: Double {
        originItems(for: originTab).reduce(0) { $0 + $1.value }
    }

    // MARK: - Derivados: origen por número de WhatsApp

    var whatsappRows: [AnalyticsWhatsAppRow] {
        Self.buildWhatsAppRows(
            phones: whatsappPhones,
            origins: origin.value?.whatsappNumbers ?? []
        )
    }

    /// El panel solo se muestra con ≥ 2 filas (doc 09 §7.6) y con el panel de
    /// origen ya resuelto (comparten carga).
    var showsWhatsAppPanel: Bool {
        guard !origin.isLoading, origin.errorMessage == nil, let range, let snapshot = origin.value else { return false }
        let hasBreakdown = !snapshot.whatsappNumbers.isEmpty || phoneOriginCompletedRangeKey == phoneOriginKey(for: range)
        return hasBreakdown && whatsappRows.count >= 2
    }

    /// Cruce de `whatsapp-api/status.phoneNumbers` con
    /// `origin-distribution.whatsappNumbers` (paridad `buildPhoneNumberRows`,
    /// PhoneAnalytics.tsx:179-222): match por `phoneNumberId` o por dígitos;
    /// los números detectados solo por mensajes se agregan al final.
    static func buildWhatsAppRows(
        phones: [WhatsAppPhoneNumber],
        origins: [WhatsAppNumberOriginItem]
    ) -> [AnalyticsWhatsAppRow] {
        var usedOriginIndexes = Set<Int>()
        var rows: [AnalyticsWhatsAppRow] = []

        let eligible = phones.filter { phone in
            !phone.id.isEmpty
                || !digits(phone.phoneNumber).isEmpty
                || !digits(phone.displayPhoneNumber).isEmpty
                || !digits(phone.qrConnectedPhone).isEmpty
        }

        for phone in eligible {
            let phoneDigits = [phone.phoneNumber, phone.displayPhoneNumber, phone.qrConnectedPhone]
                .map(digits)
                .filter { !$0.isEmpty }

            var match: (index: Int, item: WhatsAppNumberOriginItem)?
            for (index, item) in origins.enumerated() where !usedOriginIndexes.contains(index) {
                let idMatch = !phone.id.isEmpty && item.phoneNumberId == phone.id
                let itemDigits = [item.phoneNumber, item.displayPhoneNumber]
                    .map(digits)
                    .filter { !$0.isEmpty }
                let digitsMatch = itemDigits.contains { phoneDigits.contains($0) }
                if idMatch || digitsMatch {
                    match = (index, item)
                    break
                }
            }
            if let match { usedOriginIndexes.insert(match.index) }
            let item = match?.item

            let name = firstNonEmpty([
                phone.label, phone.verifiedName, item?.name,
                phone.displayPhoneNumber, phone.phoneNumber,
            ]) ?? "Número sin nombre"
            let number = firstNonEmpty([
                phone.displayPhoneNumber, phone.phoneNumber, phone.qrConnectedPhone,
            ])
            let qrActive = phone.isQRConnected || phone.qrSendEnabled || (item?.qrSendEnabled ?? false)
            let apiActive = phone.apiSendEnabled || (item?.apiSendEnabled ?? false)

            rows.append(AnalyticsWhatsAppRow(
                id: "telefono-\(phone.id.isEmpty ? String(rows.count) : phone.id)",
                name: name,
                number: number,
                value: item?.value ?? 0,
                statusLabel: statusLabel(qr: qrActive, api: apiActive)
            ))
        }

        for (index, item) in origins.enumerated() where !usedOriginIndexes.contains(index) {
            rows.append(AnalyticsWhatsAppRow(
                id: "origen-\(firstNonEmpty([item.phoneNumberId, item.phoneNumber]) ?? String(index))",
                name: item.name.isEmpty ? "Número sin nombre" : item.name,
                number: firstNonEmpty([item.displayPhoneNumber, item.phoneNumber]),
                value: item.value,
                statusLabel: statusLabel(
                    qr: item.qrSendEnabled ?? false,
                    api: item.apiSendEnabled ?? false
                )
            ))
        }

        return rows
    }

    private static func statusLabel(qr: Bool, api: Bool) -> String {
        switch (qr, api) {
        case (true, true): return "API y web"
        case (true, false): return "Web activo"
        case (false, true): return "API activa"
        case (false, false): return "Detectado"
        }
    }

    private static func digits(_ value: String?) -> String {
        (value ?? "").filter(\.isNumber)
    }

    private static func firstNonEmpty(_ candidates: [String?]) -> String? {
        for candidate in candidates {
            if let candidate, !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return candidate
            }
        }
        return nil
    }
}
