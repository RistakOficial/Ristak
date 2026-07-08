import Foundation

/// Formateadores de negocio. TODAS las fechas visibles se calculan con la zona
/// horaria de la CUENTA (nunca la del dispositivo) y los montos con
/// `account_currency` en formato `es-MX` (docs research/01 §9-§10).
struct BusinessFormatters: Sendable {
    /// Zona horaria del negocio (de `GET /api/settings/timezone`).
    var timeZone: TimeZone
    /// Moneda de la cuenta normalizada (para montos sin moneda propia).
    var currencyCode: String

    init(timeZone: TimeZone, currencyCode: String = "MXN") {
        self.timeZone = timeZone
        self.currencyCode = Self.normalizeCurrencyCode(currencyCode)
    }

    static let localeIdentifier = "es_MX"
    static var locale: Locale { Locale(identifier: localeIdentifier) }

    /// Meses cortos de la bandeja (paridad RN `CHAT_SHORT_MONTHS`).
    static let shortMonths = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

    // MARK: - Fechas relativas de la bandeja (doc 03 §4.5 + audit resolution)

    /// Fecha relativa de una fila de la bandeja:
    /// - Mismo día de negocio → hora `7:47 p.m.` (12 h es-MX). Nunca "Hoy".
    /// - Día anterior → `Ayer`.
    /// - 2–6 días atrás → día de semana capitalizado (`Miércoles`).
    /// - ≥7 días → formato corto `04-jul`.
    func inboxRelativeDate(_ date: Date, now: Date = Date()) -> String {
        let diffDays = businessDaysBetween(date, and: now)
        if diffDays <= 0 {
            return inboxTime(date)
        }
        if diffDays == 1 {
            return "Ayer"
        }
        if diffDays < 7 {
            return capitalizedWeekday(date)
        }
        let parts = businessDateComponents(date)
        guard let month = Self.shortMonths[safe: (parts.month ?? 1) - 1] else { return "" }
        return String(format: "%02d-%@", parts.day ?? 0, month)
    }

    /// Variante desde string ISO del backend; string inválido → "".
    func inboxRelativeDate(fromISO value: String?, now: Date = Date()) -> String {
        guard let date = RistakDateParsing.date(fromISO: value) else { return "" }
        return inboxRelativeDate(date, now: now)
    }

    /// Hora de bandeja en 12 h es-MX (`7:47 p.m.` — contrato normativo
    /// docs/MOBILE_APP.md §fechas de bandeja, igual que RN).
    func inboxTime(_ date: Date) -> String {
        BusinessFormatterCache.shared.dateFormatter(
            format: "h:mm a",
            timeZone: timeZone,
            locale: Self.locale
        ).string(from: date)
    }

    // MARK: - Separadores de día del hilo (doc 04 §separadores)

    /// Clave de agrupación por día de negocio (`YYYY-MM-DD`); fecha inválida →
    /// `"sin-fecha"` (paridad RN `getConversationDayKey`).
    func conversationDayKey(fromISO value: String?) -> String {
        guard let date = RistakDateParsing.date(fromISO: value) else { return "sin-fecha" }
        return conversationDayKey(date)
    }

    func conversationDayKey(_ date: Date) -> String {
        let parts = businessDateComponents(date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Etiqueta del separador de día: `Hoy`, `Ayer`, día de semana (es-MX) si
    /// <7 días, y si no `02 jul` (+ año si difiere del actual): `02 jul 2025`.
    func daySeparatorLabel(_ date: Date, now: Date = Date()) -> String {
        let diffDays = businessDaysBetween(date, and: now)
        if diffDays == 0 { return "Hoy" }
        if diffDays == 1 { return "Ayer" }
        if diffDays > 1 && diffDays < 7 {
            return weekdayName(date)
        }
        let parts = businessDateComponents(date)
        let nowParts = businessDateComponents(now)
        guard let month = Self.shortMonths[safe: (parts.month ?? 1) - 1] else { return "" }
        let base = String(format: "%02d %@", parts.day ?? 0, month)
        if parts.year != nowParts.year, let year = parts.year {
            return "\(base) \(year)"
        }
        return base
    }

    func daySeparatorLabel(fromISO value: String?, now: Date = Date()) -> String {
        guard let date = RistakDateParsing.date(fromISO: value) else { return "" }
        return daySeparatorLabel(date, now: now)
    }

    // MARK: - Hora de mensaje

    /// Hora de un mensaje dentro del hilo, 12 h es-MX (`7:47 p.m.` — paridad
    /// RN `formatMessageTime`).
    func messageTime(_ date: Date) -> String {
        BusinessFormatterCache.shared.dateFormatter(
            format: "h:mm a",
            timeZone: timeZone,
            locale: Self.locale
        ).string(from: date)
    }

    func messageTime(fromISO value: String?) -> String {
        guard let date = RistakDateParsing.date(fromISO: value) else { return "" }
        return messageTime(date)
    }

    // MARK: - Moneda (es-MX + account_currency)

    /// Formatea un monto. Regla de moneda: respetar la `currency` guardada en
    /// el registro; si no trae, usar la de la cuenta
    /// (`formatCurrency(amount, record.currency || accountCurrency)`).
    func currency(_ amount: Double, currencyOverride: String? = nil) -> String {
        let code = Self.normalizeCurrencyCode(currencyOverride ?? currencyCode)
        let formatter = BusinessFormatterCache.shared.currencyFormatter(code: code, locale: Self.locale)
        return formatter.string(from: NSNumber(value: amount)) ?? ""
    }

    /// Moneda compacta para escalas de gráficas/KPIs (`$152.3 k`).
    func compactCurrency(_ amount: Double, currencyOverride: String? = nil) -> String {
        let code = Self.normalizeCurrencyCode(currencyOverride ?? currencyCode)
        return amount.formatted(
            .currency(code: code)
            .notation(.compactName)
            .precision(.fractionLength(0...1))
            .locale(Self.locale)
        )
    }

    /// Normaliza un código ISO-4217: trim + uppercase; inválido → `MXN`
    /// (paridad RN `normalizeCurrencyCode`).
    static func normalizeCurrencyCode(_ value: String?) -> String {
        let code = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard code.count == 3, code.allSatisfy({ $0.isLetter && $0.isASCII }) else { return "MXN" }
        return code
    }

    // MARK: - Números

    /// Entero con separadores es-MX (`1,234`).
    func wholeNumber(_ value: Double) -> String {
        let formatter = BusinessFormatterCache.shared.numberFormatter(locale: Self.locale)
        return formatter.string(from: NSNumber(value: value)) ?? ""
    }

    /// Número compacto para KPIs (`4.2 k`).
    func compactNumber(_ value: Double) -> String {
        value.formatted(
            .number
            .notation(.compactName)
            .precision(.fractionLength(0...1))
            .locale(Self.locale)
        )
    }

    /// ROAS estilo `2.35x`.
    func roas(_ value: Double) -> String {
        String(format: "%.2fx", value)
    }

    // MARK: - Duración de audio

    /// Duración `m:ss` para notas de voz (`0:02`, `12:07`).
    static func audioDuration(milliseconds: Double) -> String {
        audioDuration(seconds: milliseconds / 1000)
    }

    static func audioDuration(seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let minutes = total / 60
        let secs = total % 60
        return String(format: "%d:%02d", minutes, secs)
    }

    // MARK: - Internos

    /// Días de diferencia (granularidad día de negocio) entre `date` y `now`.
    private func businessDaysBetween(_ date: Date, and now: Date) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let start = calendar.startOfDay(for: date)
        let end = calendar.startOfDay(for: now)
        return calendar.dateComponents([.day], from: start, to: end).day ?? 0
    }

    private func businessDateComponents(_ date: Date) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.dateComponents([.year, .month, .day], from: date)
    }

    /// Día de semana es-MX en minúsculas (`martes`) — separadores del hilo.
    private func weekdayName(_ date: Date) -> String {
        BusinessFormatterCache.shared.dateFormatter(
            format: "EEEE",
            timeZone: timeZone,
            locale: Self.locale
        ).string(from: date)
    }

    /// Día de semana capitalizado (`Miércoles`) — filas de la bandeja.
    private func capitalizedWeekday(_ date: Date) -> String {
        let name = weekdayName(date)
        guard let first = name.first else { return name }
        return String(first).uppercased() + name.dropFirst()
    }
}

// MARK: - Caché de formatters

/// `DateFormatter`/`NumberFormatter` son caros de crear; este caché los
/// reutiliza. El formateo (no la mutación) es thread-safe desde iOS 7.
private final class BusinessFormatterCache: @unchecked Sendable {
    static let shared = BusinessFormatterCache()

    private let lock = NSLock()
    private var dateFormatters: [String: DateFormatter] = [:]
    private var numberFormatters: [String: NumberFormatter] = [:]

    func dateFormatter(format: String, timeZone: TimeZone, locale: Locale) -> DateFormatter {
        let key = "\(format)|\(timeZone.identifier)|\(locale.identifier)"
        lock.lock()
        defer { lock.unlock() }
        if let cached = dateFormatters[key] { return cached }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        dateFormatters[key] = formatter
        return formatter
    }

    func currencyFormatter(code: String, locale: Locale) -> NumberFormatter {
        let key = "currency|\(code)|\(locale.identifier)"
        lock.lock()
        defer { lock.unlock() }
        if let cached = numberFormatters[key] { return cached }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .currency
        formatter.currencyCode = code
        formatter.maximumFractionDigits = 2
        numberFormatters[key] = formatter
        return formatter
    }

    func numberFormatter(locale: Locale) -> NumberFormatter {
        let key = "decimal|\(locale.identifier)"
        lock.lock()
        defer { lock.unlock() }
        if let cached = numberFormatters[key] { return cached }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        numberFormatters[key] = formatter
        return formatter
    }
}

// MARK: - Utilidades

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
