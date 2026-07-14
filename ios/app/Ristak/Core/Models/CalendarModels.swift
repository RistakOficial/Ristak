import Foundation

// MARK: - Estados de cita (doc 07 §3.2)

/// Enum de `appointmentStatus` con etiquetas en español y colores del modal web.
enum AppointmentStatus: String, Codable, CaseIterable, Sendable, Equatable {
    case pending
    case confirmed
    case cancelled
    case showed
    case noshow
    case rescheduled

    /// Normalización del cliente (paridad RN): `canceled`→`cancelled`,
    /// `no_show`/`no-show`→`noshow`. Valores desconocidos → nil.
    static func normalize(_ raw: String?) -> AppointmentStatus? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "canceled": return .cancelled
        case "no_show", "no-show": return .noshow
        default: return AppointmentStatus(rawValue: value)
        }
    }

    var displayLabel: String {
        switch self {
        case .pending: return "Pendiente"
        case .confirmed: return "Confirmada"
        case .cancelled: return "Cancelada"
        case .showed: return "Asistió"
        case .noshow: return "No asistió"
        case .rescheduled: return "Reprogramada"
        }
    }

    /// Color hex de referencia del modal web (`AppointmentModal.tsx:92-99`).
    var referenceColorHex: String {
        switch self {
        case .pending: return "#f97316"
        case .confirmed: return "#22c55e"
        case .cancelled: return "#ef4444"
        case .showed: return "#2563eb"
        case .noshow: return "#6b7280"
        case .rescheduled: return "#8b5cf6"
        }
    }
}

// MARK: - Calendario (doc 07 §3.1)

/// Intervalo de apertura dentro de un día (`openHours[].hours[]`).
struct CalendarOpenInterval: Codable, Sendable, Equatable {
    let openHour: Int
    let openMinute: Int
    let closeHour: Int
    let closeMinute: Int

    enum CodingKeys: String, CodingKey {
        case openHour, openMinute, closeHour, closeMinute
    }

    init(openHour: Int, openMinute: Int, closeHour: Int, closeMinute: Int) {
        self.openHour = openHour
        self.openMinute = openMinute
        self.closeHour = closeHour
        self.closeMinute = closeMinute
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        openHour = container.flexibleInt(forKey: .openHour) ?? 0
        openMinute = container.flexibleInt(forKey: .openMinute) ?? 0
        closeHour = container.flexibleInt(forKey: .closeHour) ?? 0
        closeMinute = container.flexibleInt(forKey: .closeMinute) ?? 0
    }
}

/// Regla de horario del calendario. Tolerante a las 3 formas del backend
/// (doc 07 §2.3): `{ daysOfTheWeek:[…], hours:[…] }`, forma plana `{ day }` /
/// `{ dayOfWeek }` con horas al nivel raíz, e ISO 7→0 (0 = domingo).
struct CalendarOpenHoursRule: Codable, Sendable, Equatable {
    /// Días 0–6, 0 = domingo (como `Date.getDay()` de JS).
    let daysOfTheWeek: [Int]
    let hours: [CalendarOpenInterval]

    enum CodingKeys: String, CodingKey {
        case daysOfTheWeek, day, dayOfWeek, hours
        case openHour, openMinute, closeHour, closeMinute
    }

    init(daysOfTheWeek: [Int], hours: [CalendarOpenInterval]) {
        self.daysOfTheWeek = daysOfTheWeek
        self.hours = hours
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        var days: [Int] = []
        if let rawDays = try? container.decodeIfPresent([RistakJSONValue].self, forKey: .daysOfTheWeek) {
            days = rawDays.compactMap { $0.intValue }
        }
        if days.isEmpty, let day = container.flexibleInt(forKey: .day) {
            days = [day]
        }
        if days.isEmpty, let day = container.flexibleInt(forKey: .dayOfWeek) {
            days = [day]
        }
        // ISO 7 = domingo → 0.
        daysOfTheWeek = days.map { $0 == 7 ? 0 : $0 }.filter { (0...6).contains($0) }

        if let parsedHours = try? container.decodeIfPresent([CalendarOpenInterval].self, forKey: .hours),
           !parsedHours.isEmpty {
            hours = parsedHours
        } else if let openHour = container.flexibleInt(forKey: .openHour) {
            hours = [
                CalendarOpenInterval(
                    openHour: openHour,
                    openMinute: container.flexibleInt(forKey: .openMinute) ?? 0,
                    closeHour: container.flexibleInt(forKey: .closeHour) ?? 0,
                    closeMinute: container.flexibleInt(forKey: .closeMinute) ?? 0
                ),
            ]
        } else {
            hours = []
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(daysOfTheWeek, forKey: .daysOfTheWeek)
        try container.encode(hours, forKey: .hours)
    }
}

/// Miembro del equipo del calendario (round robin).
struct CalendarTeamMember: Codable, Sendable, Equatable {
    let userId: String
    let priority: Int?
    let isPrimary: Bool?

    enum CodingKeys: String, CodingKey {
        case userId, priority, isPrimary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        userId = container.flexibleString(forKey: .userId) ?? ""
        priority = container.flexibleInt(forKey: .priority)
        isPrimary = container.flexibleBool(forKey: .isPrimary)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encodeIfPresent(priority, forKey: .priority)
        try container.encodeIfPresent(isPrimary, forKey: .isPrimary)
    }
}

/// Calendario (respuesta de `GET /api/calendars`; `calendarRowToApi`).
/// ⚠️ `appoinmentPerSlot` viaja con typo INTENCIONAL en el JSON.
struct RistakCalendar: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let ghlCalendarId: String?
    let googleCalendarId: String
    let googleSyncEnabled: Bool
    let locationId: String
    let groupId: String?
    let name: String
    let description: String
    let slug: String
    let widgetSlug: String
    /// `'event'` default; `'round_robin'` activa asignación obligatoria al crear.
    let calendarType: String
    let eventTitle: String
    let eventColor: String
    let isActive: Bool
    let teamMembers: [CalendarTeamMember]
    let slotDuration: Int
    let slotDurationUnit: String
    let slotInterval: Int
    let slotIntervalUnit: String
    /// sic — typo intencional del backend (`appoinmentPerSlot`). Default 1.
    let appoinmentPerSlot: Int
    let appoinmentPerDay: Int
    let openHours: [CalendarOpenHoursRule]
    let autoConfirm: Bool
    let allowReschedule: Bool
    let allowCancellation: Bool
    let notes: String
    let source: String
    let syncStatus: String?
    let syncError: String?
    let createdAt: String?
    let updatedAt: String?
    let publicUrl: String?
    let publicUrlEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case id, ghlCalendarId, googleCalendarId, googleSyncEnabled, locationId, groupId
        case name, description, slug, widgetSlug, calendarType, eventTitle, eventColor
        case isActive, teamMembers, slotDuration, slotDurationUnit, slotInterval, slotIntervalUnit
        case appoinmentPerSlot, appoinmentPerDay, openHours
        case autoConfirm, allowReschedule, allowCancellation, notes
        case source, syncStatus, syncError, createdAt, updatedAt
        case publicUrl, publicUrlEnabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        ghlCalendarId = container.flexibleString(forKey: .ghlCalendarId)
        googleCalendarId = container.flexibleString(forKey: .googleCalendarId) ?? ""
        googleSyncEnabled = container.flexibleBool(forKey: .googleSyncEnabled) ?? false
        locationId = container.flexibleString(forKey: .locationId) ?? ""
        groupId = container.flexibleString(forKey: .groupId)
        name = container.flexibleString(forKey: .name) ?? "Calendario"
        description = container.flexibleString(forKey: .description) ?? ""
        slug = container.flexibleString(forKey: .slug) ?? ""
        widgetSlug = container.flexibleString(forKey: .widgetSlug) ?? ""
        calendarType = container.flexibleString(forKey: .calendarType) ?? "event"
        eventTitle = container.flexibleString(forKey: .eventTitle) ?? ""
        eventColor = container.flexibleString(forKey: .eventColor) ?? ""
        isActive = container.flexibleBool(forKey: .isActive) ?? true
        teamMembers = (try? container.decodeIfPresent([CalendarTeamMember].self, forKey: .teamMembers)) ?? []
        let duration = container.flexibleInt(forKey: .slotDuration) ?? 60
        slotDuration = duration
        slotDurationUnit = container.flexibleString(forKey: .slotDurationUnit) ?? "mins"
        slotInterval = container.flexibleInt(forKey: .slotInterval) ?? duration
        slotIntervalUnit = container.flexibleString(forKey: .slotIntervalUnit) ?? "mins"
        appoinmentPerSlot = container.flexibleInt(forKey: .appoinmentPerSlot) ?? 1
        appoinmentPerDay = container.flexibleInt(forKey: .appoinmentPerDay) ?? 0
        openHours = (try? container.decodeIfPresent([CalendarOpenHoursRule].self, forKey: .openHours)) ?? []
        autoConfirm = container.flexibleBool(forKey: .autoConfirm) ?? true
        allowReschedule = container.flexibleBool(forKey: .allowReschedule) ?? true
        allowCancellation = container.flexibleBool(forKey: .allowCancellation) ?? true
        notes = container.flexibleString(forKey: .notes) ?? ""
        source = container.flexibleString(forKey: .source) ?? "ristak"
        syncStatus = container.flexibleString(forKey: .syncStatus)
        syncError = container.flexibleString(forKey: .syncError)
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        publicUrl = container.flexibleString(forKey: .publicUrl)
        publicUrlEnabled = container.flexibleBool(forKey: .publicUrlEnabled)
    }

    /// `round_robin` exige `assignedUserId` al crear (regla de cliente, doc 07 §5.3).
    var isRoundRobin: Bool { calendarType == "round_robin" }
    var isGHLSynced: Bool { !(ghlCalendarId ?? "").isEmpty }
}

// MARK: - Cita (doc 07 §3.2)

struct CalendarAppointment: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let ghlAppointmentId: String?
    let googleEventId: String?
    let calendarId: String
    let locationId: String
    let contactId: String?
    let title: String
    /// Espejo crudo de `appointmentStatus`.
    let status: String
    let appointmentStatusRaw: String
    let assignedUserId: String?
    let notes: String
    let address: String
    let startTime: String
    let endTime: String
    let dateAdded: String?
    let dateUpdated: String?
    let source: String
    let syncStatus: String?
    let syncError: String?
    let contactName: String
    let contactEmail: String
    let contactPhone: String

    enum CodingKeys: String, CodingKey {
        case id, ghlAppointmentId, googleEventId, calendarId, locationId, contactId
        case title, status, assignedUserId, notes, address
        case startTime, endTime, dateAdded, dateUpdated
        case source, syncStatus, syncError
        case contactName, contactEmail, contactPhone
        case appointmentStatusRaw = "appointmentStatus"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        ghlAppointmentId = container.flexibleString(forKey: .ghlAppointmentId)
        googleEventId = container.flexibleString(forKey: .googleEventId)
        calendarId = container.flexibleString(forKey: .calendarId) ?? ""
        locationId = container.flexibleString(forKey: .locationId) ?? ""
        contactId = container.flexibleString(forKey: .contactId)
        title = container.flexibleString(forKey: .title) ?? "(Sin título)"
        appointmentStatusRaw = container.flexibleString(forKey: .appointmentStatusRaw) ?? "confirmed"
        status = container.flexibleString(forKey: .status) ?? appointmentStatusRaw
        assignedUserId = container.flexibleString(forKey: .assignedUserId)
        notes = container.flexibleString(forKey: .notes) ?? ""
        address = container.flexibleString(forKey: .address) ?? ""
        startTime = container.flexibleString(forKey: .startTime) ?? ""
        endTime = container.flexibleString(forKey: .endTime) ?? ""
        dateAdded = container.flexibleString(forKey: .dateAdded)
        dateUpdated = container.flexibleString(forKey: .dateUpdated)
        source = container.flexibleString(forKey: .source) ?? "ristak"
        syncStatus = container.flexibleString(forKey: .syncStatus)
        syncError = container.flexibleString(forKey: .syncError)
        contactName = container.flexibleString(forKey: .contactName) ?? ""
        contactEmail = container.flexibleString(forKey: .contactEmail) ?? ""
        contactPhone = container.flexibleString(forKey: .contactPhone) ?? ""
    }

    /// Estado normalizado (`canceled`→`cancelled`, `no_show`→`noshow`).
    var appointmentStatus: AppointmentStatus? {
        AppointmentStatus.normalize(appointmentStatusRaw)
    }

    var startDate: Date? { RistakDateParsing.date(fromISO: startTime) }
    var endDate: Date? { RistakDateParsing.date(fromISO: endTime) }
}

// MARK: - Body de crear/editar cita (doc 07 §2.2.1)

/// Body exacto de `POST/PUT /api/calendars/appointments`. Los `nil` se omiten.
struct AppointmentDraftRequest: Encodable, Sendable {
    var calendarId: String?
    var contactId: String?
    var title: String?
    var appointmentStatus: String?
    /// ISO UTC (`2026-07-08T16:00:00.000Z`).
    var startTime: String?
    var endTime: String?
    /// Informativo; mandar `account_timezone`.
    var timeZone: String?
    /// Notas + bloque `Invitados:` serializado (ver `AppointmentGuestNotesCodec`).
    var notes: String?
    var address: String?
    var assignedUserId: String?
    /// `true` exige que el horario siga perteneciendo a la disponibilidad del calendario.
    var strictAvailabilityCheck: Bool?
    /// `true` fuerza sobreagendar tras un 409 sólo cuando no hay candado estricto.
    var ignoreAppointmentConflicts: Bool?

    init(
        calendarId: String? = nil,
        contactId: String? = nil,
        title: String? = nil,
        appointmentStatus: String? = nil,
        startTime: String? = nil,
        endTime: String? = nil,
        timeZone: String? = nil,
        notes: String? = nil,
        address: String? = nil,
        assignedUserId: String? = nil,
        strictAvailabilityCheck: Bool? = nil,
        ignoreAppointmentConflicts: Bool? = nil
    ) {
        self.calendarId = calendarId
        self.contactId = contactId
        self.title = title
        self.appointmentStatus = appointmentStatus
        self.startTime = startTime
        self.endTime = endTime
        self.timeZone = timeZone
        self.notes = notes
        self.address = address
        self.assignedUserId = assignedUserId
        self.strictAvailabilityCheck = strictAvailabilityCheck
        self.ignoreAppointmentConflicts = ignoreAppointmentConflicts
    }
}

// MARK: - 409 slot_unavailable (doc 07 §5.1)

extension RistakAPIError {
    /// `POST /api/calendars/appointments` → 409 `code:"slot_unavailable"`.
    /// Mensaje del backend: «Ese horario ya alcanzó el límite de citas…».
    /// Reintentar con `ignoreAppointmentConflicts: true` sobreagenda únicamente
    /// en modo personalizado/legacy; un request estricto no permite el override.
    var isSlotUnavailable: Bool {
        status == 409 && code == "slot_unavailable"
    }
}

// MARK: - Disponibilidad y bloqueos (doc 07 §2.3, §3.3)

/// Un día de `GET /api/calendars/:id/free-slots`.
struct CalendarFreeSlotDay: Decodable, Sendable, Equatable {
    /// `YYYY-MM-DD` en la zona pedida.
    let date: String
    /// Inicios de slot en ISO UTC.
    let slots: [String]
    let timezone: String

    enum CodingKeys: String, CodingKey {
        case date, slots, timezone
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        date = container.flexibleString(forKey: .date) ?? ""
        slots = (try? container.decodeIfPresent([String].self, forKey: .slots)) ?? []
        timezone = container.flexibleString(forKey: .timezone) ?? ""
    }
}

/// Bloqueo de horario. Tolerante a las DOS formas del backend (doc 07 gap 10):
/// - Nativa: `{ id, calendarId, startTime: ISO, endTime: ISO, title }`.
/// - GHL: `{ id?, date: "YYYY-MM-DD", startTime: "HH:mm", endTime: "HH:mm",
///   reason?, blockedBy?, startIso?, endIso? }`.
struct CalendarBlockedSlot: Decodable, Sendable, Equatable {
    let id: String?
    let calendarId: String?
    let startTime: String?
    let endTime: String?
    let title: String?
    let date: String?
    let reason: String?
    let blockedBy: String?
    let startIso: String?
    let endIso: String?

    enum CodingKeys: String, CodingKey {
        case id, calendarId, startTime, endTime, title, date, reason, blockedBy, startIso, endIso
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        calendarId = container.flexibleString(forKey: .calendarId)
        startTime = container.flexibleString(forKey: .startTime)
        endTime = container.flexibleString(forKey: .endTime)
        title = container.flexibleString(forKey: .title)
        date = container.flexibleString(forKey: .date)
        reason = container.flexibleString(forKey: .reason)
        blockedBy = container.flexibleString(forKey: .blockedBy)
        startIso = container.flexibleString(forKey: .startIso)
        endIso = container.flexibleString(forKey: .endIso)
    }

    /// Inicio resuelto: ISO nativo / `startIso` GHL.
    var resolvedStartDate: Date? {
        RistakDateParsing.date(fromISO: startIso) ?? RistakDateParsing.date(fromISO: startTime)
    }

    var resolvedEndDate: Date? {
        RistakDateParsing.date(fromISO: endIso) ?? RistakDateParsing.date(fromISO: endTime)
    }

    /// Mensaje para la alerta «Horario bloqueado» (paridad RN
    /// `getDraftBlockedConflict`).
    var conflictMessage: String {
        if let reason, !reason.isEmpty { return reason }
        if let title, !title.isEmpty { return title }
        return "Este horario no está disponible. Selecciona otro horario."
    }
}

/// Body de `POST/PUT /api/calendars/block-slots` (acepta ISO o epoch).
struct BlockedSlotSaveRequest: Encodable, Sendable {
    var calendarId: String?
    var startTime: String?
    var endTime: String?
    var title: String?

    init(calendarId: String? = nil, startTime: String? = nil, endTime: String? = nil, title: String? = nil) {
        self.calendarId = calendarId
        self.startTime = startTime
        self.endTime = endTime
        self.title = title
    }
}

// MARK: - Usuarios asignables / Round Robin (doc 07 §2.4)

/// `CalendarUser` de `/api/highlevel/users` (shape RN `types.ts:784-792`).
struct CalendarUser: Decodable, Sendable, Equatable {
    let id: String?
    let underscoreId: String?
    let userId: String?
    let name: String?
    let firstName: String?
    let lastName: String?
    let email: String?

    enum CodingKeys: String, CodingKey {
        case id, userId, name, firstName, lastName, email
        case underscoreId = "_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        underscoreId = container.flexibleString(forKey: .underscoreId)
        userId = container.flexibleString(forKey: .userId)
        name = container.flexibleString(forKey: .name)
        firstName = container.flexibleString(forKey: .firstName)
        lastName = container.flexibleString(forKey: .lastName)
        email = container.flexibleString(forKey: .email)
    }

    var resolvedID: String {
        for candidate in [id, underscoreId, userId] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return ""
    }

    /// Label: `name` → `firstName lastName` → `email` → id (RN `App.tsx:6703-6710`).
    var displayLabel: String {
        if let name, !name.isEmpty { return name }
        let composed = [firstName, lastName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        if !composed.isEmpty { return composed }
        if let email, !email.isEmpty { return email }
        return resolvedID
    }
}

/// Body de `POST /api/highlevel/users/by-ids`.
struct CalendarUsersByIDsRequest: Encodable, Sendable {
    let userIds: [String]
}

/// Respuesta `{ success, users }` de los endpoints de usuarios HighLevel.
struct CalendarUsersEnvelope: Decodable, Sendable {
    let success: Bool?
    let users: [CalendarUser]?

    enum CodingKeys: String, CodingKey {
        case success, users
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        users = try? container.decodeIfPresent([CalendarUser].self, forKey: .users)
    }
}

// MARK: - Invitados en notas (doc 07 §5.4)

struct AppointmentGuestEntry: Sendable, Equatable, Hashable {
    var name: String
    var contact: String
}

/// Serializador/parser del bloque `Invitados:` embebido en `notes`.
/// El formato debe replicarse byte a byte para interoperar con web/RN:
/// ```
/// <notas>
///
/// Invitados:
/// - Nombre Uno: +5215512345678
/// - Nombre Dos: correo@dominio.com
/// ```
enum AppointmentGuestNotesCodec {
    /// Header exacto (`APPOINTMENT_GUESTS_NOTE_HEADER`).
    static let header = "Invitados:"

    /// Compone `notes` finales con el bloque de invitados. Duplicados por
    /// `contact` (case-insensitive) se ignoran.
    static func compose(notes: String, guests: [AppointmentGuestEntry]) -> String {
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        var seen = Set<String>()
        var lines: [String] = []
        for guest in guests {
            let name = guest.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let contact = guest.contact.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, !contact.isEmpty else { continue }
            let key = contact.lowercased()
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            lines.append("- \(name): \(contact)")
        }
        guard !lines.isEmpty else { return trimmedNotes }
        let block = "\(header)\n" + lines.joined(separator: "\n")
        if trimmedNotes.isEmpty { return block }
        return trimmedNotes + "\n\n" + block
    }

    /// Separa las notas del usuario y los invitados. Busca el ÚLTIMO bloque
    /// `\n\nInvitados:\n` (o el string que empieza con `Invitados:\n`).
    static func parse(notes rawNotes: String?) -> (notes: String, guests: [AppointmentGuestEntry]) {
        guard let rawNotes, !rawNotes.isEmpty else { return ("", []) }

        var userNotes = rawNotes
        var guestBlock: Substring?

        let separator = "\n\n\(header)\n"
        if let range = rawNotes.range(of: separator, options: .backwards) {
            userNotes = String(rawNotes[..<range.lowerBound])
            guestBlock = rawNotes[range.upperBound...]
        } else if rawNotes.hasPrefix("\(header)\n") {
            userNotes = ""
            guestBlock = rawNotes.dropFirst(header.count + 1)
        }

        guard let guestBlock else {
            return (rawNotes.trimmingCharacters(in: .whitespacesAndNewlines), [])
        }

        var guests: [AppointmentGuestEntry] = []
        var seen = Set<String>()
        let lineRegex = #/^-\s*(.+?):\s*(.+)$/#
        for line in guestBlock.split(separator: "\n", omittingEmptySubsequences: true) {
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)
            guard let match = try? lineRegex.wholeMatch(in: trimmedLine) else { continue }
            let name = String(match.1).trimmingCharacters(in: .whitespaces)
            let contact = String(match.2).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, !contact.isEmpty else { continue }
            let key = contact.lowercased()
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            guests.append(AppointmentGuestEntry(name: name, contact: contact))
        }
        return (userNotes.trimmingCharacters(in: .whitespacesAndNewlines), guests)
    }
}

// MARK: - Recordatorios de citas (doc 07 §2.5, §3.4 — solo lectura en móvil)

struct AppointmentReminderDeliveryHealth: Decodable, Sendable, Equatable {
    /// `'paused' | 'error' | 'warning' | 'ready'`.
    let status: String?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case status, message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = container.flexibleString(forKey: .status)
        message = container.flexibleString(forKey: .message)
    }
}

struct AppointmentReminderFailures: Decodable, Sendable, Equatable {
    let errorCount: Int
    let lastErrorAt: String?
    let lastErrorMessage: String?

    enum CodingKeys: String, CodingKey {
        case errorCount, lastErrorAt, lastErrorMessage
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        errorCount = container.flexibleInt(forKey: .errorCount) ?? 0
        lastErrorAt = container.flexibleString(forKey: .lastErrorAt)
        lastErrorMessage = container.flexibleString(forKey: .lastErrorMessage)
    }
}

/// Mensaje automático de cita (`normalizeReminderRow`). Modelo de LECTURA.
struct AppointmentReminder: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let enabled: Bool
    /// `'reminder' | 'confirmation'`.
    let messageType: String
    let aiEnabled: Bool
    /// Único canal hoy: `'whatsapp'`.
    let channel: String
    /// `'contact' | 'default' | 'specific'`.
    let senderMode: String
    let senderPhoneNumberId: String?
    let templateId: String?
    let templateName: String?
    let templateLanguage: String
    /// `'before_appointment' | 'after_booking'`.
    let timingAnchor: String
    let offsetValue: Int
    let offsetUnit: String
    let messageText: String
    let smartEnabled: Bool
    let smartStart: String
    let smartEnd: String
    /// `'before' | 'next_day'`.
    let smartOverflow: String
    let noConfirmAction: String
    let confirmationSuccessAction: String
    let bypassAutomations: Bool
    let qrFallbackEnabled: Bool
    let position: Int
    let createdAt: String?
    let updatedAt: String?
    /// Solo en overview.
    let deliveryHealth: AppointmentReminderDeliveryHealth?
    let failures: AppointmentReminderFailures?

    enum CodingKeys: String, CodingKey {
        case id, name, enabled, messageType, aiEnabled, channel
        case senderMode, senderPhoneNumberId, templateId, templateName, templateLanguage
        case timingAnchor, offsetValue, offsetUnit, messageText
        case smartEnabled, smartStart, smartEnd, smartOverflow
        case noConfirmAction, confirmationSuccessAction
        case bypassAutomations, qrFallbackEnabled, position
        case createdAt, updatedAt, deliveryHealth, failures
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        name = container.flexibleString(forKey: .name) ?? ""
        enabled = container.flexibleBool(forKey: .enabled) ?? false
        messageType = container.flexibleString(forKey: .messageType) ?? "reminder"
        aiEnabled = container.flexibleBool(forKey: .aiEnabled) ?? false
        channel = container.flexibleString(forKey: .channel) ?? "whatsapp"
        senderMode = container.flexibleString(forKey: .senderMode) ?? "default"
        senderPhoneNumberId = container.flexibleString(forKey: .senderPhoneNumberId)
        templateId = container.flexibleString(forKey: .templateId)
        templateName = container.flexibleString(forKey: .templateName)
        templateLanguage = container.flexibleString(forKey: .templateLanguage) ?? "es_MX"
        timingAnchor = container.flexibleString(forKey: .timingAnchor) ?? "before_appointment"
        offsetValue = container.flexibleInt(forKey: .offsetValue) ?? 1
        offsetUnit = container.flexibleString(forKey: .offsetUnit) ?? "days"
        messageText = container.flexibleString(forKey: .messageText) ?? ""
        smartEnabled = container.flexibleBool(forKey: .smartEnabled) ?? false
        smartStart = container.flexibleString(forKey: .smartStart) ?? "09:00"
        smartEnd = container.flexibleString(forKey: .smartEnd) ?? "21:00"
        smartOverflow = container.flexibleString(forKey: .smartOverflow) ?? "before"
        noConfirmAction = container.flexibleString(forKey: .noConfirmAction) ?? "no_action"
        confirmationSuccessAction = container.flexibleString(forKey: .confirmationSuccessAction) ?? "mark_confirmed"
        bypassAutomations = container.flexibleBool(forKey: .bypassAutomations) ?? false
        qrFallbackEnabled = container.flexibleBool(forKey: .qrFallbackEnabled) ?? false
        position = container.flexibleInt(forKey: .position) ?? 0
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        deliveryHealth = try? container.decodeIfPresent(AppointmentReminderDeliveryHealth.self, forKey: .deliveryHealth)
        failures = try? container.decodeIfPresent(AppointmentReminderFailures.self, forKey: .failures)
    }
}

/// Remitente disponible para recordatorios.
struct AppointmentReminderSender: Decodable, Sendable, Equatable {
    let id: String
    let phone: String?
    let name: String?
    let isDefault: Bool
    let apiEnabled: Bool
    let qrConnected: Bool

    enum CodingKeys: String, CodingKey {
        case id, phone, name, isDefault, apiEnabled, qrConnected
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        phone = container.flexibleString(forKey: .phone)
        name = container.flexibleString(forKey: .name)
        isDefault = container.flexibleBool(forKey: .isDefault) ?? false
        apiEnabled = container.flexibleBool(forKey: .apiEnabled) ?? false
        qrConnected = container.flexibleBool(forKey: .qrConnected) ?? false
    }
}

struct AppointmentReminderChannelInfo: Decodable, Sendable, Equatable {
    let id: String
    let label: String
    let connected: Bool

    enum CodingKeys: String, CodingKey {
        case id, label, connected
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        label = container.flexibleString(forKey: .label) ?? ""
        connected = container.flexibleBool(forKey: .connected) ?? false
    }
}

/// `GET /api/appointment-reminders` → `data`.
struct AppointmentRemindersOverview: Decodable, Sendable {
    let reminders: [AppointmentReminder]
    let senders: [AppointmentReminderSender]
    let channels: [AppointmentReminderChannelInfo]

    enum CodingKeys: String, CodingKey {
        case reminders, senders, channels
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reminders = (try? container.decodeIfPresent([AppointmentReminder].self, forKey: .reminders)) ?? []
        senders = (try? container.decodeIfPresent([AppointmentReminderSender].self, forKey: .senders)) ?? []
        channels = (try? container.decodeIfPresent([AppointmentReminderChannelInfo].self, forKey: .channels)) ?? []
    }
}
