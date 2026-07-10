import Foundation
import Observation

// MARK: - Estado por panel

/// Estado de un panel independiente de Analíticas (KPIs, gráfica, embudo,
/// origen). Cada panel carga, falla y reintenta por separado (doc 09 §7.7).
struct AnalyticsPanelState<Value: Sendable & Equatable>: Equatable, Sendable {
    var value: Value?
    var isLoading = false
    var errorMessage: String?
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

    /// 403 de módulo `dashboard` → pantalla completa «No tienes acceso…».
    private(set) var accessDenied = false

    private var configStore: AppConfigStore?
    /// La primera carga completa TERMINÓ sin ser cancelada. Si el `.task` de la
    /// vista se cancela (cambio de tab) antes de terminar, esto queda en `false`
    /// para que al volver al tab se reintente en vez de dejar KPIs en `$0.00`.
    private var loadCompleted = false
    /// La UI nunca presenta una carga parcial/fallida como si todo estuviera
    /// fresco. Se conserva la cache, pero se avisa cuando la revalidacion no
    /// pudo completar los cuatro paneles.
    private(set) var lastSuccessfulRefreshAt: Date?
    private(set) var lastRefreshFailed = false

    // MARK: - Arranque / cambios de zona horaria

    /// Punto de entrada del `.task(id: businessTimeZone)` de la vista raíz.
    /// Recalcula el rango con la zona vigente; primera vez (o rango cambiado)
    /// dispara la carga completa.
    func start(config: AppConfigStore) async {
        configStore = config
        let newRange = resolveRange()
        let rangeChanged = newRange != range
        range = newRange

        // Recarga si aún no hay una carga completada con éxito o si el rango
        // cambió. Nota: si una carga previa se canceló (tab switch), los paneles
        // quedaron EN «cargando» (nunca en 0 falso) y `loadCompleted` sigue en
        // `false`, así que al reaparecer la vista se recarga solo.
        guard !loadCompleted || rangeChanged else { return }
        // SWR (#4): pinta al INSTANTE lo cacheado para esta combinación (KPIs,
        // gráfica, embudo, origen) y solo después revalida en segundo plano.
        hydrateAllFromCache()
        let succeeded = await reloadAll()
        // Solo consolidamos la carga si el task no fue cancelado a mitad
        // (al reaparecer, `.task(id:)` vuelve a llamar `start` y recargará).
        if !Task.isCancelled {
            loadCompleted = succeeded
        }
    }

    // MARK: - Periodo

    func selectPeriod(_ newPeriod: AnalyticsPeriod) {
        guard newPeriod != .custom else { return }
        guard newPeriod != period else { return }
        period = newPeriod
        customRange = nil
        range = resolveRange()
        // Repinta al instante lo cacheado para el nuevo rango (o «…» si no hay).
        hydrateAllFromCache()
        Task { _ = await reloadAll() }
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
        // Repinta al instante lo cacheado para el rango personalizado.
        hydrateAllFromCache()
        Task { _ = await reloadAll() }
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
        return AnalyticsService.dateRange(for: period, timeZone: businessTimeZone)
    }

    // MARK: - Selecciones que recargan un solo panel (doc 09 §7.7)

    func selectChartKind(_ kind: AnalyticsChartKind) {
        guard kind != chartKind else { return }
        chartKind = kind
        guard let range else { return }
        // Pinta al instante la vista cacheada para esta combinación.
        hydrateChart(range)
        Task { _ = await loadChart(range) }
    }

    func selectFinancialScope(_ scope: DashboardScope) {
        guard scope != financialScope else { return }
        financialScope = scope
        guard let range, chartKind == .revenueSpend else { return }
        hydrateChart(range)
        Task { _ = await loadChart(range) }
    }

    func selectFunnelScope(_ scope: DashboardScope) {
        guard scope != funnelScope else { return }
        funnelScope = scope
        guard let range else { return }
        hydrateFunnel(range)
        Task { _ = await loadFunnel(range) }
    }

    // MARK: - Cargas

    /// Recarga TODOS los paneles en paralelo (cambio de rango, retry global
    /// del estado sin-acceso y pull-to-refresh).
    @discardableResult
    func reloadAll() async -> Bool {
        guard let range else { return false }
        accessDenied = false
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
        lastRefreshFailed = !succeeded
        if succeeded { lastSuccessfulRefreshAt = Date() }
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

    // MARK: - Caché SWR: hidratación instantánea (doc Round 6 #4)

    /// Pinta SÍNCRONAMENTE lo último cacheado para la combinación vigente
    /// (rango × scope × vista) en los 4 paneles + etiquetas + números de
    /// WhatsApp. Si un panel no tiene caché para su combinación, queda en
    /// «cargando» (spinner/«…»); nunca en `$0.00` ni vacío falso. Debe llamarse
    /// ANTES de disparar la revalidación de red.
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
        let cached = AnalyticsCache.readMetrics(range)
        metrics.value = cached
        metrics.isLoading = (cached == nil)
        metrics.errorMessage = nil
    }

    private func hydrateChart(_ range: AnalyticsDateRange) {
        let cached = AnalyticsCache.readChart(range, chartKind, financialScope)
        chart.value = cached
        chart.isLoading = (cached == nil)
        chart.errorMessage = nil
    }

    private func hydrateFunnel(_ range: AnalyticsDateRange) {
        let cached = AnalyticsCache.readFunnel(range, funnelScope)
        funnel.value = cached
        funnel.isLoading = (cached == nil)
        funnel.errorMessage = nil
    }

    private func hydrateOrigin(_ range: AnalyticsDateRange) {
        let cached = AnalyticsCache.readOrigin(range)
        origin.value = cached
        origin.isLoading = (cached == nil)
        origin.errorMessage = nil
    }

    private func loadLabelsIfNeeded() async {
        guard !labelsLoaded else { return }
        // Fallos silenciosos: se quedan los defaults (Interesados/Clientes).
        guard let fetched = try? await AnalyticsService.customLabels() else { return }
        labels = fetched
        labelsLoaded = true
        AnalyticsCache.storeLabels(fetched)
    }

    private func loadMetrics(_ range: AnalyticsDateRange) async -> Bool {
        // Spinner («…») SOLO si no hay valor cacheado; si lo hay, revalida en
        // silencio (nada de vacío → spinner → dato).
        if metrics.value == nil { metrics.isLoading = true }
        metrics.errorMessage = nil
        do {
            let snapshot = try await AnalyticsService.metrics(
                startDate: range.startDate,
                endDate: range.endDate
            )
            guard self.range == range else { return false }
            metrics.value = snapshot
            metrics.isLoading = false
            AnalyticsCache.storeMetrics(snapshot, range)
            return true
        } catch {
            guard self.range == range else { return false }
            metrics = applyFailure(classify(error), to: metrics, empty: nil)
            return false
        }
    }

    private func loadChart(_ range: AnalyticsDateRange) async -> Bool {
        let kind = chartKind
        let scope = financialScope
        if chart.value == nil { chart.isLoading = true }
        chart.errorMessage = nil
        do {
            let points: [AnalyticsChartPoint]
            if let pair = kind.seriesPair {
                async let first = AnalyticsService.series(
                    pair.0,
                    startDate: range.startDate,
                    endDate: range.endDate,
                    groupBy: range.groupBy
                )
                async let second = AnalyticsService.series(
                    pair.1,
                    startDate: range.startDate,
                    endDate: range.endDate,
                    groupBy: range.groupBy
                )
                let (a, b) = try await (first, second)
                points = Self.combineSeries(a, b)
            } else {
                let raw = try await AnalyticsService.financialOverview(
                    startDate: range.startDate,
                    endDate: range.endDate,
                    scope: scope
                )
                points = raw.map {
                    AnalyticsChartPoint(label: $0.label, value1: $0.value, value2: $0.value2)
                }
            }
            guard isCurrentChartRequest(range, kind, scope) else { return false }
            chart.value = points
            chart.isLoading = false
            AnalyticsCache.storeChart(points, range, kind, scope)
            return true
        } catch {
            guard isCurrentChartRequest(range, kind, scope) else { return false }
            chart = applyFailure(classify(error), to: chart, empty: [])
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
        let scope = funnelScope
        if funnel.value == nil { funnel.isLoading = true }
        funnel.errorMessage = nil
        do {
            let rows = try await AnalyticsService.funnel(
                startDate: range.startDate,
                endDate: range.endDate,
                scope: scope
            )
            guard self.range == range, funnelScope == scope else { return false }
            funnel.value = rows
            funnel.isLoading = false
            AnalyticsCache.storeFunnel(rows, range, scope)
            return true
        } catch {
            guard self.range == range, funnelScope == scope else { return false }
            funnel = applyFailure(classify(error), to: funnel, empty: [])
            return false
        }
    }

    private func loadOrigin(_ range: AnalyticsDateRange) async -> Bool {
        if origin.value == nil { origin.isLoading = true }
        origin.errorMessage = nil
        do {
            let snapshot = try await AnalyticsService.originDistribution(
                startDate: range.startDate,
                endDate: range.endDate
            )
            guard self.range == range else { return false }
            origin.value = snapshot
            origin.isLoading = false
            AnalyticsCache.storeOrigin(snapshot, range)
            return true
        } catch {
            guard self.range == range else { return false }
            origin = applyFailure(classify(error), to: origin, empty: nil)
            return false
        }
    }

    /// El panel Origen no depende de WhatsApp. Esta carga secundaria publica
    /// por separado y solo pisa cache cuando el endpoint respondio de verdad.
    private func loadWhatsAppPhones(_ range: AnalyticsDateRange) async {
        do {
            let status = try await WhatsAppNumbersService.status()
            guard self.range == range else { return }
            whatsappPhones = status.phoneNumbers
            AnalyticsCache.storePhones(status.phoneNumbers)
        } catch {
            // Conservar telefonos cacheados ante un fallo temporal.
        }
    }

    // MARK: - Clasificación de errores

    private enum LoadFailure {
        case message(String)
        case silentEmpty
        /// Task cancelado (cambio de tab): se CONSERVA el estado de carga para
        /// no pintar `$0.00` como si fuera real; la vista recarga al reaparecer.
        case cancelled
        case ignored
    }

    /// Aplica un fallo a un panel preservando el patrón SWR: si el panel YA
    /// tiene datos (cacheados o de una carga previa), un error de red NO los
    /// borra ni muestra la vista de error de pantalla completa del panel —
    /// simplemente se conserva lo visible. El error inline solo aparece cuando
    /// el panel está vacío (primera carga sin caché).
    private func applyFailure<Value>(
        _ failure: LoadFailure,
        to state: AnalyticsPanelState<Value>,
        empty: Value?
    ) -> AnalyticsPanelState<Value> {
        var next = state
        switch failure {
        case .message(let message):
            next.isLoading = false
            if next.value == nil { next.errorMessage = message }
        case .silentEmpty:
            // 403 feature-not-available: respuesta autoritativa → vaciar.
            next.isLoading = false
            next.value = empty
        case .cancelled:
            // Cambio de tab: conserva el estado tal cual (si venía de caché el
            // valor sigue visible; si no, `isLoading` sigue → recarga al volver).
            break
        case .ignored:
            next.isLoading = false
        }
        return next
    }

    private func classify(_ error: Error) -> LoadFailure {
        if error is CancellationError { return .cancelled }
        guard let api = error as? RistakAPIError else {
            return .message("No se pudo cargar la información.")
        }
        if api.kind == .network,
           let urlError = api.underlying as? URLError,
           urlError.code == .cancelled {
            return .cancelled
        }
        switch api.kind {
        case .accessDenied:
            accessDenied = true
            return .ignored
        case .featureUnavailable:
            // Silencioso en cargas (GET): panel vacío, sin alerta.
            return .silentEmpty
        default:
            return .message(api.message)
        }
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
        if let rows = funnel.value, !rows.isEmpty { return rows }
        return [
            DashboardFunnelRow(stage: "Visitantes", value: 0),
            DashboardFunnelRow(stage: labels.leads, value: 0),
            DashboardFunnelRow(stage: "Citas", value: 0),
            DashboardFunnelRow(stage: "Asistencias", value: 0),
            DashboardFunnelRow(stage: labels.customers, value: 0),
        ]
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
        !origin.isLoading && origin.errorMessage == nil && whatsappRows.count >= 2
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
