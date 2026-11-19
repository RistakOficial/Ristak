import Foundation

/// Caché stale-while-revalidate por panel de Analíticas (Round 6 #4).
///
/// Analíticas tiene las agregaciones más lentas del backend, así que aquí es
/// donde más importa pintar al instante. Cada COMBINACIÓN (rango × scope × vista)
/// guarda su propio snapshot bajo su propia clave, de modo que al abrir la
/// pantalla o cambiar de filtro se puede recuperar el último resultado de ESA
/// combinación si la red no contesta a tiempo.
///
/// Los modelos del Core (`DashboardMetricsSnapshot`, `OriginDistributionSnapshot`,
/// etc.) son solo `Decodable`, así que NO podemos `store()` directo con ellos
/// (haría falta `Encodable`, prohibido en el Core). En su lugar, cada valor se
/// serializa con un DTO local `Encodable` cuyas claves COINCIDEN con las
/// `CodingKeys` del modelo del Core; al leer, `value(Modelo.self, …)` decodifica
/// ese JSON directamente con el `init(from:)` tolerante del modelo. Round-trip
/// idéntico al fetch en vivo, sin tocar el Core.
@MainActor
struct AnalyticsCache: Equatable {
    private static var cache: RistakSnapshotCache { .shared }

    let timeZone: TimeZone
    let currency: String
    let includeWeb: Bool

    init?(config: AppConfigStore, includeWeb: Bool) {
        guard let rawCurrency = config.appConfig[RistakAppConfigKey.accountCurrency],
              let currency = config.accountCurrency,
              rawCurrency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == currency,
              Self.cache.value(String.self, for: RistakCacheKey.timezone) == config.businessTimeZone.identifier
        else { return nil }
        self.timeZone = config.businessTimeZone
        self.currency = currency
        self.includeWeb = includeWeb
    }

    /// Un rechazo confirmado prevalece sobre cualquier snapshot del usuario
    /// hasta que el dashboard vuelva a responder con permiso.
    static var accessDenied: Bool {
        get { cache.value(Bool.self, for: "analytics:access-denied") ?? false }
        set {
            if newValue { cache.store(true, for: "analytics:access-denied") }
            else { cache.remove("analytics:access-denied") }
        }
    }

    // MARK: - Claves (una por combinación)

    /// Las versiones anteriores no guardaban moneda, zona ni permiso web.
    /// Una respuesta confirmada inicia el historial de esta combinación exacta.
    func rangeToken(_ range: AnalyticsDateRange) -> String {
        "\(timeZone.identifier):\(currency):\(includeWeb):\(range.startDate)_\(range.endDate):\(range.groupBy.rawValue)"
    }

    func metricsKey(_ range: AnalyticsDateRange) -> String {
        "analytics:metrics:\(rangeToken(range))"
    }

    /// La gráfica depende de rango + vista + (scope solo en «Ingresos vs gastos»).
    func chartKey(
        _ range: AnalyticsDateRange,
        _ kind: AnalyticsChartKind,
        _ scope: DashboardScope
    ) -> String {
        let scopeToken = kind.showsScope ? scope.rawValue : "none"
        return "analytics:chart:\(rangeToken(range)):\(kind.rawValue):\(scopeToken)"
    }

    func funnelKey(_ range: AnalyticsDateRange, _ scope: DashboardScope) -> String {
        "analytics:funnel:\(rangeToken(range)):\(scope.rawValue)"
    }

    func originKey(_ range: AnalyticsDateRange) -> String {
        "analytics:origin:\(rangeToken(range))"
    }

    /// Estado de números de WhatsApp: es a nivel de cuenta, no depende del rango.
    static let whatsappPhonesKey = "analytics:whatsapp-phones"

    /// Etiquetas personalizables (Interesados/Clientes): a nivel de cuenta.
    static let labelsKey = "analytics:labels"

    // MARK: - KPIs

    func storeMetrics(_ snapshot: DashboardMetricsSnapshot, _ range: AnalyticsDateRange) {
        Self.cache.store(MetricsDTO(snapshot), for: metricsKey(range))
    }

    // MARK: - Gráfica

    func storeChart(
        _ points: [AnalyticsChartPoint],
        _ range: AnalyticsDateRange,
        _ kind: AnalyticsChartKind,
        _ scope: DashboardScope
    ) {
        // `AnalyticsChartPoint` es Codable de la feature: round-trip nativo.
        Self.cache.store(points, for: chartKey(range, kind, scope))
    }

    // MARK: - Embudo

    func storeFunnel(_ rows: [DashboardFunnelRow], _ range: AnalyticsDateRange, _ scope: DashboardScope) {
        Self.cache.store(rows.map(FunnelRowDTO.init), for: funnelKey(range, scope))
    }

    // MARK: - Origen

    func storeOrigin(_ snapshot: OriginDistributionSnapshot, _ range: AnalyticsDateRange) {
        Self.cache.store(OriginDTO(snapshot), for: originKey(range))
    }

    // MARK: - Números de WhatsApp

    static func readPhones() -> [WhatsAppPhoneNumber]? {
        cache.value([WhatsAppPhoneNumber].self, for: whatsappPhonesKey)
    }

    static func storePhones(_ phones: [WhatsAppPhoneNumber]) {
        cache.store(phones.map(WhatsAppPhoneDTO.init), for: whatsappPhonesKey)
    }

    // MARK: - Etiquetas

    static func readLabels() -> DashboardCustomLabels? {
        cache.value(DashboardCustomLabels.self, for: labelsKey)
    }

    static func storeLabels(_ labels: DashboardCustomLabels) {
        cache.store(LabelsDTO(labels), for: labelsKey)
    }
}

// MARK: - DTOs de serialización (Encodable; claves == CodingKeys del Core)
//
// Cada DTO produce EXACTAMENTE el JSON que el `init(from:)` del modelo del Core
// espera, de modo que al leer decodificamos directo al modelo del Core sin
// añadirle `Encodable`.

/// `{ value, variation }` de `DashboardKPIValue`.
private struct MetricsKPIDTO: Encodable {
    let value: Double
    let variation: Double

    init?(_ kpi: DashboardKPIValue?) {
        guard let kpi else { return nil }
        value = kpi.value
        variation = kpi.variation
    }
}

/// Objeto pelado con los 8 KPIs (`DashboardMetricsSnapshot`).
private struct MetricsDTO: Encodable {
    let ingresosNetos: MetricsKPIDTO?
    let gastosPublicidad: MetricsKPIDTO?
    let gananciaBruta: MetricsKPIDTO?
    let roas: MetricsKPIDTO?
    let totalCostos: MetricsKPIDTO?
    let gananciaNeta: MetricsKPIDTO?
    let reembolsos: MetricsKPIDTO?
    let ltvPromedio: MetricsKPIDTO?

    init(_ snapshot: DashboardMetricsSnapshot) {
        ingresosNetos = MetricsKPIDTO(snapshot.ingresosNetos)
        gastosPublicidad = MetricsKPIDTO(snapshot.gastosPublicidad)
        gananciaBruta = MetricsKPIDTO(snapshot.gananciaBruta)
        roas = MetricsKPIDTO(snapshot.roas)
        totalCostos = MetricsKPIDTO(snapshot.totalCostos)
        gananciaNeta = MetricsKPIDTO(snapshot.gananciaNeta)
        reembolsos = MetricsKPIDTO(snapshot.reembolsos)
        ltvPromedio = MetricsKPIDTO(snapshot.ltvPromedio)
    }
}

/// `{ stage, value }` de `DashboardFunnelRow`.
private struct FunnelRowDTO: Encodable {
    let stage: String
    let value: Double

    init(_ row: DashboardFunnelRow) {
        stage = row.stage
        value = row.value
    }
}

/// `{ name, value, color? }` de `SourceBreakdownItem`.
private struct SourceItemDTO: Encodable {
    let name: String
    let value: Double
    let color: String?

    init(_ item: SourceBreakdownItem) {
        name = item.name
        value = item.value
        color = item.color
    }
}

/// Buckets de tráfico (`OriginTrafficBuckets`).
private struct TrafficDTO: Encodable {
    let sources: [SourceItemDTO]
    let platforms: [SourceItemDTO]
    let devices: [SourceItemDTO]
    let placements: [SourceItemDTO]
    let browsers: [SourceItemDTO]
    let os: [SourceItemDTO]

    init(_ traffic: OriginTrafficBuckets) {
        sources = traffic.sources.map(SourceItemDTO.init)
        platforms = traffic.platforms.map(SourceItemDTO.init)
        devices = traffic.devices.map(SourceItemDTO.init)
        placements = traffic.placements.map(SourceItemDTO.init)
        browsers = traffic.browsers.map(SourceItemDTO.init)
        os = traffic.os.map(SourceItemDTO.init)
    }
}

/// Fila `whatsappNumbers` del origin-distribution (`WhatsAppNumberOriginItem`).
private struct WhatsAppOriginItemDTO: Encodable {
    let name: String
    let value: Double
    let phoneNumberId: String?
    let phoneNumber: String?
    let displayPhoneNumber: String?
    let status: String?
    let apiSendEnabled: Bool?
    let qrSendEnabled: Bool?

    init(_ item: WhatsAppNumberOriginItem) {
        name = item.name
        value = item.value
        phoneNumberId = item.phoneNumberId
        phoneNumber = item.phoneNumber
        displayPhoneNumber = item.displayPhoneNumber
        status = item.status
        apiSendEnabled = item.apiSendEnabled
        qrSendEnabled = item.qrSendEnabled
    }
}

/// `data` de origin-distribution (`OriginDistributionSnapshot`).
private struct OriginDTO: Encodable {
    let traffic: TrafficDTO
    let leads: [SourceItemDTO]
    let appointments: [SourceItemDTO]
    let conversions: [SourceItemDTO]
    let whatsappNumbers: [WhatsAppOriginItemDTO]

    init(_ snapshot: OriginDistributionSnapshot) {
        traffic = TrafficDTO(snapshot.traffic)
        leads = snapshot.leads.map(SourceItemDTO.init)
        appointments = snapshot.appointments.map(SourceItemDTO.init)
        conversions = snapshot.conversions.map(SourceItemDTO.init)
        whatsappNumbers = snapshot.whatsappNumbers.map(WhatsAppOriginItemDTO.init)
    }
}

/// Número de WhatsApp (`WhatsAppPhoneNumber`), con las claves snake_case del
/// modelo y solo los campos que usa la derivación de filas del panel.
private struct WhatsAppPhoneDTO: Encodable {
    let id: String
    let phoneNumber: String?
    let displayPhoneNumber: String?
    let verifiedName: String?
    let label: String?
    let qrStatus: String?
    let qrConnectedPhone: String?
    let apiSendEnabled: Bool
    let qrSendEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case phoneNumber = "phone_number"
        case displayPhoneNumber = "display_phone_number"
        case verifiedName = "verified_name"
        case label
        case qrStatus = "qr_status"
        case qrConnectedPhone = "qr_connected_phone"
        case apiSendEnabled = "api_send_enabled"
        case qrSendEnabled = "qr_send_enabled"
    }

    init(_ phone: WhatsAppPhoneNumber) {
        id = phone.id
        phoneNumber = phone.phoneNumber
        displayPhoneNumber = phone.displayPhoneNumber
        verifiedName = phone.verifiedName
        label = phone.label
        qrStatus = phone.qrStatus
        qrConnectedPhone = phone.qrConnectedPhone
        apiSendEnabled = phone.apiSendEnabled
        qrSendEnabled = phone.qrSendEnabled
    }
}

/// `{ customer, customers, lead, leads }` de `DashboardCustomLabels`.
private struct LabelsDTO: Encodable {
    let customer: String
    let customers: String
    let lead: String
    let leads: String

    init(_ labels: DashboardCustomLabels) {
        customer = labels.customer
        customers = labels.customers
        lead = labels.lead
        leads = labels.leads
    }
}
