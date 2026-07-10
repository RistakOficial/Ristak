import SwiftUI

/// Raíz del módulo Calendarios (doc research/07 + UX doc 14 §6.6).
/// - Compacto (iPhone): mes + agenda del día apilados; Día/Semana = timeline.
/// - Regular (iPad): calendario mensual a la izquierda + panel de agenda /
///   timeline (semana en columnas reales) a la derecha; selector de
///   calendario en popover.
/// Consume `ShellState.pendingAppointmentContactID` (deep link «agendar con
/// este contacto» desde Chats/push).
struct CalendarsRootView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access
    @Environment(ShellState.self) private var shell
    @Environment(\.scenePhase) private var scenePhase

    @State private var model = CalendarsViewModel()
    @State private var showCalendarPicker = false
    @State private var flowContext: AppointmentFlowContext?
    @State private var detailAppointment: CalendarAppointment?
    @State private var pendingContactID: String?
    @State private var rootAlert: RootAlert?

    private struct RootAlert: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    private var canWrite: Bool {
        access.canWrite(module: .appointments)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Citas")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
        }
        .task {
            await model.bootstrap(appConfig: appConfig)
        }
        .onAppear {
            consumePendingContact(shell.pendingAppointmentContactID)
        }
        .onChange(of: shell.pendingAppointmentContactID) { _, newValue in
            consumePendingContact(newValue)
        }
        .onChange(of: model.phase) { _, _ in
            handlePendingContactIfReady()
        }
        .onChange(of: appConfig.businessTimeZone) { _, newZone in
            model.updateTimeZone(newZone)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.reloadEvents(force: true) }
        }
        .sheet(item: $flowContext) { context in
            AppointmentFlowSheet(
                context: context,
                calendars: model.calendars,
                preferredCalendarID: model.selectedCalendarID,
                timeZone: model.timeZone
            ) { _ in
                flowContext = nil
                Task { await model.reloadEvents(force: true) }
            }
            .presentationDetents([.large])
        }
        .sheet(item: $detailAppointment) { appointment in
            AppointmentDetailSheet(
                appointment: appointment,
                calendars: model.calendars,
                timeZone: model.timeZone,
                canWrite: canWrite,
                onChanged: {
                    Task { await model.reloadEvents(force: true) }
                },
                onDeleted: {
                    detailAppointment = nil
                    Task { await model.reloadEvents(force: true) }
                }
            )
            .presentationDetents([.medium, .large])
        }
        .alert(
            rootAlert?.title ?? "",
            isPresented: Binding(
                get: { rootAlert != nil },
                set: { if !$0 { rootAlert = nil } }
            ),
            presenting: rootAlert
        ) { _ in
            Button("Entendido", role: .cancel) {}
        } message: { alert in
            Text(alert.message)
        }
    }

    // MARK: - Contenido por fase

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .accessDenied(let message):
            RistakEmptyState(
                icon: "lock.fill",
                title: "Sin acceso",
                message: message
            )

        case .featureUnavailable:
            RistakEmptyState(
                icon: "calendar.badge.exclamationmark",
                title: "Función no disponible",
                message: "Esta función no está incluida en tu plan. Pídele al administrador que la active."
            )

        case .error(let message):
            // Solo se llega aquí en el PRIMER arranque sin caché (sin nada que
            // mostrar). Con datos en pantalla nunca caemos a esta pantalla (SWR).
            RistakErrorState(message: message) {
                Task { await model.retry(appConfig: appConfig) }
            }

        case .idle, .loading, .ready:
            // Instantáneo estilo WhatsApp: la rejilla del calendario SIEMPRE está
            // montada con su chrome (header + toolbar). Si hay caché se pinta al
            // instante; si de verdad no hay nada, es una rejilla vacía SIN spinner.
            // El único spinner permitido es el pull-to-refresh nativo.
            calendarSurface
        }
    }

    /// Superficie del calendario (rejilla mensual / timeline). Nunca muestra un
    /// loader de pantalla completa: durante la carga inicial se ve la rejilla del
    /// mes (vacía o con lo cacheado). El estado «No hay calendarios conectados»
    /// solo aparece cuando YA confirmamos (phase `.ready`) que la cuenta no tiene
    /// calendarios; mientras carga mostramos la rejilla, jamás un spinner.
    @ViewBuilder
    private var calendarSurface: some View {
        if model.phase == .ready && model.calendars.isEmpty {
            emptyCalendarsState
        } else if horizontalSizeClass == .regular {
            regularLayout
        } else {
            compactLayout
        }
    }

    private var emptyCalendarsState: some View {
        ScrollView {
            RistakEmptyState(
                icon: "calendar",
                title: "No hay calendarios conectados.",
                message: "Conecta o crea un calendario desde el escritorio para empezar a agendar."
            )
            .frame(minHeight: 420)
        }
        .refreshable {
            await model.refresh(appConfig: appConfig)
        }
    }

    // MARK: - Layout compacto (iPhone)

    private var compactLayout: some View {
        // El ScrollView / timeline es el descendiente DIRECTO del NavigationStack
        // (sin VStack contenedor) para que el tab bar rastree la dirección del
        // scroll y se oculte al bajar / expanda al subir (#11). El header va como
        // safeAreaInset superior fija.
        Group {
            switch model.viewMode {
            case .month:
                ScrollView {
                    VStack(spacing: RistakTheme.Spacing.lg) {
                        CalendarMonthPager(model: model, onCreateDay: canWrite ? { day in
                            startCreate(prefill: AppointmentPrefill(day: day))
                        } : nil)

                        CalendarDayAgendaView(model: model) { event in
                            detailAppointment = event
                        }
                    }
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.xxl)
                }
                .refreshable {
                    await model.refresh(appConfig: appConfig)
                }
                // Dock por dirección de scroll (#11) sobre el scroll principal
                // (vista Mes, la predeterminada). Solo compacto; ver
                // `ShellScrollTracking.swift`.
                .reportsShellScroll()

            case .year:
                ScrollView {
                    VStack(spacing: RistakTheme.Spacing.lg) {
                        CalendarYearGridView(model: model)
                        upcomingAgenda
                    }
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.xxl)
                }
                .refreshable {
                    await model.refresh(appConfig: appConfig)
                }

            case .years:
                ScrollView {
                    CalendarYearsGridView(model: model)
                        .padding(.horizontal, RistakTheme.Spacing.lg)
                        .padding(.top, RistakTheme.Spacing.sm)
                        .padding(.bottom, RistakTheme.Spacing.xxl)
                }
                .refreshable {
                    await model.refresh(appConfig: appConfig)
                }

            case .day, .week:
                CalendarTimelinePager(
                    model: model,
                    canCreate: canWrite,
                    onCreate: { prefill in startCreate(prefill: prefill) },
                    onEventTap: { event in detailAppointment = event }
                )
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                header
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.sm)
                eventsErrorBanner
            }
            .background(RistakTheme.bg)
        }
    }

    // MARK: - Layout regular (iPad)

    private var regularLayout: some View {
        Group {
            switch model.viewMode {
            case .year:
                ScrollView {
                    VStack(spacing: RistakTheme.Spacing.lg) {
                        CalendarYearGridView(model: model)
                        upcomingAgenda
                    }
                    .padding(RistakTheme.Spacing.xl)
                }
                .refreshable { await model.refresh(appConfig: appConfig) }

            case .years:
                ScrollView {
                    CalendarYearsGridView(model: model)
                        .padding(RistakTheme.Spacing.xl)
                }
                .refreshable { await model.refresh(appConfig: appConfig) }

            case .month, .day, .week:
                HStack(alignment: .top, spacing: 0) {
                    ScrollView {
                        VStack(spacing: RistakTheme.Spacing.lg) {
                            CalendarMonthPager(model: model, onCreateDay: canWrite ? { day in
                                startCreate(prefill: AppointmentPrefill(day: day))
                            } : nil)
                        }
                        .padding(RistakTheme.Spacing.lg)
                    }
                    .frame(width: 400)
                    .refreshable {
                        await model.refresh(appConfig: appConfig)
                    }

                    Divider()

                    detailPanel
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                header
                    .padding(.horizontal, RistakTheme.Spacing.xl)
                    .padding(.bottom, RistakTheme.Spacing.sm)
                eventsErrorBanner
            }
            .background(RistakTheme.bg)
        }
    }

    @ViewBuilder
    private var detailPanel: some View {
        switch model.viewMode {
        case .day, .week:
            CalendarTimelinePager(
                model: model,
                canCreate: canWrite,
                onCreate: { prefill in startCreate(prefill: prefill) },
                onEventTap: { event in detailAppointment = event }
            )
            .padding(.top, RistakTheme.Spacing.sm)

        default:
            ScrollView {
                CalendarDayAgendaView(model: model) { event in
                    detailAppointment = event
                }
                .padding(RistakTheme.Spacing.xl)
            }
            .refreshable {
                await model.refresh(appConfig: appConfig)
            }
        }
    }

    /// Agenda «Próximas citas» de la vista Año (paridad RN `nextUpcomingEvents`).
    @ViewBuilder
    private var upcomingAgenda: some View {
        let events = model.upcomingEvents
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text("Próximas citas")
                    .font(.headline)
                    .foregroundStyle(RistakTheme.textPrimary)
                Spacer()
                Text(events.isEmpty ? "Sin citas" : "\(events.count) en este rango")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
            }

            if events.isEmpty {
                RistakEmptyState(
                    icon: "calendar",
                    title: "No hay citas próximas",
                    message: "Cambia de calendario o crea una cita nueva."
                )
                .frame(minHeight: 200)
            } else {
                VStack(spacing: RistakTheme.Spacing.xs) {
                    ForEach(events) { event in
                        AppointmentCardView(event: event, timeZone: model.timeZone) {
                            detailAppointment = event
                        }
                    }
                }
            }
        }
    }

    // MARK: - Header (título grande + toggle de dos vistas)

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.sm) {
            Text(headerTitle)
                .font(.largeTitle.bold())
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            // Sin spinner en el header: el refresco en segundo plano es SILENCIOSO
            // (estilo WhatsApp). El único indicador de carga es el pull-to-refresh.

            Spacer(minLength: RistakTheme.Spacing.sm)

            // Toggle de EXACTAMENTE dos botones con las dos vistas NO actuales
            // (User #7). Solo en Día/Semana/Mes; Año/Años se alcanzan por la
            // pastilla de año.
            viewToggle
        }
    }

    /// Toggle de dos botones (Día/Semana/Mes) a la derecha del título. Ninguno
    /// está «seleccionado»: ambos cambian a la vista NO actual, así que usan
    /// relleno neutro (no acento). Al tocar uno, la vista cambia y el par se
    /// actualiza (User #7).
    @ViewBuilder
    private var viewToggle: some View {
        let alternatives = model.viewMode.toggleAlternatives
        if !alternatives.isEmpty {
            HStack(spacing: 6) {
                ForEach(alternatives) { mode in
                    Button {
                        withAnimation(.snappy(duration: 0.2)) {
                            model.setViewMode(mode)
                        }
                    } label: {
                        Text(mode.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(RistakTheme.textPrimary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(RistakTheme.controlRest))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cambiar a vista \(mode.title)")
                }
            }
            .fixedSize()
        }
    }

    /// Título grande según la vista (mes · año · rango de años · día · semana).
    private var headerTitle: String {
        switch model.viewMode {
        case .month:
            return model.monthTitle
        case .year:
            return String(model.visibleMonth.year)
        case .years:
            let grid = model.yearsGrid
            return "\(grid.first ?? model.visibleMonth.year) - \(grid.last ?? model.visibleMonth.year)"
        case .day:
            return CalendarDateMath.longDayTitle(model.selectedDay, timeZone: model.timeZone)
        case .week:
            let days = CalendarDateMath.weekDays(containing: model.selectedDay, timeZone: model.timeZone)
            let first = days.first ?? model.selectedDay
            let last = days.last ?? model.selectedDay
            return "\(CalendarDateMath.dayMonthLabel(first, timeZone: model.timeZone)) – \(CalendarDateMath.dayMonthLabel(last, timeZone: model.timeZone))"
        }
    }

    /// Año que muestra la pastilla de año (User #7): el año del contexto actual.
    private var yearPillLabel: String {
        switch model.viewMode {
        case .day, .week:
            return String(model.selectedDay.year)
        default:
            return String(model.visibleMonth.year)
        }
    }

    /// Pastilla de AÑO (reemplaza al botón «Hoy», User #7): muestra el año
    /// actual; al tocarla sube a la vista anual (Mes/Día/Semana → Año), y de
    /// nuevo sube a la vista de años/década (Año → Años). Es la ÚNICA entrada a
    /// las vistas Año/Años.
    private var yearPill: some View {
        Button {
            withAnimation(.snappy) { model.navigateUp() }
        } label: {
            HStack(spacing: 3) {
                Text(yearPillLabel)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Image(systemName: "chevron.up")
                    .font(.caption2.weight(.bold))
            }
            .lineLimit(1)
        }
        .accessibilityLabel("Ver año \(yearPillLabel)")
    }

    @ViewBuilder
    private var eventsErrorBanner: some View {
        if let message = model.eventsError {
            HStack(spacing: RistakTheme.Spacing.xs) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(RistakTheme.warn)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textPrimary)
                Spacer()
                Button("Reintentar") {
                    Task { await model.reloadEvents(force: true) }
                }
                .font(.footnote.weight(.semibold))
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, RistakTheme.Spacing.xs)
            .background(RistakTheme.warnSoft)
            .clipShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
            .padding(.horizontal, RistakTheme.Spacing.lg)
            .padding(.bottom, RistakTheme.Spacing.xs)
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            yearPill
        }

        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showCalendarPicker = true
            } label: {
                Image(systemName: "calendar.badge.checkmark")
            }
            .accessibilityLabel("Elegir calendario")
            .popover(isPresented: $showCalendarPicker) {
                CalendarPickerSheet(
                    calendars: model.calendars,
                    selectedID: model.selectedCalendarID
                ) { id in
                    model.selectCalendar(id: id)
                }
                .frame(minWidth: 320, minHeight: 380)
                .presentationDetents([.medium, .large])
            }
        }

        if canWrite {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    startCreate(prefill: AppointmentPrefill(day: model.selectedDay))
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Nueva cita")
            }
        }
    }

    // MARK: - Crear cita

    private func startCreate(
        prefill: AppointmentPrefill,
        contact: AppointmentContactSelection? = nil
    ) {
        guard canWrite else { return }
        guard model.selectedCalendar != nil else {
            rootAlert = RootAlert(
                title: "Selecciona calendario",
                message: "Elige un calendario activo antes de agendar."
            )
            return
        }
        flowContext = AppointmentFlowContext(kind: .create(prefill: prefill, contact: contact))
    }

    // MARK: - Deep link: agendar con contacto precargado

    private func consumePendingContact(_ contactID: String?) {
        guard let contactID, !contactID.isEmpty else { return }
        shell.pendingAppointmentContactID = nil
        pendingContactID = contactID
        handlePendingContactIfReady()
    }

    private func handlePendingContactIfReady() {
        guard model.phase == .ready, let contactID = pendingContactID else { return }
        pendingContactID = nil
        Task {
            do {
                let detail = try await ContactsService().fetchContact(
                    id: contactID,
                    warmProfilePictures: false
                )
                startCreate(
                    prefill: AppointmentPrefill(day: model.selectedDay),
                    contact: AppointmentContactSelection(detail: detail)
                )
            } catch {
                rootAlert = RootAlert(
                    title: "No se abrió la cita",
                    message: "No se pudo cargar el contacto para agendar."
                )
            }
        }
    }
}
