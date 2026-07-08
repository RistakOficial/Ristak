import Foundation
import Observation

/// ViewModel del formulario Agendar/Editar cita (doc 07 §6.1 flujo Nueva cita).
/// Reglas de negocio implementadas:
/// - Estado inicial por `autoConfirm` del calendario (regla del modal web,
///   doc 07 §7.8: `pending` salvo autoConfirm).
/// - Round Robin exige `assignedUserId` al crear (validación de cliente).
/// - Pre-chequeo de bloqueos nativos antes del POST (silencioso si el fetch
///   falla, paridad web/RN).
/// - 409 `slot_unavailable` → ofrecer «Crear de todos modos»
///   (`ignoreAppointmentConflicts`, paridad web).
/// - Invitados serializados en `notes` con el bloque `Invitados:`.
@MainActor
@Observable
final class AppointmentFormViewModel {
    enum EntryMode: String, CaseIterable, Identifiable {
        case defaultSlots
        case custom

        var id: String { rawValue }

        var title: String {
            switch self {
            case .defaultSlots: return "Por defecto"
            case .custom: return "Personalizado"
            }
        }
    }

    enum SlotsPhase: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    enum TeamPhase: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    struct FormAlert: Identifiable {
        let id = UUID()
        var title: String
        var message: String
        /// `true` → alerta 409 con acción «Crear de todos modos».
        var offersOverbook = false
    }

    // MARK: Contexto

    let timeZone: TimeZone
    let isEdit: Bool
    let calendars: [RistakCalendar]
    private(set) var editingAppointment: CalendarAppointment?
    /// Contacto de la cita (bloqueado en edición y en deep links).
    private(set) var contact: AppointmentContactSelection?

    // MARK: Campos

    private(set) var selectedCalendarID: String
    private(set) var status: AppointmentStatus
    var assignedUserID: String?
    var entryMode: EntryMode
    /// Fecha (modo Personalizado) en día de negocio.
    var day: CalendarBusinessDay
    var hour12: Int
    var minute: Int
    var isPM: Bool
    var durationHours: Int
    var durationMinutesPart: Int
    var address: String
    var notesText: String
    var guests: [AppointmentGuestEntry]

    // MARK: Slots «Por defecto»

    private(set) var slotsPhase: SlotsPhase = .idle
    private(set) var slotDays: [CalendarFreeSlotDay] = []
    var selectedSlotDate: String?
    var selectedSlotISO: String?

    // MARK: Equipo (Round Robin)

    private(set) var teamPhase: TeamPhase = .idle
    private(set) var team: [CalendarUser] = []

    // MARK: Estado de guardado

    private(set) var busy = false
    var alert: FormAlert?
    /// Contador para `sensoryFeedback(.success)` al guardar.
    private(set) var saveSuccessCount = 0

    private var statusTouched = false

    /// Al editar: horario/duración originales EXACTOS (sin truncar) + la
    /// representación truncada con la que arrancan las ruedas. Si las ruedas
    /// siguen en ese valor base al guardar, el usuario NO tocó la programación
    /// y se reusa el horario exacto (no se reprograma la cita). Comparar contra
    /// la base evita depender de observadores `didSet` en `@Observable`.
    private let originalStartExact: Date?
    private let originalDurationExact: Int?
    private let baselineDay: CalendarBusinessDay?
    private let baselineStartMinutes: Int?
    private let baselineDurationMinutes: Int?

    // MARK: - Inits

    /// Crear cita.
    init(
        createIn calendars: [RistakCalendar],
        preferredCalendarID: String?,
        prefill: AppointmentPrefill,
        contact: AppointmentContactSelection?,
        timeZone: TimeZone
    ) {
        self.timeZone = timeZone
        self.isEdit = false
        self.calendars = calendars
        self.editingAppointment = nil
        self.contact = contact

        let resolved = Self.resolveCalendar(in: calendars, preferredID: preferredCalendarID)
        self.selectedCalendarID = resolved?.id ?? ""
        self.status = Self.initialStatus(for: resolved)

        self.day = prefill.day
        if let startMinutes = prefill.startMinutes {
            self.entryMode = .custom
            let hour24 = min(max(startMinutes / 60, 0), 23)
            self.hour12 = hour24 % 12 == 0 ? 12 : hour24 % 12
            self.minute = min((startMinutes % 60) / 5 * 5, 55)
            self.isPM = hour24 >= 12
        } else {
            self.entryMode = .defaultSlots
            self.hour12 = 9
            self.minute = 0
            self.isPM = false
        }

        let duration = prefill.durationMinutes ?? (resolved?.normalizedSlotDurationMinutes ?? 60)
        self.durationHours = min(duration / 60, 12)
        self.durationMinutesPart = duration % 60

        self.address = ""
        self.notesText = ""
        self.guests = []

        // Crear: no hay horario original que preservar.
        self.originalStartExact = nil
        self.originalDurationExact = nil
        self.baselineDay = nil
        self.baselineStartMinutes = nil
        self.baselineDurationMinutes = nil
    }

    /// Editar cita existente (abre en Personalizado, paridad RN).
    init(
        edit appointment: CalendarAppointment,
        calendars: [RistakCalendar],
        timeZone: TimeZone
    ) {
        self.timeZone = timeZone
        self.isEdit = true
        self.calendars = calendars
        self.editingAppointment = appointment
        self.entryMode = .custom

        if let contactId = appointment.contactId, !contactId.isEmpty {
            self.contact = AppointmentContactSelection(
                id: contactId,
                name: appointment.contactName,
                phone: appointment.contactPhone,
                email: appointment.contactEmail
            )
        } else {
            self.contact = nil
        }

        self.selectedCalendarID = appointment.calendarId.isEmpty
            ? (Self.resolveCalendar(in: calendars, preferredID: nil)?.id ?? "")
            : appointment.calendarId
        self.status = appointment.appointmentStatus ?? .confirmed
        self.statusTouched = true
        self.assignedUserID = appointment.assignedUserId

        let start = appointment.startDate ?? Date()
        let businessDay = CalendarDateMath.day(from: start, timeZone: timeZone)
        let startMinutes = CalendarDateMath.minutesFromMidnight(of: start, timeZone: timeZone)
        self.day = businessDay
        let hour24 = startMinutes / 60
        self.hour12 = hour24 % 12 == 0 ? 12 : hour24 % 12
        let truncatedMinute = min((startMinutes % 60) / 5 * 5, 55)
        self.minute = truncatedMinute
        self.isPM = hour24 >= 12

        var duration = 60
        if let end = appointment.endDate, end > start {
            duration = Int(end.timeIntervalSince(start) / 60)
        }
        let clampedDuration = min(max(duration, 5), 12 * 60 + 59)
        self.durationHours = min(clampedDuration / 60, 12)
        self.durationMinutesPart = clampedDuration % 60

        // Horario/duración originales EXACTOS (sin truncar) + la base que
        // muestran las ruedas al abrir, para detectar cambios reales.
        self.originalStartExact = appointment.startDate
        self.originalDurationExact = (appointment.startDate != nil) ? duration : nil
        self.baselineDay = businessDay
        self.baselineStartMinutes = hour24 * 60 + truncatedMinute
        self.baselineDurationMinutes = min(clampedDuration / 60, 12) * 60 + (clampedDuration % 60)

        self.address = appointment.address
        let parsed = AppointmentGuestNotesCodec.parse(notes: appointment.notes)
        self.notesText = parsed.notes
        self.guests = parsed.guests
    }

    private static func resolveCalendar(in calendars: [RistakCalendar], preferredID: String?) -> RistakCalendar? {
        if let preferredID, let match = calendars.first(where: { $0.id == preferredID }) { return match }
        return calendars.first { $0.isActive } ?? calendars.first
    }

    /// APT-008 (web): `pending` si el calendario NO auto-confirma.
    private static func initialStatus(for calendar: RistakCalendar?) -> AppointmentStatus {
        calendar?.autoConfirm == false ? .pending : .confirmed
    }

    // MARK: - Derivados

    var selectedCalendar: RistakCalendar? {
        calendars.first { $0.id == selectedCalendarID }
    }

    /// Round Robin → asignación obligatoria al crear (doc 07 §5.3).
    var requiresAssignment: Bool {
        selectedCalendar?.isRoundRobin == true
    }

    var showsAssignmentSection: Bool {
        requiresAssignment || (assignedUserID?.isEmpty == false)
    }

    /// Round Robin sin `teamMembers` configurados: limitación documentada
    /// (doc 07 gap 9 — sin HighLevel no hay usuarios asignables).
    var teamUnavailable: Bool {
        guard requiresAssignment else { return false }
        if case .loading = teamPhase { return false }
        return team.isEmpty && (selectedCalendar?.teamMembers.isEmpty ?? true)
    }

    /// Chips de fallback cuando el fetch de equipo falla pero el calendario
    /// sí tiene miembros (paridad RN: `Usuario {id8}...`).
    var fallbackTeamIDs: [String] {
        guard team.isEmpty, case .error = teamPhase else { return [] }
        return (selectedCalendar?.teamMembers ?? []).map(\.userId).filter { !$0.isEmpty }
    }

    var durationTotalMinutes: Int {
        durationHours * 60 + durationMinutesPart
    }

    var startMinutesOfDay: Int {
        let hour24 = (hour12 % 12) + (isPM ? 12 : 0)
        return hour24 * 60 + minute
    }

    /// Instante UTC del inicio en modo Personalizado.
    var customStartDate: Date? {
        CalendarDateMath.date(day: day, minutes: startMinutesOfDay, timeZone: timeZone)
    }

    /// Resumen «mié 8 jul · 4:00 p.m. – 5:00 p.m.» del modo Personalizado.
    var customSummary: String {
        guard let start = customStartDate, durationTotalMinutes > 0 else { return "" }
        let end = start.addingTimeInterval(TimeInterval(durationTotalMinutes * 60))
        let formatters = BusinessFormatters(timeZone: timeZone)
        let dayLabel = CalendarDateMath.shortDayLabel(day, timeZone: timeZone)
        return "\(dayLabel) · \(formatters.messageTime(start)) – \(formatters.messageTime(end))"
    }

    var ctaTitle: String {
        isEdit ? "Guardar cambios" : "Crear cita"
    }

    /// Duración efectiva de un slot «Por defecto» (normaliza unidad `hours`,
    /// clamp 15–1440 — paridad RN `getCalendarSlotDurationMinutes`).
    var slotDurationMinutes: Int {
        selectedCalendar?.normalizedSlotDurationMinutes ?? 60
    }

    /// Slots visibles del día elegido (máx 18, paridad RN).
    var visibleSlotsForSelectedDate: [String] {
        guard let selectedSlotDate,
              let dayEntry = slotDays.first(where: { $0.date == selectedSlotDate }) else { return [] }
        return Array(dayEntry.slots.prefix(18))
    }

    // MARK: - Mutaciones de UI

    func selectCalendar(id: String) {
        guard id != selectedCalendarID else { return }
        selectedCalendarID = id
        // Cambiar calendario resetea el slot elegido (paridad RN).
        selectedSlotISO = nil
        selectedSlotDate = nil
        slotDays = []
        slotsPhase = .idle
        team = []
        teamPhase = .idle
        if requiresAssignment == false { assignedUserID = nil }
        if !isEdit && !statusTouched {
            status = Self.initialStatus(for: selectedCalendar)
        }
    }

    func selectStatus(_ newStatus: AppointmentStatus) {
        status = newStatus
        statusTouched = true
    }

    func setContact(_ selection: AppointmentContactSelection) {
        contact = selection
    }

    func selectSlot(dayDate: String, iso: String) {
        selectedSlotDate = dayDate
        selectedSlotISO = iso
        // Elegir slot fija fecha/hora/duración (paridad RN) por si el usuario
        // cambia a Personalizado.
        if let date = RistakDateParsing.date(fromISO: iso) {
            day = CalendarDateMath.day(from: date, timeZone: timeZone)
            let minutes = CalendarDateMath.minutesFromMidnight(of: date, timeZone: timeZone)
            let hour24 = minutes / 60
            hour12 = hour24 % 12 == 0 ? 12 : hour24 % 12
            minute = minutes % 60
            isPM = hour24 >= 12
            let duration = slotDurationMinutes
            durationHours = min(duration / 60, 12)
            durationMinutesPart = duration % 60
        }
    }

    // MARK: - Cargas auxiliares

    func ensureAuxData() async {
        async let slots: Void = ensureSlots()
        async let teamLoad: Void = ensureTeam()
        _ = await (slots, teamLoad)
    }

    /// `GET /:id/free-slots` hoy → +30 días en la zona de la cuenta
    /// (límite backend 45 días — doc 07 §4).
    func ensureSlots(force: Bool = false) async {
        guard !selectedCalendarID.isEmpty else { return }
        if !force {
            guard slotsPhase == .idle else { return }
        }
        slotsPhase = .loading
        let start = CalendarDateMath.day(from: Date(), timeZone: timeZone)
        let end = CalendarDateMath.adding(days: 30, to: start, timeZone: timeZone)
        do {
            let days = try await CalendarsService.freeSlots(
                calendarID: selectedCalendarID,
                startDate: start.key,
                endDate: end.key,
                timezone: timeZone.identifier
            )
            slotDays = days.filter { !$0.slots.isEmpty }
            slotsPhase = .loaded
            if selectedSlotDate == nil {
                selectedSlotDate = slotDays.first?.date
            }
        } catch {
            slotDays = []
            let message = (error as? RistakAPIError)?.message ?? "No se pudieron cargar los horarios."
            slotsPhase = .error(message)
        }
    }

    func ensureTeam(force: Bool = false) async {
        guard showsAssignmentSection, let calendar = selectedCalendar else { return }
        if !force {
            guard teamPhase == .idle else { return }
        }
        teamPhase = .loading
        do {
            let memberIDs = calendar.teamMembers.map(\.userId).filter { !$0.isEmpty }
            let users: [CalendarUser]
            if !memberIDs.isEmpty {
                users = try await CalendarsService.highLevelUsers(ids: memberIDs)
            } else {
                users = try await CalendarsService.highLevelUsers()
            }
            team = users.filter { !$0.resolvedID.isEmpty }
            teamPhase = .loaded
        } catch {
            team = []
            teamPhase = .error("No pudimos cargar el equipo. Reintenta antes de guardar.")
        }
    }

    /// Hidrata `contactId`/`assignedUserId` al editar (el listado de eventos
    /// puede no traerlos; el detalle sí — paridad modal web `getAppointment`).
    func hydrateForEdit() async {
        guard isEdit, let id = editingAppointment?.id, !id.isEmpty else { return }
        guard let detail = try? await CalendarsService.event(id: id) else { return }
        editingAppointment = detail
        if contact == nil, let contactId = detail.contactId, !contactId.isEmpty {
            contact = AppointmentContactSelection(
                id: contactId,
                name: detail.contactName,
                phone: detail.contactPhone,
                email: detail.contactEmail
            )
        }
        if (assignedUserID ?? "").isEmpty, let assigned = detail.assignedUserId, !assigned.isEmpty {
            assignedUserID = assigned
        }
    }

    // MARK: - Invitados

    /// Alta de invitado desde el buscador modal (User #4): usa teléfono o, en su
    /// defecto, correo como valor de contacto para el bloque «Invitados:».
    func addGuest(selection: AppointmentContactSelection) {
        let contactValue = selection.phone.isEmpty ? selection.email : selection.phone
        addGuest(name: selection.displayName, contactValue: contactValue)
    }

    private func addGuest(name: String, contactValue: String) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedContact = contactValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedContact.isEmpty else {
            alert = FormAlert(
                title: "Invitado incompleto",
                message: "Agrega nombre y teléfono o correo para poder invitarlo."
            )
            return
        }
        // Duplicados por contacto (case-insensitive) se ignoran (doc 07 §5.4).
        let key = trimmedContact.lowercased()
        guard !guests.contains(where: { $0.contact.lowercased() == key }) else { return }
        guests.append(AppointmentGuestEntry(name: trimmedName, contact: trimmedContact))
    }

    func removeGuest(_ guest: AppointmentGuestEntry) {
        guests.removeAll { $0 == guest }
    }

    // MARK: - Guardado

    /// Título al crear = nombre del contacto (paridad RN
    /// `title || contactName || 'Cita'`).
    private func createTitleFromContact() -> String {
        let name = contact?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { return name }
        let display = contact?.displayName ?? ""
        return display.isEmpty ? "Cita" : display
    }

    /// Guarda la cita. Devuelve la cita guardada o `nil` si hubo validación /
    /// error (el detalle queda en `alert`).
    func save(ignoringConflicts: Bool = false) async -> CalendarAppointment? {
        guard !busy else { return nil }

        let contactID = contact?.id
        // Contacto obligatorio SOLO al crear. Al editar, una cita espejada de
        // Google/GHL puede no tener contacto y aun así debe poder guardarse
        // (paridad RN: `requireContact` solo en modo `create`).
        if !isEdit, (contactID ?? "").isEmpty {
            alert = FormAlert(title: "Contacto requerido", message: "Selecciona un contacto para crear la cita.")
            return nil
        }

        if !isEdit, requiresAssignment, (assignedUserID ?? "").isEmpty {
            alert = FormAlert(title: "Persona del equipo requerida", message: "Selecciona quién atenderá esta cita.")
            return nil
        }

        let startDate: Date
        let durationMinutes: Int
        if entryMode == .defaultSlots {
            guard let iso = selectedSlotISO, let parsed = RistakDateParsing.date(fromISO: iso) else {
                alert = FormAlert(title: "Horario inválido", message: "Usa fecha YYYY-MM-DD y hora HH:mm.")
                return nil
            }
            startDate = parsed
            durationMinutes = slotDurationMinutes
        } else if isEdit,
                  day == baselineDay,
                  startMinutesOfDay == baselineStartMinutes,
                  durationTotalMinutes == baselineDurationMinutes,
                  let origStart = originalStartExact,
                  let origDuration = originalDurationExact {
            // Editar sin tocar la programación (las ruedas siguen en su valor
            // base) → reusar el horario/duración EXACTOS originales para no
            // reprogramar la cita al cambiar un campo no relacionado (paridad
            // RN: conserva `draft.startTime`).
            startDate = origStart
            durationMinutes = origDuration
        } else {
            guard let parsed = customStartDate, durationTotalMinutes > 0 else {
                alert = FormAlert(title: "Horario inválido", message: "Usa fecha YYYY-MM-DD y hora HH:mm.")
                return nil
            }
            startDate = parsed
            durationMinutes = durationTotalMinutes
        }
        let endDate = startDate.addingTimeInterval(TimeInterval(durationMinutes * 60))

        busy = true
        defer { busy = false }

        // Pre-chequeo de bloqueos nativos al CREAR y al EDITAR en calendarios
        // no-GHL (paridad RN `getDraftBlockedConflict`; silencioso si el fetch
        // falla) — así reprogramar a un horario bloqueado avisa.
        if !ignoringConflicts, let calendar = selectedCalendar, !calendar.isGHLSynced {
            if let conflict = await blockedConflict(start: startDate, end: endDate, calendarID: calendar.id) {
                alert = FormAlert(title: "Horario bloqueado", message: conflict.conflictMessage)
                return nil
            }
        }

        let trimmedAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let draft = AppointmentDraftRequest(
            calendarId: selectedCalendarID.isEmpty ? nil : selectedCalendarID,
            contactId: (contactID?.isEmpty == false) ? contactID : nil,
            // Al crear, el título es el NOMBRE DEL CONTACTO (paridad RN
            // `title || contactName || 'Cita'`); si no, hereda el nombre del
            // calendario en todos lados.
            title: isEdit ? editingAppointment?.title : createTitleFromContact(),
            appointmentStatus: status.rawValue,
            startTime: RistakDateParsing.isoString(from: startDate),
            endTime: RistakDateParsing.isoString(from: endDate),
            timeZone: timeZone.identifier,
            notes: AppointmentGuestNotesCodec.compose(notes: notesText, guests: guests),
            // Al EDITAR siempre se envía la dirección (vacía la limpia); al crear
            // se omite si está vacía (paridad RN App.tsx ~8107).
            address: isEdit ? trimmedAddress : (trimmedAddress.isEmpty ? nil : trimmedAddress),
            assignedUserId: (assignedUserID?.isEmpty == false) ? assignedUserID : nil,
            ignoreAppointmentConflicts: ignoringConflicts ? true : nil
        )

        do {
            let saved: CalendarAppointment
            if isEdit, let id = editingAppointment?.id, !id.isEmpty {
                saved = try await CalendarsService.updateAppointment(id: id, draft)
            } else {
                saved = try await CalendarsService.createAppointment(draft)
            }
            saveSuccessCount += 1
            return saved
        } catch let error as RistakAPIError where error.isSlotUnavailable {
            alert = FormAlert(title: "Horario ocupado", message: error.message, offersOverbook: true)
            return nil
        } catch let error as RistakAPIError {
            alert = FormAlert(title: "No se pudo guardar", message: error.message)
            return nil
        } catch {
            alert = FormAlert(title: "No se pudo guardar", message: "Intenta otra vez.")
            return nil
        }
    }

    /// Bloqueos del día del borrador. Tolera las DOS formas de respuesta
    /// (nativa ISO / GHL `date` + `HH:mm` — doc 07 gap 10).
    private func blockedConflict(start: Date, end: Date, calendarID: String) async -> CalendarBlockedSlot? {
        let businessDay = CalendarDateMath.day(from: start, timeZone: timeZone)
        guard let dayStart = CalendarDateMath.startDate(of: businessDay, timeZone: timeZone),
              let dayEnd = CalendarDateMath.date(day: businessDay, minutes: 24 * 60, timeZone: timeZone) else {
            return nil
        }

        let slots: [CalendarBlockedSlot]
        do {
            slots = try await CalendarsService.blockedSlots(calendarID: calendarID, startTime: dayStart, endTime: dayEnd)
        } catch {
            // Silencioso: si no se pudieron leer los bloqueos, se permite crear
            // (el backend re-valida; paridad modal web).
            return nil
        }

        let draftStartMinutes = CalendarDateMath.minutesFromMidnight(of: start, timeZone: timeZone)
        let draftEndMinutes = draftStartMinutes + Int(end.timeIntervalSince(start) / 60)

        for slot in slots {
            if let slotStart = slot.resolvedStartDate, let slotEnd = slot.resolvedEndDate {
                if slotStart < end && slotEnd > start { return slot }
                continue
            }
            // Forma GHL: date `YYYY-MM-DD` + horas `HH:mm` en zona de negocio.
            if let date = slot.date, date == businessDay.key,
               let slotStart = Self.minutes(fromHHmm: slot.startTime),
               let slotEnd = Self.minutes(fromHHmm: slot.endTime),
               slotStart < draftEndMinutes, slotEnd > draftStartMinutes {
                return slot
            }
        }
        return nil
    }

    private static func minutes(fromHHmm value: String?) -> Int? {
        guard let value else { return nil }
        let parts = value.split(separator: ":")
        guard parts.count == 2, let hours = Int(parts[0]), let mins = Int(parts[1]) else { return nil }
        return hours * 60 + mins
    }
}
