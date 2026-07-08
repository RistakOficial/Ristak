import Foundation
import SwiftUI

// Helpers de presentación de la ficha de contacto (doc 06 + reglas de display
// de docs 07/08 para los paneles embebidos). Todo prefijado `ContactInfo…`
// para no chocar con los módulos Pagos/Calendarios.

// MARK: - Etapa del contacto (status derivado, doc 06 §5.3 / §1.5)

/// `lead | appointment | customer` → etiqueta interna en español.
enum ContactInfoStage: Sendable {
    case lead
    case appointment
    case customer

    init(status: String) {
        switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "customer": self = .customer
        case "appointment": self = .appointment
        default: self = .lead
        }
    }

    /// Nombres default de las etiquetas internas (doc 06 §1.5).
    var label: String {
        switch self {
        case .customer: return "Cliente"
        case .appointment: return "Cita agendada"
        case .lead: return "Prospecto"
        }
    }

    var color: Color {
        switch self {
        case .customer: return RistakTheme.pos
        case .appointment: return RistakTheme.accent
        case .lead: return RistakTheme.info
        }
    }

    var softColor: Color {
        switch self {
        case .customer: return RistakTheme.posSoft
        case .appointment: return RistakTheme.accentSoft
        case .lead: return RistakTheme.infoSoft
        }
    }

    /// Id de etiqueta interna equivalente (`client`/`booked`/`lead`).
    var systemTagID: String {
        switch self {
        case .customer: return "client"
        case .appointment: return "booked"
        case .lead: return "lead"
        }
    }
}

// MARK: - Estados de pago embebido (labels /movil, doc 08 §6.1)

enum ContactInfoPaymentStatus {
    /// Estados que cuentan como recibidos en la UI móvil (`paid|partial`).
    static let receivedStatuses: Set<String> = ["paid", "partial", "succeeded", "completed", "complete", "fulfilled", "success"]

    static func normalized(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "succeeded", "completed", "complete", "fulfilled", "success": return "paid"
        default: return value
        }
    }

    static func label(_ raw: String) -> String {
        switch normalized(raw) {
        case "paid": return "Pagado"
        case "partial": return "Parcial"
        case "refunded": return "Reembolsado"
        case "failed": return "Fallido"
        case "pending": return "Pendiente"
        case "sent": return "Enviado"
        case "draft": return "Borrador"
        case "scheduled": return "Programado"
        case "overdue": return "Vencido"
        case "void": return "Anulado"
        case "deleted": return "Eliminado"
        case "": return "Sin estado"
        default: return raw.capitalized
        }
    }

    static func color(_ raw: String) -> Color {
        switch normalized(raw) {
        case "paid", "partial": return RistakTheme.pos
        case "failed", "overdue": return RistakTheme.neg
        case "pending", "sent", "scheduled": return RistakTheme.warn
        default: return RistakTheme.textDim
        }
    }
}

// MARK: - Estados de cita embebida (doc 07 §3.2)

enum ContactInfoAppointmentStatus {
    /// Estados que NO cuentan como cita activa (doc 03 §1.1).
    static let inactiveStatuses: Set<String> = [
        "cancelled", "canceled", "no_show", "noshow", "no-show", "invalid",
        "failed", "missed", "deleted", "void", "voided",
    ]

    /// Normalización cliente: `canceled`→`cancelled`, `no_show`→`noshow`.
    static func normalized(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "canceled": return "cancelled"
        case "no_show", "no-show": return "noshow"
        default: return value
        }
    }

    static func label(_ raw: String) -> String {
        switch normalized(raw) {
        case "pending": return "Pendiente"
        case "confirmed": return "Confirmada"
        case "cancelled": return "Cancelada"
        case "showed": return "Asistió"
        case "noshow": return "No asistió"
        case "rescheduled": return "Reprogramada"
        case "": return "Sin estado"
        default: return raw.capitalized
        }
    }

    static func color(_ raw: String) -> Color {
        switch normalized(raw) {
        case "confirmed", "showed": return RistakTheme.pos
        case "cancelled", "noshow": return RistakTheme.neg
        case "pending": return RistakTheme.warn
        case "rescheduled": return RistakTheme.info
        default: return RistakTheme.textDim
        }
    }

    static func isActive(_ raw: String) -> Bool {
        !inactiveStatuses.contains(raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}

// MARK: - Fechas de la ficha (zona horaria del NEGOCIO)

enum ContactInfoDates {
    /// `4 de julio de 2026` (es-MX, TZ del negocio).
    static func longDate(fromISO value: String?, timeZone: TimeZone) -> String {
        guard let date = RistakDateParsing.date(fromISO: value) else { return "" }
        var style = Date.FormatStyle(date: .long, time: .omitted)
        style.locale = BusinessFormatters.locale
        style.timeZone = timeZone
        return date.formatted(style)
    }

    /// `4 jul 2026, 7:47 p.m.` (es-MX, TZ del negocio).
    static func dateTime(fromISO value: String?, timeZone: TimeZone) -> String {
        guard let date = RistakDateParsing.date(fromISO: value) else { return "" }
        var style = Date.FormatStyle(date: .abbreviated, time: .shortened)
        style.locale = BusinessFormatters.locale
        style.timeZone = timeZone
        return date.formatted(style)
    }
}

// MARK: - Canal de conversión (etiqueta legible del origen)

/// Traduce el `source`/atribución crudo del contacto a un nombre de canal
/// legible ("WhatsApp", "Instagram", "Sitio web"…). Devuelve "" para orígenes
/// genéricos/vacíos (la fila se oculta cuando no hay canal identificable).
enum ContactInfoChannelLabel {
    private static let genericSources: Set<String> = ["directo", "desconocido", "otro", "unknown", "direct", "none"]

    static func friendly(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let lower = trimmed.lowercased()
        if genericSources.contains(lower) { return "" }

        // Sitio web / formularios / landings.
        if ["site", "web", "form", "landing", "pagina", "página"].contains(where: lower.contains) {
            return "Sitio web"
        }
        if let channel = RistakChatChannel(raw: trimmed) {
            switch channel {
            case .whatsapp: return "WhatsApp"
            case .facebook: return "Facebook"
            case .messenger: return "Messenger"
            case .instagram: return "Instagram"
            case .gmail: return "Correo"
            }
        }
        // Meta / otros: título legible (snake/kebab → palabras capitalizadas).
        return trimmed
            .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

// MARK: - Validación de teléfono (regla móvil, doc 06 §5.1)

enum ContactInfoPhoneValidation {
    /// Limpia no-dígitos (conserva `+` inicial) y valida `^\+?\d{7,15}$`.
    /// Devuelve el número limpio o `nil` si es inválido.
    static func normalized(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hasPlus = trimmed.hasPrefix("+")
        let digits = trimmed.filter { $0.isNumber }
        guard digits.count >= 7, digits.count <= 15 else { return nil }
        return (hasPlus ? "+" : "") + digits
    }

    static let invalidTitle = "Número incompleto"
    static let invalidMessage = "Revisa que el número tenga lada y entre 7 y 15 dígitos."
}

// MARK: - 409 de fusión (doc 06 §2.1 + audit)

/// Cuerpo crudo del 409 `merge_confirmation_required`
/// (`{ success:false, code, error, conflict: { field, contact } }`).
struct ContactInfoConflictPayload: Decodable, Sendable {
    struct Conflict: Decodable, Sendable {
        let field: String?
        let contact: ConflictContact?
    }

    struct ConflictContact: Decodable, Sendable {
        let id: String?
        let fullName: String?
        let phone: String?
        let email: String?

        enum CodingKeys: String, CodingKey {
            case id
            case fullName = "full_name"
            case phone, email
        }
    }

    let code: String?
    let error: String?
    let conflict: Conflict?
}

// MARK: - Valores de campos personalizados (doc 06 §1.3/§1.4 y §4.1.10)

enum ContactInfoCustomFieldValueFormat {
    /// Texto para mostrar un valor de campo personalizado (vacío = "Sin dato"
    /// lo pone la fila).
    static func displayString(
        _ value: RistakJSONValue?,
        dataType: String,
        options: [ContactFieldOption],
        formatters: BusinessFormatters
    ) -> String {
        guard let value else { return "" }
        switch value {
        case .null:
            return ""
        case .string(let raw):
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return "" }
            switch dataType {
            case "currency":
                if let number = Double(trimmed) {
                    return formatters.currency(number)
                }
                return trimmed
            case "date":
                let formatted = ContactInfoDates.longDate(fromISO: trimmed, timeZone: formatters.timeZone)
                return formatted.isEmpty ? trimmed : formatted
            case "datetime":
                let formatted = ContactInfoDates.dateTime(fromISO: trimmed, timeZone: formatters.timeZone)
                return formatted.isEmpty ? trimmed : formatted
            case "dropdown", "radio":
                return optionLabel(for: trimmed, options: options)
            default:
                return trimmed
            }
        case .number(let number):
            if dataType == "currency" {
                return formatters.currency(number)
            }
            if number == number.rounded(), abs(number) < 1e15 {
                return String(Int64(number))
            }
            return String(number)
        case .bool(let flag):
            return flag ? "Sí" : "No"
        case .array(let items):
            let parts = items.compactMap { item -> String? in
                let text = item.configStringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                guard let text, !text.isEmpty else { return nil }
                return optionLabel(for: text, options: options)
            }
            return parts.joined(separator: ", ")
        case .object:
            return value.configStringValue ?? ""
        }
    }

    static func optionLabel(for rawValue: String, options: [ContactFieldOption]) -> String {
        options.first { $0.value == rawValue }?.label ?? rawValue
    }

    /// Valores seleccionados de un campo multi-selección.
    static func selectedValues(_ value: RistakJSONValue?) -> [String] {
        switch value {
        case .array(let items):
            return items.compactMap { $0.configStringValue }.filter { !$0.isEmpty }
        case .string(let raw):
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [trimmed]
        default:
            return []
        }
    }
}

// MARK: - Filas compartidas de la ficha

/// Fila etiqueta/valor estándar de la ficha (sin cajas anidadas).
struct ContactInfoRow: View {
    let label: String
    let value: String
    var placeholder: String = "Sin dato"

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.sm) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
                .frame(width: 112, alignment: .leading)

            Text(value.isEmpty ? placeholder : value)
                .font(.subheadline)
                .foregroundStyle(value.isEmpty ? RistakTheme.textMute : RistakTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Badge de etapa (relleno tonal suave; no es un control seleccionable).
struct ContactInfoStageBadge: View {
    let stage: ContactInfoStage

    var body: some View {
        Text(stage.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(stage.color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(stage.softColor))
            .accessibilityLabel("Etapa: \(stage.label)")
    }
}
