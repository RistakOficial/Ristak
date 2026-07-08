import Foundation
import Observation

/// ViewModel raíz de Calendarios: calendarios, eventos del rango visible
/// (mes ± 1 de buffer), selección de día y modo de vista.
/// Datos: `GET /api/calendars` + `GET /api/calendars/events` (epoch millis,
/// agrupado por día en `account_timezone` — doc 07 §4).
@MainActor
@Observable
final class CalendarsViewModel {
    enum Phase: Equatable {
        case idle
        case loading
        case ready
        case error(String)
        case accessDenied(String)
        case featureUnavailable
    }

    enum ViewMode: String, CaseIterable, Identifiable, Sendable {
        case day
        case week
        case month
        /// Rejilla de 12 meses (vista Año).
        case year
        /// Rejilla de años de la década (vista Años).
        case years

        var id: String { rawValue }

        var title: String {
            switch self {
            case .day: return "Día"
            case .week: return "Semana"
            case .month: return "Mes"
            case .year: return "Año"
            case .years: return "Años"
            }
        }

        /// Modos que aparecen como chips en el selector (paridad RN: Día/Semana/Mes).
        static let pickerModes: [ViewMode] = [.day, .week, .month]

        /// Los DOS modos base (Día/Semana/Mes) distintos al actual, en orden
        /// fijo Día→Semana→Mes. Son los que muestra el toggle de dos botones a
        /// la derecha del título (User #7: «solo tenemos 2 botones»). Vacío en
        /// Año/Años (esas vistas solo se alcanzan por la pastilla de año).
        var toggleAlternatives: [ViewMode] {
            guard self == .day || self == .week || self == .month else { return [] }
            return [.day, .week, .month].filter { $0 != self }
        }

        /// Vistas de timeline (día/semana).
        var isTimeline: Bool { self == .day || self == .week }
    }

    /// Clave persistida del calendario elegido (paridad RN).
    static let selectedCalendarDefaultsKey = "ristak.native.calendar.selectedCalendarId.v1"

    // MARK: Estado

    private(set) var phase: Phase = .idle
    private(set) var calendars: [RistakCalendar] = []
    private(set) var selectedCalendarID: String?
    /// Eventos agrupados por clave de día de negocio (`YYYY-MM-DD`).
    private(set) var eventsByDay: [String: [CalendarAppointment]] = [:]
    /// Error no bloqueante de recarga de eventos (banner).
    private(set) var eventsError: String?
    private(set) var isLoadingEvents = false
    private(set) var timeZone: TimeZone = TimeZone(identifier: AppConfigStore.defaultTimeZoneIdentifier)!

    var viewMode: ViewMode = .month
    /// Primer día del mes visible en la grilla.
    private(set) var visibleMonth: CalendarBusinessDay
    private(set) var selectedDay: CalendarBusinessDay

    // MARK: Privado

    private var rawEvents: [CalendarAppointment] = []
    private var loadedInterval: DateInterval?
    private var loadedCalendarKey: String?
    private var bootstrapped = false
    private var eventsRequestID = 0

    init() {
        let zone = TimeZone(identifier: AppConfigStore.defaultTimeZoneIdentifier)!
        let today = CalendarDateMath.day(from: Date(), timeZone: zone)
        selectedDay = today
        visibleMonth = CalendarDateMath.firstOfMonth(today)
    }

    // MARK: - Derivados

    var selectedCalendar: RistakCalendar? {
        calendars.first { $0.id == selectedCalendarID }
    }

    var today: CalendarBusinessDay {
        CalendarDateMath.day(from: Date(), timeZone: timeZone)
    }

    var monthTitle: String {
        CalendarDateMath.monthTitle(year: visibleMonth.year, month: visibleMonth.month, timeZone: timeZone)
    }

    func events(on day: CalendarBusinessDay) -> [CalendarAppointment] {
        eventsByDay[day.key] ?? []
    }

    func hasEvents(on day: CalendarBusinessDay) -> Bool {
        !(eventsByDay[day.key]?.isEmpty ?? true)
    }

    /// Snap de minutos del timeline al `slotInterval` del calendario activo
    /// (normaliza unidad `hours`, clamp 5–60 — paridad RN `getCalendarSnapMinutes`).
    var slotStepMinutes: Int {
        selectedCalendar?.normalizedSlotIntervalMinutes ?? 30
    }

    /// Duración por defecto de cita nueva (normaliza unidad `hours`, clamp
    /// 15–1440 — paridad RN `getCalendarSlotDurationMinutes`).
    var defaultDurationMinutes: Int {
        selectedCalendar?.normalizedSlotDurationMinutes ?? 60
    }

    /// Década visible (12 años) para la vista Años (paridad RN `getYearsGridForDate`).
    var yearsGrid: [Int] {
        let start = (visibleMonth.year / 12) * 12
        return Array(start..<(start + 12))
    }

    /// Próximas citas del rango cargado (máx 6) para la agenda de la vista Año.
    var upcomingEvents: [CalendarAppointment] {
        rawEvents
            .filter { $0.startDate != nil }
            .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
            .prefix(6)
            .map { $0 }
    }

    // MARK: - Carga

    func bootstrap(appConfig: AppConfigStore) async {
        guard !bootstrapped else { return }
        bootstrapped = true
        applyTimeZone(appConfig.businessTimeZone)
        phase = .loading
        await loadCalendars(defaultCalendarID: appConfig.defaultCalendarID, initial: true)
    }

    func retry(appConfig: AppConfigStore) async {
        applyTimeZone(appConfig.businessTimeZone)
        phase = .loading
        await loadCalendars(defaultCalendarID: appConfig.defaultCalendarID, initial: true)
    }

    /// Pull-to-refresh: recarga calendarios + eventos sin tirar el contenido.
    func refresh(appConfig: AppConfigStore) async {
        applyTimeZone(appConfig.businessTimeZone)
        do {
            calendars = try await CalendarsService.calendars()
            resolveSelection(defaultCalendarID: appConfig.defaultCalendarID)
            if phase != .ready { phase = .ready }
        } catch {
            if case .ready = phase {
                eventsError = "No se pudo actualizar el calendario."
            } else {
                mapLoadFailure(error)
                return
            }
        }
        await reloadEvents(force: true)
    }

    /// La zona de negocio puede llegar después del primer render; al cambiar,
    /// se reagrupan los eventos ya cargados y se reancla el día visible.
    func updateTimeZone(_ zone: TimeZone) {
        guard zone.identifier != timeZone.identifier else { return }
        applyTimeZone(zone)
        regroupEvents()
        Task { await reloadEvents(force: true) }
    }

    private func applyTimeZone(_ zone: TimeZone) {
        guard zone.identifier != timeZone.identifier else { return }
        timeZone = zone
        let today = CalendarDateMath.day(from: Date(), timeZone: zone)
        if phase == .idle || phase == .loading {
            selectedDay = today
            visibleMonth = CalendarDateMath.firstOfMonth(today)
        }
    }

    private func loadCalendars(defaultCalendarID: String, initial: Bool) async {
        do {
            calendars = try await CalendarsService.calendars()
            resolveSelection(defaultCalendarID: defaultCalendarID)
            phase = .ready
            await reloadEvents(force: true)
        } catch {
            if initial || calendars.isEmpty {
                mapLoadFailure(error)
            } else {
                eventsError = "No se pudieron cargar los calendarios."
            }
        }
    }

    private func mapLoadFailure(_ error: Error) {
        if let api = error as? RistakAPIError {
            if api.isAccessDenied {
                phase = .accessDenied(api.message)
            } else if api.kind == .featureUnavailable {
                phase = .featureUnavailable
            } else {
                phase = .error(api.message)
            }
        } else {
            phase = .error("No se pudieron cargar los calendarios.")
        }
    }

    private func resolveSelection(defaultCalendarID: String) {
        guard !calendars.isEmpty else {
            selectedCalendarID = nil
            return
        }
        // 1) Selección vigente si sigue existiendo.
        if let current = selectedCalendarID, calendars.contains(where: { $0.id == current }) { return }
        // 2) Persistida en el dispositivo (paridad RN SecureStore).
        if let persisted = UserDefaults.standard.string(forKey: Self.selectedCalendarDefaultsKey),
           calendars.contains(where: { $0.id == persisted }) {
            selectedCalendarID = persisted
            return
        }
        // 3) `default_calendar_id` de la cuenta.
        if !defaultCalendarID.isEmpty, calendars.contains(where: { $0.id == defaultCalendarID }) {
            selectedCalendarID = defaultCalendarID
            return
        }
        // 4) Primer calendario activo, o el primero.
        selectedCalendarID = (calendars.first { $0.isActive } ?? calendars.first)?.id
    }

    func selectCalendar(id: String) {
        guard id != selectedCalendarID else { return }
        selectedCalendarID = id
        UserDefaults.standard.set(id, forKey: Self.selectedCalendarDefaultsKey)
        Task { await reloadEvents(force: true) }
    }

    // MARK: - Eventos

    /// Recarga los eventos del rango visible (mes anterior → mes siguiente,
    /// exclusivo). Mantiene los datos previos en pantalla mientras carga.
    func reloadEvents(force: Bool) async {
        let rangeStart: CalendarBusinessDay
        let rangeEnd: CalendarBusinessDay
        switch viewMode {
        case .year, .years:
            // Año completo (paridad RN: rango 1 ene – 31 dic del año visible).
            let year = visibleMonth.year
            rangeStart = CalendarBusinessDay(year: year, month: 1, day: 1)
            rangeEnd = CalendarBusinessDay(year: year + 1, month: 1, day: 1)
        default:
            let anchor = CalendarDateMath.firstOfMonth(visibleMonth)
            rangeStart = CalendarDateMath.addingMonths(-1, to: anchor)
            rangeEnd = CalendarDateMath.addingMonths(2, to: anchor)
        }
        guard let startDate = CalendarDateMath.startDate(of: rangeStart, timeZone: timeZone),
              let endDate = CalendarDateMath.startDate(of: rangeEnd, timeZone: timeZone) else { return }

        let interval = DateInterval(start: startDate, end: endDate)
        let calendarKey = selectedCalendarID ?? ""
        if !force,
           loadedCalendarKey == calendarKey,
           let loaded = loadedInterval,
           loaded.contains(startDate),
           loaded.contains(endDate.addingTimeInterval(-1)) {
            return
        }

        eventsRequestID += 1
        let requestID = eventsRequestID
        isLoadingEvents = true
        eventsError = nil
        do {
            let events = try await CalendarsService.events(
                startTime: startDate,
                endTime: endDate,
                calendarID: selectedCalendarID
            )
            guard requestID == eventsRequestID else { return }
            rawEvents = events
            regroupEvents()
            loadedInterval = interval
            loadedCalendarKey = calendarKey
        } catch {
            guard requestID == eventsRequestID else { return }
            if let api = error as? RistakAPIError {
                if api.isAccessDenied {
                    phase = .accessDenied(api.message)
                } else if api.kind == .featureUnavailable {
                    // Silencioso en cargas (regla de licencia).
                } else {
                    eventsError = "No se pudieron cargar las citas."
                }
            } else {
                eventsError = "No se pudieron cargar las citas."
            }
        }
        if requestID == eventsRequestID {
            isLoadingEvents = false
        }
    }

    private func regroupEvents() {
        var map: [String: [CalendarAppointment]] = [:]
        for event in rawEvents {
            guard let start = event.startDate else { continue }
            let key = CalendarDateMath.day(from: start, timeZone: timeZone).key
            map[key, default: []].append(event)
        }
        for key in map.keys {
            map[key]?.sort { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
        }
        eventsByDay = map
    }

    // MARK: - Navegación de fecha

    /// Botón «Hoy»: salta a hoy. Si estamos en Año/Años baja un nivel
    /// (paridad RN `handleQuickReturn`).
    func goToToday() {
        let today = self.today
        selectedDay = today
        visibleMonth = CalendarDateMath.firstOfMonth(today)
        switch viewMode {
        case .year: viewMode = .month
        case .years: viewMode = .year
        default: break
        }
        Task { await reloadEvents(force: false) }
    }

    /// Cambia de vista desde los chips (Día/Semana/Mes) anclando el mes visible
    /// al día seleccionado (paridad RN `handleSelectCalendarView`).
    func setViewMode(_ mode: ViewMode) {
        guard mode != viewMode else { return }
        viewMode = mode
        if mode == .month || mode.isTimeline {
            visibleMonth = CalendarDateMath.firstOfMonth(selectedDay)
        }
        Task { await reloadEvents(force: false) }
    }

    /// Pastilla de AÑO (User #7): sube un nivel de zoom hacia la vista anual.
    /// Mes/Día/Semana → Año (rejilla de 12 meses); Año → Años (década);
    /// Años → Año. Año/Años solo se alcanzan por aquí, nunca por el toggle.
    func navigateUp() {
        switch viewMode {
        case .month:
            viewMode = .year
        case .day, .week:
            // Ancla el año visible al día seleccionado antes de subir a anual.
            visibleMonth = CalendarDateMath.firstOfMonth(selectedDay)
            viewMode = .year
        case .year:
            viewMode = .years
        case .years:
            viewMode = .year
        }
        Task { await reloadEvents(force: false) }
    }

    /// Tap en un mes de la vista Año → baja a la vista Mes (paridad RN
    /// `handleSelectMonthFromYear`).
    func selectMonth(monthIndex: Int) {
        let year = visibleMonth.year
        let month = min(max(monthIndex + 1, 1), 12)
        let maxDay = CalendarDateMath.daysInMonth(year: year, month: month, timeZone: timeZone)
        let day = min(max(selectedDay.day, 1), maxDay)
        selectedDay = CalendarBusinessDay(year: year, month: month, day: day)
        visibleMonth = CalendarBusinessDay(year: year, month: month, day: 1)
        viewMode = .month
        Task { await reloadEvents(force: false) }
    }

    /// Tap en un año de la vista Años → baja a la vista Año (paridad RN
    /// `handleSelectYear`).
    func selectYear(_ year: Int) {
        let month = visibleMonth.month
        let maxDay = CalendarDateMath.daysInMonth(year: year, month: month, timeZone: timeZone)
        let day = min(max(selectedDay.day, 1), maxDay)
        selectedDay = CalendarBusinessDay(year: year, month: month, day: day)
        visibleMonth = CalendarBusinessDay(year: year, month: month, day: 1)
        viewMode = .year
        Task { await reloadEvents(force: false) }
    }

    /// Swipe horizontal del periodo actual (paridad RN `movePeriod`):
    /// Mes ±1 mes · Año ±1 año · Años ±1 década · Día ±1 día · Semana ±7 días.
    func shiftPeriod(_ direction: Int) {
        switch viewMode {
        case .month:
            goToMonth(offset: direction)
        case .year:
            visibleMonth = CalendarDateMath.addingMonths(direction * 12, to: visibleMonth)
            Task { await reloadEvents(force: false) }
        case .years:
            visibleMonth = CalendarDateMath.addingMonths(direction * 12 * 12, to: visibleMonth)
            Task { await reloadEvents(force: false) }
        case .day:
            shiftSelectedDay(by: direction)
        case .week:
            shiftSelectedDay(by: direction * 7)
        }
    }

    func goToMonth(offset: Int) {
        visibleMonth = CalendarDateMath.addingMonths(offset, to: visibleMonth)
        Task { await reloadEvents(force: false) }
    }

    func select(day: CalendarBusinessDay) {
        selectedDay = day
        if day.year != visibleMonth.year || day.month != visibleMonth.month {
            visibleMonth = CalendarDateMath.firstOfMonth(day)
            Task { await reloadEvents(force: false) }
        }
    }

    /// Swipe del timeline: ±1 día (Día) o ±7 días (Semana).
    func shiftSelectedDay(by days: Int) {
        select(day: CalendarDateMath.adding(days: days, to: selectedDay, timeZone: timeZone))
    }
}
