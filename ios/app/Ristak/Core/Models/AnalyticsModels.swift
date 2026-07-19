import Foundation

// MARK: - Periodos y agrupación (doc 09 §3.3)

enum AnalyticsGroupBy: String, Sendable, Equatable {
    case day
    case month
}

/// Opciones del selector de periodo de Analíticas.
enum AnalyticsPeriod: String, CaseIterable, Sendable, Equatable {
    case d30 = "30d"
    case d60 = "60d"
    case d180 = "180d"
    case year
    case custom

    /// Label del chip/pastilla.
    var chipLabel: String {
        switch self {
        case .d30: return "30 días"
        case .d60: return "60 días"
        case .d180: return "180 días"
        case .year: return "Año"
        case .custom: return "Personalizado"
        }
    }

    /// Label dentro del menú.
    var menuLabel: String {
        switch self {
        case .d30: return "Últimos 30 días"
        case .d60: return "Últimos 60 días"
        case .d180: return "Últimos 180 días"
        case .year: return "Último año"
        case .custom: return "Fecha personalizada"
        }
    }

    /// Días del rango inclusivo (nil para `custom`).
    var days: Int? {
        switch self {
        case .d30: return 30
        case .d60: return 60
        case .d180: return 180
        case .year: return 365
        case .custom: return nil
        }
    }

    var defaultGroupBy: AnalyticsGroupBy {
        switch self {
        case .d30, .d60: return .day
        case .d180, .year: return .month
        case .custom: return .day
        }
    }

    /// Umbral de rango personalizado: span > 120 días ⇒ `month` (Expo
    /// `App.tsx:10325-10331`).
    static let customMonthlyThresholdDays = 120
}

/// Rango resuelto (`YYYY-MM-DD` en zona del NEGOCIO) + agrupación.
struct AnalyticsDateRange: Sendable, Equatable {
    let startDate: String
    let endDate: String
    let groupBy: AnalyticsGroupBy
}

// MARK: - Scope de atribución (doc 09 §6.3)

/// Segmented «Todos / Al registro / Anuncios».
enum DashboardScope: String, CaseIterable, Sendable, Equatable {
    case all
    case attribution
    case campaigns

    var displayLabel: String {
        switch self {
        case .all: return "Todos"
        case .attribution: return "Al registro"
        case .campaigns: return "Anuncios"
        }
    }
}

// MARK: - KPIs (doc 09 §4.2)

/// Un KPI `{ value, variation }` (variation en %, puede ser negativa).
struct DashboardKPIValue: Decodable, Sendable, Equatable {
    let value: Double
    let variation: Double

    enum CodingKeys: String, CodingKey {
        case value, variation
    }

    init(value: Double = 0, variation: Double = 0) {
        self.value = value
        self.variation = variation
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        value = container.flexibleDouble(forKey: .value) ?? 0
        variation = container.flexibleDouble(forKey: .variation) ?? 0
    }

    /// Delta estilo `+12.3% vs antes` / `-3.1% vs antes` / `0% vs antes`.
    var variationLabel: String {
        if variation == 0 { return "0% vs antes" }
        let sign = variation > 0 ? "+" : ""
        return String(format: "%@%.1f%% vs antes", sign, variation)
    }
}

/// `GET /api/dashboard/metrics` — objeto PELADO con 8 KPIs; cada campo puede
/// faltar (tratar como opcional, paridad Expo `types.ts:328-337`).
struct DashboardMetricsSnapshot: Decodable, Sendable, Equatable {
    let ingresosNetos: DashboardKPIValue?
    let gastosPublicidad: DashboardKPIValue?
    let gananciaBruta: DashboardKPIValue?
    let roas: DashboardKPIValue?
    let totalCostos: DashboardKPIValue?
    let gananciaNeta: DashboardKPIValue?
    let reembolsos: DashboardKPIValue?
    let ltvPromedio: DashboardKPIValue?

    enum CodingKeys: String, CodingKey {
        case ingresosNetos, gastosPublicidad, gananciaBruta, roas
        case totalCostos, gananciaNeta, reembolsos, ltvPromedio
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ingresosNetos = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .ingresosNetos)
        gastosPublicidad = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .gastosPublicidad)
        gananciaBruta = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .gananciaBruta)
        roas = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .roas)
        totalCostos = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .totalCostos)
        gananciaNeta = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .gananciaNeta)
        reembolsos = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .reembolsos)
        ltvPromedio = try? container.decodeIfPresent(DashboardKPIValue.self, forKey: .ltvPromedio)
    }
}

// MARK: - Series (doc 09 §4.4)

/// Punto de serie `{ label, value }`; `label` = `YYYY-MM-DD` (day) o `YYYY-MM` (month).
struct DashboardSeriesPoint: Decodable, Sendable, Equatable {
    let label: String
    let value: Double

    enum CodingKeys: String, CodingKey {
        case label, value
    }

    init(label: String, value: Double) {
        self.label = label
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = container.flexibleString(forKey: .label) ?? ""
        value = container.flexibleDouble(forKey: .value) ?? 0
    }
}

/// Punto de `financial-overview` `{ label, value: ingresos, value2: gastos }`.
struct DashboardFinancialPoint: Decodable, Sendable, Equatable {
    let label: String
    let value: Double
    let value2: Double

    enum CodingKeys: String, CodingKey {
        case label, value, value2
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = container.flexibleString(forKey: .label) ?? ""
        value = container.flexibleDouble(forKey: .value) ?? 0
        value2 = container.flexibleDouble(forKey: .value2) ?? 0
    }
}

/// Series disponibles para la gráfica (doc 09 §4.4).
enum DashboardSeriesKind: String, CaseIterable, Sendable {
    case visitors
    case leads
    case appointments
    case attendances
    case sales

    var path: String { "/api/dashboard/\(rawValue)" }
}

// MARK: - Embudo (doc 09 §4.5)

struct DashboardFunnelRow: Decodable, Sendable, Equatable {
    /// Etiqueta que viene del backend (posiciones 2 y 5 usan custom labels).
    let stage: String
    let value: Double

    enum CodingKeys: String, CodingKey {
        case stage, value
    }

    init(stage: String, value: Double) {
        self.stage = stage
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        stage = container.flexibleString(forKey: .stage) ?? ""
        value = container.flexibleDouble(forKey: .value) ?? 0
    }
}

// MARK: - Origen (doc 09 §4.6)

/// Item `{ name, value }` (+ `color` solo en `/traffic-sources` de escritorio).
struct SourceBreakdownItem: Decodable, Sendable, Equatable {
    let name: String
    let value: Double
    let color: String?

    enum CodingKeys: String, CodingKey {
        case name, value, color
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.flexibleString(forKey: .name) ?? ""
        value = container.flexibleDouble(forKey: .value) ?? 0
        color = container.flexibleString(forKey: .color)
    }
}

/// Fila de `whatsappNumbers` del origin-distribution.
struct WhatsAppNumberOriginItem: Decodable, Sendable, Equatable {
    let name: String
    let value: Double
    let phoneNumberId: String?
    let phoneNumber: String?
    let displayPhoneNumber: String?
    let status: String?
    let apiSendEnabled: Bool?
    let qrSendEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case name, value, phoneNumberId, phoneNumber, displayPhoneNumber
        case status, apiSendEnabled, qrSendEnabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.flexibleString(forKey: .name) ?? "Número sin nombre"
        value = container.flexibleDouble(forKey: .value) ?? 0
        phoneNumberId = container.flexibleString(forKey: .phoneNumberId)
        phoneNumber = container.flexibleString(forKey: .phoneNumber)
        displayPhoneNumber = container.flexibleString(forKey: .displayPhoneNumber)
        status = container.flexibleString(forKey: .status)
        apiSendEnabled = container.flexibleBool(forKey: .apiSendEnabled)
        qrSendEnabled = container.flexibleBool(forKey: .qrSendEnabled)
    }
}

/// Buckets de tráfico web del origin-distribution.
struct OriginTrafficBuckets: Decodable, Sendable, Equatable {
    let sources: [SourceBreakdownItem]
    let platforms: [SourceBreakdownItem]
    let devices: [SourceBreakdownItem]
    let placements: [SourceBreakdownItem]
    let browsers: [SourceBreakdownItem]
    let os: [SourceBreakdownItem]

    enum CodingKeys: String, CodingKey {
        case sources, platforms, devices, placements, browsers, os
    }

    init() {
        sources = []
        platforms = []
        devices = []
        placements = []
        browsers = []
        os = []
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sources = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .sources)) ?? []
        platforms = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .platforms)) ?? []
        devices = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .devices)) ?? []
        placements = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .placements)) ?? []
        browsers = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .browsers)) ?? []
        os = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .os)) ?? []
    }
}

/// `GET /api/dashboard/origin-distribution` → `data`.
struct OriginDistributionSnapshot: Decodable, Sendable, Equatable {
    let traffic: OriginTrafficBuckets
    let leads: [SourceBreakdownItem]
    let appointments: [SourceBreakdownItem]
    let conversions: [SourceBreakdownItem]
    let whatsappNumbers: [WhatsAppNumberOriginItem]

    enum CodingKeys: String, CodingKey {
        case traffic, leads, appointments, conversions, whatsappNumbers
    }

    init(
        traffic: OriginTrafficBuckets,
        leads: [SourceBreakdownItem],
        appointments: [SourceBreakdownItem],
        conversions: [SourceBreakdownItem],
        whatsappNumbers: [WhatsAppNumberOriginItem]
    ) {
        self.traffic = traffic
        self.leads = leads
        self.appointments = appointments
        self.conversions = conversions
        self.whatsappNumbers = whatsappNumbers
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        traffic = (try? container.decodeIfPresent(OriginTrafficBuckets.self, forKey: .traffic)) ?? OriginTrafficBuckets()
        leads = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .leads)) ?? []
        appointments = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .appointments)) ?? []
        conversions = (try? container.decodeIfPresent([SourceBreakdownItem].self, forKey: .conversions)) ?? []
        whatsappNumbers = (try? container.decodeIfPresent([WhatsAppNumberOriginItem].self, forKey: .whatsappNumbers)) ?? []
    }
}

// MARK: - Custom labels (doc 09 §4.8)

/// `GET /api/settings/contact-labels` → `data`. Saneo: trim + fallback al
/// default si viene vacío.
struct DashboardCustomLabels: Decodable, Sendable, Equatable {
    let customer: String
    let customers: String
    let lead: String
    let leads: String

    enum CodingKeys: String, CodingKey {
        case customer, customers, lead, leads
    }

    static let defaults = DashboardCustomLabels(
        customer: "Cliente",
        customers: "Clientes",
        lead: "Interesado",
        leads: "Interesados"
    )

    init(customer: String, customers: String, lead: String, leads: String) {
        self.customer = customer
        self.customers = customers
        self.lead = lead
        self.leads = leads
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        customer = Self.sanitize(container.flexibleString(forKey: .customer), fallback: Self.defaults.customer)
        customers = Self.sanitize(container.flexibleString(forKey: .customers), fallback: Self.defaults.customers)
        lead = Self.sanitize(container.flexibleString(forKey: .lead), fallback: Self.defaults.lead)
        leads = Self.sanitize(container.flexibleString(forKey: .leads), fallback: Self.defaults.leads)
    }

    private static func sanitize(_ raw: String?, fallback: String) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }
}
