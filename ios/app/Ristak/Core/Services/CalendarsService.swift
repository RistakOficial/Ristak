import Foundation

/// Endpoints tipados de Calendarios y Citas (doc research/07).
/// Todas las rutas exigen módulo `appointments`; los 403 llegan como
/// `RistakAPIError` con `kind == .accessDenied`.
enum CalendarsService {
    /// Límite backend de `GET /events`: 370 días por solicitud.
    static let maxEventsRangeDays = 370
    /// Límite backend de free-slots y blocked-slots: 45 días.
    static let maxAvailabilityRangeDays = 45

    // MARK: - Calendarios

    /// `GET /api/calendars`. `sourcePreference` = `combined|ristak|ghl`.
    static func calendars(sourcePreference: String? = nil) async throws -> [RistakCalendar] {
        try await APIClient.shared.get(
            "/api/calendars",
            query: ["sourcePreference": sourcePreference]
        )
    }

    /// `GET /api/calendars/:id` (busca por `id` o `ghl_calendar_id`).
    static func calendar(id: String) async throws -> RistakCalendar {
        try await APIClient.shared.get("/api/calendars/\(id)")
    }

    // MARK: - Citas / eventos

    /// `GET /api/calendars/events` — `startTime`/`endTime` en epoch MILLIS
    /// (strings numéricas). Rango máx 370 días. El backend filtra por hora de
    /// INICIO solamente (doc 07 §4).
    static func events(
        startTime: Date,
        endTime: Date,
        calendarID: String? = nil
    ) async throws -> [CalendarAppointment] {
        try await APIClient.shared.get(
            "/api/calendars/events",
            query: [
                "startTime": epochMillisString(startTime),
                "endTime": epochMillisString(endTime),
                "calendarId": calendarID,
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `GET /api/calendars/events/:eventId` — detalle (incluye `contactId`,
    /// `assignedUserId`).
    static func event(id: String) async throws -> CalendarAppointment {
        try await APIClient.shared.get("/api/calendars/events/\(id)")
    }

    /// `POST /api/calendars/appointments`. Por defecto responde 409
    /// `slot_unavailable` si el slot ya no tiene cupo. Personalizado manda
    /// `ignoreAppointmentConflicts: true` desde el primer intento.
    static func createAppointment(_ draft: AppointmentDraftRequest) async throws -> CalendarAppointment {
        try await APIClient.shared.post("/api/calendars/appointments", body: draft)
    }

    /// `PUT /api/calendars/appointments/:id` (parcial). El PUT legacy ordinario
    /// no valida choques; una reagenda con `strictAvailabilityCheck` sí lo hace.
    static func updateAppointment(id: String, _ draft: AppointmentDraftRequest) async throws -> CalendarAppointment {
        try await APIClient.shared.put("/api/calendars/appointments/\(id)", body: draft)
    }

    /// `DELETE /api/calendars/events/:id` → `{ success, message }` (sin data).
    static func deleteEvent(id: String) async throws {
        let _: APIAcknowledgment = try await APIClient.shared.delete("/api/calendars/events/\(id)")
    }

    // MARK: - Disponibilidad

    /// `GET /api/calendars/:id/free-slots` — `startDate`/`endDate` en
    /// `YYYY-MM-DD`, rango máx 45 días; `timezone` IANA opcional (mandar la
    /// zona de la CUENTA).
    static func freeSlots(
        calendarID: String,
        startDate: String,
        endDate: String,
        timezone: String? = nil
    ) async throws -> [CalendarFreeSlotDay] {
        try await APIClient.shared.get(
            "/api/calendars/\(calendarID)/free-slots",
            query: [
                "startDate": startDate,
                "endDate": endDate,
                "timezone": timezone,
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `GET /api/calendars/:calendarId/blocked-slots` — epoch millis, máx 45
    /// días. La respuesta puede venir en forma nativa (ISO) o GHL
    /// (`date` + `HH:mm`); `CalendarBlockedSlot` tolera ambas.
    static func blockedSlots(
        calendarID: String,
        startTime: Date,
        endTime: Date
    ) async throws -> [CalendarBlockedSlot] {
        try await APIClient.shared.get(
            "/api/calendars/\(calendarID)/blocked-slots",
            query: [
                "startTime": epochMillisString(startTime),
                "endTime": epochMillisString(endTime),
            ]
        )
    }

    // MARK: - Bloqueos (CRUD nativo local)

    /// `POST /api/calendars/block-slots` → bloqueo creado (201).
    static func createBlockedSlot(_ body: BlockedSlotSaveRequest) async throws -> CalendarBlockedSlot {
        try await APIClient.shared.post("/api/calendars/block-slots", body: body)
    }

    /// `PUT /api/calendars/block-slots/:id`; 404 «Bloqueo no encontrado».
    static func updateBlockedSlot(id: String, _ body: BlockedSlotSaveRequest) async throws -> CalendarBlockedSlot {
        try await APIClient.shared.put("/api/calendars/block-slots/\(id)", body: body)
    }

    /// `DELETE /api/calendars/block-slots/:id`.
    static func deleteBlockedSlot(id: String) async throws {
        let _: APIAcknowledgment = try await APIClient.shared.delete("/api/calendars/block-slots/\(id)")
    }

    // MARK: - Usuarios para asignación / Round Robin (doc 07 §2.4)

    /// `GET /api/highlevel/users` → `{ success, users }`. 400 sin config de
    /// HighLevel («No hay configuración de HighLevel activa») — en cuentas
    /// 100 % nativas no hay usuarios asignables (doc 07 gap 9).
    static func highLevelUsers() async throws -> [CalendarUser] {
        let envelope: CalendarUsersEnvelope = try await APIClient.shared.get("/api/highlevel/users")
        return envelope.users ?? []
    }

    /// `POST /api/highlevel/users/by-ids` `{ userIds }` → `{ success, users }`.
    static func highLevelUsers(ids: [String]) async throws -> [CalendarUser] {
        let envelope: CalendarUsersEnvelope = try await APIClient.shared.post(
            "/api/highlevel/users/by-ids",
            body: CalendarUsersByIDsRequest(userIds: ids)
        )
        return envelope.users ?? []
    }

    // MARK: - Recordatorios (doc 07 §2.5 — solo lectura en móvil)

    /// `GET /api/appointment-reminders` → `{ reminders, senders, channels }`.
    static func appointmentReminders() async throws -> AppointmentRemindersOverview {
        try await APIClient.shared.get("/api/appointment-reminders")
    }

    // MARK: - Helpers

    static func epochMillisString(_ date: Date) -> String {
        String(Int64((date.timeIntervalSince1970 * 1000).rounded()))
    }
}
