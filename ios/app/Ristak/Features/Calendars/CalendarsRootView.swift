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
        case .idle, .loading:
            RistakLoadingView(message: "Cargando citas…")

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
            RistakErrorState(message: message) {
                Task { await model.retry(appConfig: appConfig) }
            }

        case .ready:
            if model.calendars.isEmpty {
                emptyCalendarsState
            } else if horizontalSizeClass == .regular {
                regularLayout
            } else {
                compactLayout
            }
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
        VStack(spacing: 0) {
            header
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.bottom, RistakTheme.Spacing.sm)

            eventsErrorBanner

            switch model.viewMode {
            case .month:
                ScrollView {
                    VStack(spacing: RistakTheme.Spacing.lg) {
                        CalendarMonthGridView(model: model, onCreateDay: canWrite ? { day in
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

            case .day, .week:
                CalendarTimelinePane(
                    model: model,
                    showsWeekColumns: false,
                    canCreate: canWrite,
                    onCreate: { prefill in startCreate(prefill: prefill) },
                    onEventTap: { event in detailAppointment = event }
                )
            }
        }
    }

    // MARK: - Layout regular (iPad)

    private var regularLayout: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, RistakTheme.Spacing.xl)
                .padding(.bottom, RistakTheme.Spacing.sm)

            eventsErrorBanner

            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    VStack(spacing: RistakTheme.Spacing.lg) {
                        CalendarMonthGridView(model: model, onCreateDay: canWrite ? { day in
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

    @ViewBuilder
    private var detailPanel: some View {
        switch model.viewMode {
        case .month:
            ScrollView {
                CalendarDayAgendaView(model: model) { event in
                    detailAppointment = event
                }
                .padding(RistakTheme.Spacing.xl)
            }
            .refreshable {
                await model.refresh(appConfig: appConfig)
            }

        case .day, .week:
            CalendarTimelinePane(
                model: model,
                showsWeekColumns: model.viewMode == .week,
                canCreate: canWrite,
                onCreate: { prefill in startCreate(prefill: prefill) },
                onEventTap: { event in detailAppointment = event }
            )
            .padding(.top, RistakTheme.Spacing.sm)
        }
    }

    // MARK: - Header (título grande del mes + pastilla de año + vistas)

    private var header: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.sm) {
                Text(model.monthTitle)
                    .font(.largeTitle.bold())
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)

                yearPill

                Spacer()

                if model.isLoadingEvents {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            HStack(spacing: 8) {
                ForEach(CalendarsViewModel.ViewMode.allCases) { mode in
                    RistakFilterChip(
                        title: mode.title,
                        isSelected: model.viewMode == mode
                    ) {
                        withAnimation(.snappy(duration: 0.18)) {
                            model.viewMode = mode
                        }
                    }
                }
            }
        }
    }

    /// Pastilla de año: menú para saltar de año sin salir de la vista.
    private var yearPill: some View {
        Menu {
            let currentYear = model.today.year
            ForEach(Array((currentYear - 2)...(currentYear + 3)), id: \.self) { year in
                Button {
                    withAnimation(.snappy) { model.goToYear(year) }
                } label: {
                    if year == model.visibleMonth.year {
                        Label(String(year), systemImage: "checkmark")
                    } else {
                        Text(String(year))
                    }
                }
            }
        } label: {
            Text(String(model.visibleMonth.year))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(RistakTheme.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(Capsule().fill(RistakTheme.controlRest))
        }
        .accessibilityLabel("Cambiar año")
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
            Button("Hoy") {
                withAnimation(.snappy) { model.goToToday() }
            }
            .accessibilityLabel("Ir a hoy")
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
