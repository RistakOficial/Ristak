import SwiftUI

// MARK: - Día de negocio

/// Día calendario en la zona horaria del NEGOCIO (`account_timezone`).
/// Toda la agrupación, grilla mensual y timeline se calcula con este tipo —
/// nunca con el reloj/zona del dispositivo (doc 07 §1, regla dura).
struct CalendarBusinessDay: Hashable, Comparable, Sendable {
    var year: Int
    var month: Int
    var day: Int

    /// Clave `YYYY-MM-DD` (misma forma que las agrupaciones RN y `free-slots`).
    var key: String { String(format: "%04d-%02d-%02d", year, month, day) }

    static func < (lhs: CalendarBusinessDay, rhs: CalendarBusinessDay) -> Bool {
        if lhs.year != rhs.year { return lhs.year < rhs.year }
        if lhs.month != rhs.month { return lhs.month < rhs.month }
        return lhs.day < rhs.day
    }

    /// Parse de `YYYY-MM-DD` (fechas de `free-slots`).
    init?(key: String) {
        let parts = key.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        self.init(year: year, month: month, day: day)
    }

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }
}

// MARK: - Matemática de fechas en zona de negocio

/// Helpers de fecha del módulo Calendarios. Todas las funciones reciben la
/// zona horaria de la cuenta explícitamente.
enum CalendarDateMath {
    /// Fila de letras de la grilla mensual (domingo primero, paridad RN).
    static let weekdayLetters = ["D", "L", "M", "M", "J", "V", "S"]

    static func businessCalendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = BusinessFormatters.locale
        calendar.firstWeekday = 1 // domingo
        return calendar
    }

    static func day(from date: Date, timeZone: TimeZone) -> CalendarBusinessDay {
        let parts = businessCalendar(timeZone).dateComponents([.year, .month, .day], from: date)
        return CalendarBusinessDay(year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1)
    }

    /// 00:00 del día de negocio → instante UTC.
    static func startDate(of day: CalendarBusinessDay, timeZone: TimeZone) -> Date? {
        var components = DateComponents()
        components.year = day.year
        components.month = day.month
        components.day = day.day
        components.hour = 0
        components.minute = 0
        return businessCalendar(timeZone).date(from: components)
    }

    /// Instante UTC de un día de negocio + minutos desde medianoche.
    static func date(day: CalendarBusinessDay, minutes: Int, timeZone: TimeZone) -> Date? {
        guard let start = startDate(of: day, timeZone: timeZone) else { return nil }
        return businessCalendar(timeZone).date(byAdding: .minute, value: minutes, to: start)
    }

    static func adding(days: Int, to day: CalendarBusinessDay, timeZone: TimeZone) -> CalendarBusinessDay {
        guard let start = startDate(of: day, timeZone: timeZone),
              let moved = businessCalendar(timeZone).date(byAdding: .day, value: days, to: start) else { return day }
        return self.day(from: moved, timeZone: timeZone)
    }

    static func firstOfMonth(_ day: CalendarBusinessDay) -> CalendarBusinessDay {
        CalendarBusinessDay(year: day.year, month: day.month, day: 1)
    }

    /// Suma meses regresando el día 1 del mes resultante.
    static func addingMonths(_ months: Int, to day: CalendarBusinessDay) -> CalendarBusinessDay {
        let total = day.year * 12 + (day.month - 1) + months
        guard total >= 0 else { return firstOfMonth(day) }
        return CalendarBusinessDay(year: total / 12, month: total % 12 + 1, day: 1)
    }

    static func daysInMonth(year: Int, month: Int, timeZone: TimeZone) -> Int {
        let calendar = businessCalendar(timeZone)
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = 1
        guard let date = calendar.date(from: components),
              let range = calendar.range(of: .day, in: .month, for: date) else { return 30 }
        return range.count
    }

    /// Celda de la grilla mensual.
    struct GridDay: Hashable, Identifiable, Sendable {
        let day: CalendarBusinessDay
        let inMonth: Bool
        var id: String { day.key }
    }

    /// Grilla del mes agrupada en semanas reales (domingo primero), con días
    /// colindantes de meses vecinos marcados `inMonth == false`.
    static func monthGrid(year: Int, month: Int, timeZone: TimeZone) -> [[GridDay]] {
        let calendar = businessCalendar(timeZone)
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = 1
        guard let firstDate = calendar.date(from: components) else { return [] }

        let leading = calendar.component(.weekday, from: firstDate) - 1
        let count = daysInMonth(year: year, month: month, timeZone: timeZone)
        guard let gridStart = calendar.date(byAdding: .day, value: -leading, to: firstDate) else { return [] }

        let totalCells = Int((Double(leading + count) / 7.0).rounded(.up)) * 7
        var cells: [GridDay] = []
        cells.reserveCapacity(totalCells)
        for index in 0..<totalCells {
            guard let date = calendar.date(byAdding: .day, value: index, to: gridStart) else { continue }
            let cellDay = day(from: date, timeZone: timeZone)
            cells.append(GridDay(day: cellDay, inMonth: cellDay.month == month && cellDay.year == year))
        }
        return stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<min($0 + 7, cells.count)]) }
    }

    /// Semana (dom–sáb) que contiene al día dado.
    static func weekDays(containing day: CalendarBusinessDay, timeZone: TimeZone) -> [CalendarBusinessDay] {
        guard let date = startDate(of: day, timeZone: timeZone) else { return [day] }
        let calendar = businessCalendar(timeZone)
        let weekday = calendar.component(.weekday, from: date) // 1 = domingo
        let sunday = adding(days: -(weekday - 1), to: day, timeZone: timeZone)
        return (0..<7).map { adding(days: $0, to: sunday, timeZone: timeZone) }
    }

    /// Minutos desde la medianoche DE NEGOCIO del instante dado.
    static func minutesFromMidnight(of date: Date, timeZone: TimeZone) -> Int {
        let parts = businessCalendar(timeZone).dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }

    // MARK: Formato

    /// Título grande del mes: `Julio` (RN capitaliza `calendarTitle`).
    static func monthTitle(year: Int, month: Int, timeZone: TimeZone) -> String {
        guard let date = startDate(of: CalendarBusinessDay(year: year, month: month, day: 1), timeZone: timeZone) else {
            return ""
        }
        let raw = formatter("MMMM", timeZone: timeZone).string(from: date)
        guard let first = raw.first else { return raw }
        return String(first).uppercased() + raw.dropFirst()
    }

    /// Encabezado de agenda del día: `miércoles, 8 de julio`.
    static func dayHeader(_ day: CalendarBusinessDay, timeZone: TimeZone) -> String {
        guard let date = startDate(of: day, timeZone: timeZone) else { return day.key }
        return formatter("EEEE, d 'de' MMMM", timeZone: timeZone).string(from: date)
    }

    /// Etiqueta corta de chips de fecha: `mié 8 jul`.
    static func shortDayLabel(_ day: CalendarBusinessDay, timeZone: TimeZone) -> String {
        guard let date = startDate(of: day, timeZone: timeZone) else { return day.key }
        return formatter("EEE d MMM", timeZone: timeZone).string(from: date)
    }

    /// Título grande de la vista Día: `Miércoles, 8 de julio` (capitalizado).
    static func longDayTitle(_ day: CalendarBusinessDay, timeZone: TimeZone) -> String {
        let raw = dayHeader(day, timeZone: timeZone)
        guard let first = raw.first else { return raw }
        return String(first).uppercased() + raw.dropFirst()
    }

    /// Etiqueta `8 jul` para el rango de la vista Semana.
    static func dayMonthLabel(_ day: CalendarBusinessDay, timeZone: TimeZone) -> String {
        guard let date = startDate(of: day, timeZone: timeZone) else { return day.key }
        return formatter("d MMM", timeZone: timeZone).string(from: date)
    }

    /// Título corto de mes para la vista Año: `Ene` … `Dic` (capitalizado).
    static func monthShortTitle(month: Int) -> String {
        guard month >= 1, month <= 12 else { return "" }
        let raw = BusinessFormatters.shortMonths[month - 1]
        guard let first = raw.first else { return raw }
        return String(first).uppercased() + raw.dropFirst()
    }

    /// Etiqueta de hora del timeline al estilo RN: `12 a.m. … 11 p.m.`.
    static func hourLabel(_ hour: Int) -> String {
        switch hour {
        case 0: return "12 a.m."
        case 12: return "12 p.m."
        case 1..<12: return "\(hour) a.m."
        default: return "\(hour - 12) p.m."
        }
    }

    private static func formatter(_ format: String, timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = BusinessFormatters.locale
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        return formatter
    }
}

// MARK: - Color dinámico de calendario/estado

/// Parser de colores hex QUE VIENEN DEL BACKEND (`eventColor` del calendario)
/// o del catálogo documentado de estados (doc 07 §3.2). No es un color de
/// diseño hardcodeado: es dato del modelo.
enum CalendarColorParser {
    static func color(fromHex raw: String?) -> Color? {
        guard var hex = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !hex.isEmpty else { return nil }
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else { return nil }
        let red, green, blue: Double
        var alpha: Double = 1
        if hex.count == 8 {
            red = Double((value >> 24) & 0xFF) / 255
            green = Double((value >> 16) & 0xFF) / 255
            blue = Double((value >> 8) & 0xFF) / 255
            alpha = Double(value & 0xFF) / 255
        } else {
            red = Double((value >> 16) & 0xFF) / 255
            green = Double((value >> 8) & 0xFF) / 255
            blue = Double(value & 0xFF) / 255
        }
        return Color(red: red, green: green, blue: blue, opacity: alpha)
    }
}

extension AppointmentStatus {
    /// Color de estado documentado (modal web) parseado a `Color`.
    var displayColor: Color {
        CalendarColorParser.color(fromHex: referenceColorHex) ?? RistakTheme.info
    }
}

extension RistakCalendar {
    /// Color del calendario con fallback al acento de la app.
    var displayColor: Color {
        CalendarColorParser.color(fromHex: eventColor) ?? RistakTheme.accent
    }

    /// Duración de slot NORMALIZADA a minutos (unidad `hours` ⇒ ×60), clamp
    /// 15–1440 (paridad RN `getCalendarSlotDurationMinutes`, App.tsx ~7014).
    var normalizedSlotDurationMinutes: Int {
        let raw = CalendarUnitMath.normalizedMinutes(value: slotDuration, unit: slotDurationUnit) ?? 60
        return min(1440, max(15, raw))
    }

    /// Intervalo (snap) NORMALIZADO a minutos, clamp 5–60. Si no hay intervalo
    /// válido cae al `slotDuration` normalizado (paridad RN
    /// `getCalendarSnapMinutes`, App.tsx ~7024).
    var normalizedSlotIntervalMinutes: Int {
        let raw = CalendarUnitMath.normalizedMinutes(value: slotInterval, unit: slotIntervalUnit)
            ?? CalendarUnitMath.normalizedMinutes(value: slotDuration, unit: slotDurationUnit)
            ?? 15
        return min(60, max(5, raw))
    }
}

/// Normalización de duraciones/intervalos del calendario a minutos.
/// Paridad RN `normalizeCalendarMinutes` (App.tsx ~7006): un valor con unidad
/// que empieza por `hour` se multiplica por 60; valores ≤ 0 o inválidos → nil.
enum CalendarUnitMath {
    static func normalizedMinutes(value: Int?, unit: String?) -> Int? {
        guard let value, value > 0 else { return nil }
        let normalizedUnit = (unit ?? "mins").lowercased()
        return normalizedUnit.hasPrefix("hour") ? value * 60 : value
    }
}

// MARK: - Selección de contacto y prefill del formulario

/// Contacto elegido para una cita (del buscador, del deep link o recién creado).
struct AppointmentContactSelection: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let phone: String
    let email: String

    init(id: String, name: String, phone: String = "", email: String = "") {
        self.id = id
        self.name = name
        self.phone = phone
        self.email = email
    }

    init(chat: ChatContact) {
        self.init(id: chat.id, name: chat.name, phone: chat.phone, email: chat.email)
    }

    init(detail: ContactDetail) {
        self.init(id: detail.id, name: detail.name, phone: detail.phone, email: detail.email)
    }

    var displayName: String {
        if !name.isEmpty { return name }
        if !phone.isEmpty { return phone }
        if !email.isEmpty { return email }
        return "Contacto"
    }

    var secondaryLabel: String {
        if !phone.isEmpty { return phone }
        return email
    }
}

/// Prefill del flujo Nueva cita (día seleccionado, tap/rango del timeline).
struct AppointmentPrefill: Sendable {
    var day: CalendarBusinessDay
    /// Minutos desde medianoche de negocio (nil = sin hora elegida).
    var startMinutes: Int?
    var durationMinutes: Int?

    init(day: CalendarBusinessDay, startMinutes: Int? = nil, durationMinutes: Int? = nil) {
        self.day = day
        self.startMinutes = startMinutes
        self.durationMinutes = durationMinutes
    }
}

/// Contexto del sheet de creación/edición de cita.
struct AppointmentFlowContext: Identifiable {
    enum Kind {
        /// Crear: prefill de fecha/hora + contacto ya resuelto (deep link) o
        /// nil → primero el contact picker.
        case create(prefill: AppointmentPrefill, contact: AppointmentContactSelection?)
        case edit(CalendarAppointment)
    }

    let id = UUID()
    let kind: Kind
}
