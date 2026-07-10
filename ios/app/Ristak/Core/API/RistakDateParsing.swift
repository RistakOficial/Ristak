import Foundation

/// Parsing centralizado de fechas del backend Ristak.
/// El backend mezcla: ISO 8601 UTC (`2026-06-29T21:00:00.000Z`), timestamps
/// SQLite (`2026-07-01 12:00:00`, UTC), fechas de negocio (`2026-07-04`) y
/// epoch en milisegundos (calendarios).
enum RistakDateParsing {
    nonisolated(unsafe) private static let isoWithFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let sqlite: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    private static let dateOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Caché de parseos (string → Date). Un timestamp del backend siempre mapea a
    /// la MISMA fecha, así que memoizar es seguro y determinístico. Evita reprobar
    /// hasta 4 formatters de Foundation por llamada: `ChatMessage.parsedDate` se
    /// invoca miles de veces por poll al ordenar hilos largos. `NSCache` está
    /// sincronizado internamente (thread-safe) y se auto-purga bajo presión.
    nonisolated(unsafe) private static let parseCache: NSCache<NSString, NSDate> = {
        let cache = NSCache<NSString, NSDate>()
        cache.countLimit = 4000
        return cache
    }()

    /// Intenta parsear cualquiera de los formatos de fecha string del backend.
    static func date(fromISO value: String?) -> Date? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let key = trimmed as NSString
        if let cached = parseCache.object(forKey: key) { return cached as Date }

        let parsed: Date?
        if let date = isoWithFractional.date(from: trimmed) { parsed = date }
        else if let date = iso.date(from: trimmed) { parsed = date }
        else if let date = sqlite.date(from: trimmed) { parsed = date }
        else if let date = dateOnly.date(from: trimmed) { parsed = date }
        // Último recurso: número serializado como string (epoch).
        else if let epoch = Double(trimmed) { parsed = date(fromEpoch: epoch) }
        else { parsed = nil }

        if let parsed { parseCache.setObject(parsed as NSDate, forKey: key) }
        return parsed
    }

    /// Epoch tolerante: valores grandes (>1e11) se interpretan como milisegundos,
    /// el resto como segundos.
    static func date(fromEpoch value: Double) -> Date? {
        guard value.isFinite, value > 0 else { return nil }
        if value > 1e11 {
            return Date(timeIntervalSince1970: value / 1000)
        }
        return Date(timeIntervalSince1970: value)
    }

    static func date(fromEpochMilliseconds value: Double) -> Date? {
        guard value.isFinite, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value / 1000)
    }

    /// Fecha desde un valor JSON arbitrario (string ISO o número epoch).
    static func date(fromJSONValue value: RistakJSONValue?) -> Date? {
        switch value {
        case .string(let string): return date(fromISO: string)
        case .number(let number): return date(fromEpoch: number)
        default: return nil
        }
    }

    /// ISO 8601 UTC con milisegundos, como espera el backend (`scheduledAt`, etc.).
    static func isoString(from date: Date) -> String {
        isoWithFractional.string(from: date)
    }

    /// Fecha de negocio `YYYY-MM-DD` en la zona horaria dada (rangos de reportes).
    static func businessDateString(from date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
