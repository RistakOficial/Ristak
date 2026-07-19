import Foundation

/// Endpoints de Analíticas (doc research/09). TODAS las rutas `/api/dashboard/*`
/// exigen el módulo `dashboard` — un empleado con `analytics:read` pero
/// `dashboard:none` recibe 403 `read_access_required` (trampa doc 09/13):
/// detectar con `error.isAccessDenied` y mostrar estado «sin acceso».
enum AnalyticsService {
    // MARK: - Rangos (doc 09 §3.3)

    /// Rango para un periodo fijo: `end = hoy` en la zona del NEGOCIO,
    /// `start = end - (días - 1)` (rango inclusivo de N días).
    static func dateRange(
        for period: AnalyticsPeriod,
        timeZone: TimeZone,
        now: Date = Date()
    ) -> AnalyticsDateRange? {
        guard let days = period.days else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let start = calendar.date(byAdding: .day, value: -(days - 1), to: now) ?? now
        return AnalyticsDateRange(
            startDate: RistakDateParsing.businessDateString(from: start, timeZone: timeZone),
            endDate: RistakDateParsing.businessDateString(from: now, timeZone: timeZone),
            groupBy: period.defaultGroupBy
        )
    }

    /// Rango personalizado. Valida formato `YYYY-MM-DD` y `start <= end`
    /// (la UI muestra «Usa el formato YYYY-MM-DD.» / «La fecha inicial no
    /// puede ser mayor que la final.»). Regla: span > 120 días ⇒ `month`.
    static func customDateRange(startDate: String, endDate: String) -> AnalyticsDateRange? {
        guard isValidBusinessDateString(startDate), isValidBusinessDateString(endDate) else { return nil }
        guard
            let start = RistakDateParsing.date(fromISO: startDate),
            let end = RistakDateParsing.date(fromISO: endDate),
            start <= end
        else { return nil }
        let spanDays = Int(end.timeIntervalSince(start) / 86_400) + 1
        return AnalyticsDateRange(
            startDate: startDate,
            endDate: endDate,
            groupBy: spanDays > AnalyticsPeriod.customMonthlyThresholdDays ? .month : .day
        )
    }

    /// ¿String con formato exacto `YYYY-MM-DD`?
    static func isValidBusinessDateString(_ value: String) -> Bool {
        guard value.count == 10 else { return false }
        return value.wholeMatch(of: #/\d{4}-\d{2}-\d{2}/#) != nil
    }

    // MARK: - KPIs

    /// `GET /api/dashboard/metrics` — objeto PELADO con los 8 KPIs.
    /// 400 si faltan fechas.
    static func metrics(startDate: String, endDate: String) async throws -> DashboardMetricsSnapshot {
        try await APIClient.shared.get(
            "/api/dashboard/metrics",
            query: ["startDate": startDate, "endDate": endDate],
            timeout: APIClient.dashboardTimeout
        )
    }

    // MARK: - Gráfica

    /// `GET /api/dashboard/financial-overview` → `{success,data:[{label,value,value2}]}`.
    /// Siempre agrupa por día; `scope` = all|attribution|campaigns.
    static func financialOverview(
        startDate: String,
        endDate: String,
        scope: DashboardScope = .all
    ) async throws -> [DashboardFinancialPoint] {
        try await APIClient.shared.get(
            "/api/dashboard/financial-overview",
            query: [
                "startDate": startDate,
                "endDate": endDate,
                "scope": scope.rawValue,
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    /// Series `visitors|leads|appointments|attendances|sales` — arrays PELADOS
    /// `[{label,value}]`. Semántica de errores (doc 09 §2): error interno →
    /// 200 `[]`; faltan fechas → 400 con body `[]` (aquí lo degradamos a `[]`
    /// para no romper la gráfica, paridad /movil). Los 403 de módulo SÍ se
    /// propagan.
    static func series(
        _ kind: DashboardSeriesKind,
        startDate: String,
        endDate: String,
        groupBy: AnalyticsGroupBy
    ) async throws -> [DashboardSeriesPoint] {
        do {
            return try await APIClient.shared.get(
                kind.path,
                query: [
                    "startDate": startDate,
                    "endDate": endDate,
                    "groupBy": groupBy.rawValue,
                ],
                timeout: APIClient.dashboardTimeout
            )
        } catch let error as RistakAPIError where error.kind == .badRequest {
            return []
        }
    }

    // MARK: - Embudo

    /// `GET /api/dashboard/funnel` → 5 etapas (posiciones 2 y 5 con custom
    /// labels del backend).
    static func funnel(
        startDate: String,
        endDate: String,
        scope: DashboardScope = .all
    ) async throws -> [DashboardFunnelRow] {
        try await APIClient.shared.get(
            "/api/dashboard/funnel",
            query: [
                "startDate": startDate,
                "endDate": endDate,
                "scope": scope.rawValue,
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    // MARK: - Origen

    /// `GET /api/dashboard/origin-distribution` — listas top-10 sin `color`
    /// (pintar con el acento).
    static func originDistribution(startDate: String, endDate: String) async throws -> OriginDistributionSnapshot {
        try await APIClient.shared.get(
            "/api/dashboard/origin-distribution",
            query: [
                "startDate": startDate,
                "endDate": endDate,
                "dimension": "sources",
                "includePhoneBreakdown": "0",
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    /// Enriquecimiento secundario del panel Origen. Apaga el resto de las
    /// familias para consultar únicamente el read model por número.
    static func originPhoneBreakdown(
        startDate: String,
        endDate: String
    ) async throws -> OriginDistributionSnapshot {
        try await APIClient.shared.get(
            "/api/dashboard/origin-distribution",
            query: [
                "startDate": startDate,
                "endDate": endDate,
                "includeWeb": "0",
                "includeWhatsapp": "0",
                "dimension": "sources",
                "includeBreakdowns": "0",
                "includePhoneBreakdown": "1",
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    // MARK: - Custom labels

    /// `GET /api/settings/contact-labels` → `{customer, customers, lead, leads}`
    /// ya saneados (trim + defaults).
    static func customLabels() async throws -> DashboardCustomLabels {
        try await APIClient.shared.get("/api/settings/contact-labels")
    }
}
