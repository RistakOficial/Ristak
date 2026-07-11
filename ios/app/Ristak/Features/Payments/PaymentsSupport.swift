import Foundation
import SwiftUI

// MARK: - Contacto elegido para cobrar

/// Contacto seleccionado en el flujo de cobro (contact-first, doc 08 §6.3.1).
struct PickedPaymentContact: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let email: String
    let phone: String
    let photoURL: URL?
    let channel: RistakChatChannel?
    /// `true` cuando viene precargado desde el chat (no editable).
    var isLocked: Bool = false

    init(
        id: String,
        name: String,
        email: String,
        phone: String,
        photoURL: URL? = nil,
        channel: RistakChatChannel? = nil,
        isLocked: Bool = false
    ) {
        self.id = id
        self.name = name
        self.email = email
        self.phone = phone
        self.photoURL = photoURL
        self.channel = channel
        self.isLocked = isLocked
    }

    init(chatContact: ChatContact, isLocked: Bool = false) {
        self.init(
            id: chatContact.id,
            name: chatContact.name,
            email: chatContact.email,
            phone: chatContact.phone,
            photoURL: chatContact.profilePhotoUrl.flatMap(URL.init(string:)),
            channel: ChatRowSignals.badgeChannel(chatContact),
            isLocked: isLocked
        )
    }

    init(detail: ContactDetail, isLocked: Bool = false) {
        self.init(
            id: detail.id,
            name: detail.name,
            email: detail.email,
            phone: detail.phone,
            photoURL: detail.profilePhotoUrl.flatMap(URL.init(string:)),
            channel: RistakChatChannel(raw: detail.source),
            isLocked: isLocked
        )
    }

    /// Etiqueta: nombre → email → teléfono → «Cliente sin nombre».
    var displayName: String {
        if !name.isEmpty { return name }
        if !email.isEmpty { return email }
        if !phone.isEmpty { return phone }
        return "Cliente sin nombre"
    }

    var secondaryLabel: String {
        if !email.isEmpty { return email }
        if !phone.isEmpty { return phone }
        return ""
    }
}

// MARK: - Rutas del módulo

/// Flujos de cobro del home de Pagos (paridad /movil `PaymentView`).
enum PaymentsFlow: String, Hashable, Sendable {
    case single
    case installments
    case subscription
    case products
}

/// Valor de navegación: flujo + contacto precargado (contact-first).
struct PaymentsRoute: Hashable, Sendable {
    let flow: PaymentsFlow
    var contact: PickedPaymentContact?
}

// MARK: - Periodos de «Últimos pagos» (doc 08 §6.1)

enum RecentPaymentsPeriod: String, CaseIterable, Identifiable, Sendable {
    case today
    case week
    case month
    case quarter

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return "Hoy"
        case .week: return "7 días"
        case .month: return "30 días"
        case .quarter: return "90 días"
        }
    }

    /// Días del rango (hoy y `días-1` hacia atrás, TZ del negocio).
    var days: Int {
        switch self {
        case .today: return 1
        case .week: return 7
        case .month: return 30
        case .quarter: return 90
        }
    }
}

// MARK: - Fechas en zona horaria del negocio

enum PaymentsDateMath {
    /// `YYYY-MM-DD` de una fecha en la zona del negocio (formato de filtros
    /// y payloads del backend, doc 08 §0).
    static func dateString(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Rango `(startDate, endDate)` de un periodo: hoy y `días-1` hacia atrás.
    static func range(for period: RecentPaymentsPeriod, timeZone: TimeZone, now: Date = Date()) -> (start: String, end: String) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let end = now
        let start = calendar.date(byAdding: .day, value: -(period.days - 1), to: now) ?? now
        return (dateString(start, timeZone: timeZone), dateString(end, timeZone: timeZone))
    }

    /// Inicio del día de HOY en la zona del negocio (mínimo de date pickers).
    static func startOfToday(timeZone: TimeZone, now: Date = Date()) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.startOfDay(for: now)
    }

    /// Suma pasos de frecuencia sobre una fecha (planes de pago).
    static func advancing(_ date: Date, frequency: PaymentPlanFrequency, steps: Int, timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        switch frequency {
        case .daily:
            return calendar.date(byAdding: .day, value: steps, to: date) ?? date
        case .weekly:
            return calendar.date(byAdding: .day, value: 7 * steps, to: date) ?? date
        case .biweekly:
            return calendar.date(byAdding: .day, value: 14 * steps, to: date) ?? date
        case .monthly:
            return calendar.date(byAdding: .month, value: steps, to: date) ?? date
        case .yearly:
            return calendar.date(byAdding: .year, value: steps, to: date) ?? date
        case .custom:
            return calendar.date(byAdding: .month, value: steps, to: date) ?? date
        }
    }

    /// Fecha visible de un pago: `5 jul` (+ hora `7:47 p.m.` si el ISO trae
    /// hora) — paridad RN `formatPaymentDate`.
    static func paymentDateLabel(iso: String?, timeZone: TimeZone) -> String {
        guard let iso, let date = RistakDateParsing.date(fromISO: iso) else { return "" }
        let hasTime = iso.contains("T") || iso.contains(":")

        let dayFormatter = DateFormatter()
        dayFormatter.locale = BusinessFormatters.locale
        // Los valores solo-fecha (`YYYY-MM-DD`) se parsean como medianoche UTC;
        // formatearlos en la TZ del negocio (p. ej. UTC-6) los recorre al día
        // anterior. Se formatean en UTC para que `2026-07-14` muestre `14 jul`,
        // no `13 jul`. Los ISO con hora sí van en la TZ del negocio.
        dayFormatter.timeZone = hasTime ? timeZone : TimeZone(identifier: "UTC")
        dayFormatter.dateFormat = "d MMM"
        let day = dayFormatter.string(from: date)

        guard hasTime else { return day }

        let timeFormatter = DateFormatter()
        timeFormatter.locale = BusinessFormatters.locale
        timeFormatter.timeZone = timeZone
        timeFormatter.dateFormat = "h:mm a"
        return "\(day) \(timeFormatter.string(from: date))"
    }
}

// MARK: - Parseo de montos

enum PaymentsAmountParser {
    /// Parsea texto de monto es-MX tolerante (`1,500.50`, `1500,5`).
    static func amount(from text: String) -> Double? {
        var normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        normalized = normalized.replacingOccurrences(of: "$", with: "")
        normalized = normalized.replacingOccurrences(of: " ", with: "")
        guard !normalized.isEmpty else { return nil }

        if normalized.contains(","), normalized.contains(".") {
            // "1,500.50" → coma de miles.
            normalized = normalized.replacingOccurrences(of: ",", with: "")
        } else if normalized.contains(",") {
            // "1500,5" → coma decimal.
            normalized = normalized.replacingOccurrences(of: ",", with: ".")
        }
        guard let value = Double(normalized), value.isFinite else { return nil }
        return value
    }
}

// MARK: - Frecuencias de plan (doc 08 §2.9 / §6.3.1)

enum PaymentPlanFrequency: String, CaseIterable, Identifiable, Sendable {
    case daily
    case weekly
    case biweekly
    case monthly
    case yearly
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .daily: return "Diario"
        case .weekly: return "Semanal"
        case .biweekly: return "Quincenal"
        case .monthly: return "Mensual"
        case .yearly: return "Anual"
        case .custom: return "Personalizada"
        }
    }

    /// Valor que viaja al backend (`remainingFrequency`).
    var apiValue: String { rawValue }
}

// MARK: - Impuestos (`/api/settings/payments.taxes`, doc 08 §1.8)

struct PaymentTaxSettings: Decodable, Sendable, Equatable {
    let enabled: Bool
    let taxName: String
    let rateType: String
    let rateValue: Double
    let calculationMode: String

    enum CodingKeys: String, CodingKey {
        case enabled, taxName, rateType, rateValue, calculationMode
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = container.flexibleBool(forKey: .enabled) ?? false
        taxName = container.flexibleString(forKey: .taxName) ?? "IVA"
        rateType = container.flexibleString(forKey: .rateType) ?? "percentage"
        rateValue = container.flexibleDouble(forKey: .rateValue) ?? 16
        calculationMode = container.flexibleString(forKey: .calculationMode) ?? "exclusive"
    }
}

/// Subset tolerante de `GET /api/settings/payments` (solo lo que usa el wizard).
struct PaymentSettingsSnapshot: Decodable, Sendable {
    let taxes: PaymentTaxSettings?

    enum CodingKeys: String, CodingKey {
        case taxes
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        taxes = try? container.decodeIfPresent(PaymentTaxSettings.self, forKey: .taxes)
    }
}

/// Desglose de impuestos de un cobro (doc 08 §6.3.1, líneas 82-119 del modal).
struct PaymentTaxBreakdown: Sendable, Equatable {
    let applied: Bool
    let name: String
    let rate: Double
    /// `"exclusive" | "inclusive"`.
    let mode: String
    let subtotal: Double
    let taxAmount: Double
    let total: Double

    /// Sin impuestos: total = monto.
    static func none(amount: Double) -> PaymentTaxBreakdown {
        PaymentTaxBreakdown(applied: false, name: "", rate: 0, mode: "exclusive", subtotal: amount, taxAmount: 0, total: amount)
    }

    /// Calcula el desglose: exclusive → tax = base×rate/100, total = base+tax;
    /// inclusive → tax = base − base/(1+rate/100), total = base.
    static func compute(amount: Double, settings: PaymentTaxSettings, mode: String) -> PaymentTaxBreakdown {
        let rate = max(0, settings.rateValue)
        if mode == "inclusive" {
            let tax = amount - amount / (1 + rate / 100)
            return PaymentTaxBreakdown(
                applied: true,
                name: settings.taxName,
                rate: rate,
                mode: mode,
                subtotal: amount - tax,
                taxAmount: tax,
                total: amount
            )
        }
        let tax = amount * rate / 100
        return PaymentTaxBreakdown(
            applied: true,
            name: settings.taxName,
            rate: rate,
            mode: "exclusive",
            subtotal: amount,
            taxAmount: tax,
            total: amount + tax
        )
    }

    /// `metadata.tax` para pagos manuales. Debe usar la forma EXACTA que el
    /// backend honra en `getPaymentTax` (gigstackInvoiceService.js): solo
    /// respeta el impuesto almacenado cuando `enabled` es truthy Y
    /// `Number(taxAmount) > 0`, leyendo `taxName`, `rateValue`, `subtotalAmount`,
    /// `taxAmount` y `totalAmount`. Enviar `{name, rate, amount, ...}` hacía que
    /// el impuesto se descartara al facturar.
    var metadataValue: RistakJSONValue? {
        guard applied else { return nil }
        let round2: (Double) -> Double = { ($0 * 100).rounded() / 100 }
        return .object([
            "enabled": .bool(true),
            "taxName": .string(name),
            "rateValue": .number(rate),
            "subtotalAmount": .number(round2(subtotal)),
            "taxAmount": .number(round2(taxAmount)),
            "totalAmount": .number(round2(total)),
            "calculationMode": .string(mode),
        ])
    }
}
