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

    /// Hay citas pintadas (caché o red). Con SWR NUNCA mostramos un banner de
    /// error de citas mientras esto sea `true`: la cita ya está a la vista, así
    /// que un fallo de revalidación se traga en silencio (fix del error fantasma).
    private var hasVisibleEvents: Bool {
        !rawEvents.isEmpty || !eventsByDay.isEmpty
    }

    /// Hay CUALQUIER contenido en pantalla (calendarios o citas). Con SWR una
    /// recarga fallida es silenciosa mientras esto sea `true`; solo caemos a un
    /// estado duro/error cuando de verdad no hay nada que mostrar.
    private var hasVisibleData: Bool {
        !calendars.isEmpty || hasVisibleEvents
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
        // SWR (#4): pinta al instante lo último que vio el usuario (calendarios +
        // citas del mes visible) ANTES de tocar la red. Solo hay spinner de
        // pantalla completa cuando NO hay nada cacheado.
        hydrateFromCache(defaultCalendarID: appConfig.defaultCalendarID)
        if phase != .ready { phase = .loading }
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
            storeCalendarsToCache()
            resolveSelection(defaultCalendarID: appConfig.defaultCalendarID)
            if phase != .ready { phase = .ready }
        } catch {
            // SWR: si ya hay contenido en pantalla (calendarios/citas) o ya
            // estábamos en estado listo (p. ej. la pantalla vacía «sin
            // calendarios»), el refresco fallido es SILENCIOSO; conservamos lo
            // guardado y solo revalidamos las citas. Solo caemos al estado duro en
            // un primer arranque sin absolutamente nada que mostrar.
            if phase != .ready && !hasVisibleData {
                mapLoadFailure(error)
                return
            }
            if phase != .ready { phase = .ready }
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
            storeCalendarsToCache()
            resolveSelection(defaultCalendarID: defaultCalendarID)
            phase = .ready
            await reloadEvents(force: true)
        } catch {
            // Estados duros (acceso/plan) siempre mandan, con o sin caché.
            if let api = error as? RistakAPIError, api.isAccessDenied {
                phase = .accessDenied(api.message)
                return
            }
            if let api = error as? RistakAPIError, api.kind == .featureUnavailable {
                phase = .featureUnavailable
                return
            }
            // SWR: si ya pintamos algo (caché o carga previa), NUNCA lo tiramos a
            // una pantalla de error NI mostramos banner; dejamos lo guardado y
            // revalidamos las citas en silencio.
            if phase == .ready || !calendars.isEmpty {
                if phase != .ready { phase = .ready }
                await reloadEvents(force: true)
            } else if initial {
                mapLoadFailure(error)
            } else {
                // Sin nada que mostrar (primer arranque sin caché): aquí sí informamos.
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
            storeEventsToCache()
        } catch {
            guard requestID == eventsRequestID else { return }
            if let api = error as? RistakAPIError {
                if api.isAccessDenied {
                    // Estado duro de acceso: solo manda si NO hay nada pintado;
                    // con citas/calendarios a la vista conservamos lo guardado (SWR).
                    if !hasVisibleData {
                        phase = .accessDenied(api.message)
                    }
                } else if api.kind == .featureUnavailable {
                    // Silencioso en cargas (regla de licencia).
                } else if !hasVisibleEvents {
                    // Fix error fantasma: SOLO informamos si no hay citas a la
                    // vista. Si ya hay citas (caché o carga previa) tragamos el
                    // error en silencio y seguimos mostrándolas.
                    eventsError = "No se pudieron cargar las citas."
                }
            } else if !hasVisibleEvents {
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

    // MARK: - Caché SWR (#4)

    /// Clave de mes `YYYY-MM` del día dado (para `RistakCacheKey.calendarEvents`).
    private func monthKey(_ day: CalendarBusinessDay) -> String {
        String(format: "%04d-%02d", day.year, day.month)
    }

    /// Pinta al instante lo cacheado (sin spinner) antes de la red: calendarios
    /// + citas del mes visible. Si hay calendarios cacheados, deja la pantalla
    /// lista (`phase = .ready`) para que no aparezca el loader de pantalla completa.
    private func hydrateFromCache(defaultCalendarID: String) {
        let cache = RistakSnapshotCache.shared
        if let cachedCalendars = cache.value([RistakCalendar].self, for: RistakCacheKey.calendarList),
           !cachedCalendars.isEmpty {
            calendars = cachedCalendars
            resolveSelection(defaultCalendarID: defaultCalendarID)
            phase = .ready
        }
        hydrateEventsFromCache()
    }

    /// Carga en memoria las citas cacheadas del mes visible (solo si aún no hay
    /// nada cargado, para no pisar datos frescos).
    private func hydrateEventsFromCache() {
        guard rawEvents.isEmpty else { return }
        let key = RistakCacheKey.calendarEvents(month: monthKey(visibleMonth))
        if let cached = RistakSnapshotCache.shared.value([CalendarAppointment].self, for: key),
           !cached.isEmpty {
            rawEvents = cached
            regroupEvents()
        }
    }

    /// Guarda la lista de calendarios en la caché (round-trip vía JSON crudo,
    /// porque `RistakCalendar` es solo Decodable).
    private func storeCalendarsToCache() {
        guard let data = CalendarSnapshotCodec.encode(calendars: calendars) else { return }
        RistakSnapshotCache.shared.storeRaw(data, for: RistakCacheKey.calendarList)
    }

    /// Guarda las citas del MES VISIBLE bajo su propia clave `calendar:events:<yyyy-MM>`
    /// (cada mes se cachea por separado, capado por el codec).
    private func storeEventsToCache() {
        let monthEvents = rawEvents.filter { event in
            guard let start = event.startDate else { return false }
            let day = CalendarDateMath.day(from: start, timeZone: timeZone)
            return day.year == visibleMonth.year && day.month == visibleMonth.month
        }
        guard let data = CalendarSnapshotCodec.encode(appointments: monthEvents) else { return }
        RistakSnapshotCache.shared.storeRaw(
            data,
            for: RistakCacheKey.calendarEvents(month: monthKey(visibleMonth))
        )
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
