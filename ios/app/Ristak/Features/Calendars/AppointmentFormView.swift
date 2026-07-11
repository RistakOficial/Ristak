import SwiftUI

/// Formulario Agendar/Editar cita (doc 07 §6.1). Secciones en el orden RN:
/// Calendario · Estado · Persona asignada (round robin) · Fecha y hora
/// (Por defecto / Personalizado) · Invitados · Notas · CTA.
/// El selector de calendario y las ruedas son SUBVISTAS del mismo sheet
/// (push interno, nunca modal sobre modal).
struct AppointmentFormView: View {
    @Bindable var model: AppointmentFormViewModel
    let onSaved: (CalendarAppointment) -> Void

    @State private var showGuestPicker = false

    var body: some View {
        Form {
            contactSection
            calendarSection
            statusSection
            if model.showsAssignmentSection {
                assignmentSection
            }
            scheduleSection
            guestsSection
            notesSection
        }
        .navigationTitle(model.isEdit ? "Editar cita" : "Agendar una cita")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { ctaBar }
        .task(id: model.selectedCalendarID) {
            await model.ensureAuxData()
        }
        .task {
            await model.hydrateForEdit()
        }
        .sheet(isPresented: $showGuestPicker) {
            AppointmentContactPickerSheet(
                title: "Agregar invitados",
                emptyHint: "Busca un contacto para invitar."
            ) { selection in
                model.addGuest(selection: selection)
            }
            .presentationDetents([.medium, .large])
        }
        .alert(
            model.alert?.title ?? "",
            isPresented: alertBinding,
            presenting: model.alert
        ) { alert in
            if alert.offersOverbook {
                Button("Cancelar", role: .cancel) {}
                Button("Crear de todos modos") {
                    Task { await attemptSave(ignoringConflicts: true) }
                }
            } else {
                Button("Entendido", role: .cancel) {}
            }
        } message: { alert in
            Text(alert.message)
        }
        .sensoryFeedback(.success, trigger: model.saveSuccessCount)
    }

    private var alertBinding: Binding<Bool> {
        Binding(
            get: { model.alert != nil },
            set: { if !$0 { model.alert = nil } }
        )
    }

    private func attemptSave(ignoringConflicts: Bool = false) async {
        if let saved = await model.save(ignoringConflicts: ignoringConflicts) {
            onSaved(saved)
        }
    }

    // MARK: - Contacto

    @ViewBuilder
    private var contactSection: some View {
        if let contact = model.contact {
            Section {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    ContactAvatarView(
                        name: contact.displayName,
                        photoURL: contact.photoURL,
                        size: 40,
                        channel: contact.channel
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(contact.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(RistakTheme.textPrimary)
                        if !contact.secondaryLabel.isEmpty {
                            Text(contact.secondaryLabel)
                                .font(.footnote)
                                .foregroundStyle(RistakTheme.textDim)
                        }
                    }
                }
            } header: {
                Text("Contacto")
            }
        }
    }

    // MARK: - Calendario

    private var calendarSection: some View {
        Section {
            NavigationLink {
                AppointmentCalendarSelectView(model: model)
            } label: {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    Circle()
                        .fill(model.selectedCalendar?.displayColor ?? RistakTheme.accent)
                        .frame(width: 10, height: 10)
                    Text(model.selectedCalendar?.name ?? "Elige un calendario")
                        .foregroundStyle(RistakTheme.textPrimary)
                }
            }
        } header: {
            Text("Calendario")
        }
    }

    // MARK: - Estado

    private var statusSection: some View {
        Section {
            FlowChips(spacing: 8) {
                ForEach(AppointmentStatus.allCases, id: \.self) { status in
                    RistakFilterChip(
                        title: status.displayLabel,
                        isSelected: model.status == status
                    ) {
                        model.selectStatus(status)
                    }
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
        } header: {
            Text("Estado")
        }
    }

    // MARK: - Persona asignada

    private var assignmentSection: some View {
        Section {
            switch model.teamPhase {
            case .idle, .loading:
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ProgressView()
                    Text("Cargando equipo...")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                }
            case .error(let message):
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.neg)
                    if !model.fallbackTeamIDs.isEmpty {
                        teamChips(ids: model.fallbackTeamIDs)
                    }
                    Button("Reintentar") {
                        Task { await model.ensureTeam(force: true) }
                    }
                    .font(.footnote.weight(.semibold))
                }
            case .loaded:
                if model.teamUnavailable {
                    Text("No hay equipo para asignar.")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                    Text("Este calendario reparte citas entre un equipo, pero no tiene miembros configurados. Configúralo desde el escritorio para poder agendar.")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textMute)
                } else {
                    loadedTeamChips
                }
            }
        } header: {
            Text(model.requiresAssignment ? "Elegir miembro del equipo *" : "Persona asignada")
        }
    }

    private var loadedTeamChips: some View {
        FlowChips(spacing: 8) {
            if !model.requiresAssignment {
                RistakFilterChip(
                    title: "Sin asignar",
                    isSelected: (model.assignedUserID ?? "").isEmpty
                ) {
                    model.assignedUserID = nil
                }
            }
            ForEach(model.team, id: \.resolvedID) { user in
                RistakFilterChip(
                    title: user.displayLabel,
                    isSelected: model.assignedUserID == user.resolvedID
                ) {
                    model.assignedUserID = user.resolvedID
                }
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
    }

    private func teamChips(ids: [String]) -> some View {
        FlowChips(spacing: 8) {
            ForEach(ids, id: \.self) { id in
                RistakFilterChip(
                    title: "Usuario \(String(id.prefix(8)))...",
                    isSelected: model.assignedUserID == id
                ) {
                    model.assignedUserID = id
                }
            }
        }
    }

    // MARK: - Fecha y hora

    private var scheduleSection: some View {
        Section {
            HStack(spacing: 8) {
                ForEach(AppointmentFormViewModel.EntryMode.allCases) { mode in
                    RistakFilterChip(
                        title: mode.title,
                        isSelected: model.entryMode == mode
                    ) {
                        model.entryMode = mode
                        if mode == .defaultSlots {
                            Task { await model.ensureSlots() }
                        }
                    }
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))

            if model.entryMode == .defaultSlots {
                slotsContent
            } else {
                customContent
            }
        } header: {
            Text("Fecha y hora *")
        }
    }

    // MARK: Por defecto (free slots)

    @ViewBuilder
    private var slotsContent: some View {
        switch model.slotsPhase {
        case .idle, .loading:
            HStack(spacing: RistakTheme.Spacing.xs) {
                ProgressView()
                Text("Buscando horarios...")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
            }
        case .error(let message):
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.neg)
                Button("Reintentar") {
                    Task { await model.ensureSlots(force: true) }
                }
                .font(.footnote.weight(.semibold))
            }
        case .loaded:
            if model.slotDays.isEmpty {
                Text("No hay horarios disponibles en los próximos 30 días.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
            } else {
                slotPickers
            }
        }
    }

    private var slotPickers: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            Text("Elige una fecha disponible")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textDim)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.slotDays, id: \.date) { slotDay in
                        slotDateChip(slotDay)
                    }
                }
            }
            .ristakEdgeToEdgeChips(horizontalInset: 4)

            Text("Horario")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textDim)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 108), spacing: 8)], spacing: 8) {
                ForEach(model.visibleSlotsForSelectedDate, id: \.self) { iso in
                    slotHourChip(iso: iso)
                }
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
    }

    private func slotDateChip(_ slotDay: CalendarFreeSlotDay) -> some View {
        let isSelected = model.selectedSlotDate == slotDay.date
        let label = CalendarBusinessDay(key: slotDay.date).map {
            CalendarDateMath.shortDayLabel($0, timeZone: model.timeZone)
        } ?? slotDay.date
        let count = slotDay.slots.count

        return Button {
            model.selectedSlotDate = slotDay.date
        } label: {
            VStack(spacing: 2) {
                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textPrimary)
                Text("\(count) \(count == 1 ? "horario" : "horarios")")
                    .font(.caption2)
                    .foregroundStyle(isSelected ? RistakTheme.onAccent.opacity(0.85) : RistakTheme.textDim)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(isSelected ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
            )
            .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func slotHourChip(iso: String) -> some View {
        let isSelected = model.selectedSlotISO == iso
        let formatters = BusinessFormatters(timeZone: model.timeZone)
        let start = RistakDateParsing.date(fromISO: iso)
        let startLabel = start.map(formatters.messageTime) ?? iso
        let endLabel = start.map {
            formatters.messageTime($0.addingTimeInterval(TimeInterval(model.slotDurationMinutes * 60)))
        } ?? ""

        return Button {
            if let selectedDate = model.selectedSlotDate {
                model.selectSlot(dayDate: selectedDate, iso: iso)
            }
        } label: {
            VStack(spacing: 1) {
                Text(startLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textPrimary)
                if !endLabel.isEmpty {
                    Text("– \(endLabel)")
                        .font(.caption2)
                        .foregroundStyle(isSelected ? RistakTheme.onAccent.opacity(0.85) : RistakTheme.textDim)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(isSelected ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
            )
            .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Horario \(startLabel)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    // MARK: Personalizado

    @ViewBuilder
    private var customContent: some View {
        NavigationLink {
            AppointmentDateWheelView(model: model)
        } label: {
            LabeledContent("Fecha") {
                Text(CalendarDateMath.shortDayLabel(model.day, timeZone: model.timeZone) + " \(model.day.year)")
            }
        }

        NavigationLink {
            AppointmentTimeWheelView(model: model)
        } label: {
            LabeledContent("Hora") {
                Text(String(format: "%d:%02d %@", model.hour12, model.minute, model.isPM ? "p.m." : "a.m."))
            }
        }

        NavigationLink {
            AppointmentDurationWheelView(model: model)
        } label: {
            LabeledContent("Duración") {
                Text(durationLabel)
            }
        }

        TextField("Dirección", text: $model.address, prompt: Text("Dirección (opcional)"))

        LabeledContent("Zona horaria") {
            Text(model.timeZone.identifier)
                .font(.footnote)
        }

        if !model.customSummary.isEmpty {
            Text(model.customSummary)
                .font(.footnote.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
        }
    }

    private var durationLabel: String {
        if model.durationHours > 0 && model.durationMinutesPart > 0 {
            return "\(model.durationHours) h \(model.durationMinutesPart) min"
        }
        if model.durationHours > 0 {
            return "\(model.durationHours) h"
        }
        return "\(model.durationMinutesPart) min"
    }

    // MARK: - Invitados

    /// Sin campos en línea (User #4): solo chips removibles de los invitados
    /// elegidos + un botón «Agregar invitados» que abre el MISMO buscador de
    /// contactos del alta de cita (contactos existentes + «Nuevo contacto»).
    /// Los invitados se siguen serializando en el bloque «Invitados:» de notas.
    private var guestsSection: some View {
        Section {
            if !model.guests.isEmpty {
                FlowChips(spacing: 8) {
                    ForEach(model.guests, id: \.self) { guest in
                        guestChip(guest)
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 8, trailing: 4))
                .listRowBackground(Color.clear)
            }

            Button {
                showGuestPicker = true
            } label: {
                Label("Agregar invitados", systemImage: "person.badge.plus")
            }
        } header: {
            Text("Invitados")
        } footer: {
            Text("Los invitados se guardan en las notas de la cita.")
        }
    }

    /// Chip removible de invitado (nombre + ✕), relleno neutro.
    private func guestChip(_ guest: AppointmentGuestEntry) -> some View {
        HStack(spacing: 6) {
            Text(guest.name)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(1)
            Button {
                model.removeGuest(guest)
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(RistakTheme.textDim)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Quitar invitado \(guest.name)")
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 7)
        .background(Capsule().fill(RistakTheme.controlRest))
    }

    // MARK: - Notas

    private var notesSection: some View {
        Section {
            TextField(
                "Notas",
                text: $model.notesText,
                prompt: Text("Añade instrucciones, acuerdos o detalles importantes..."),
                axis: .vertical
            )
            .lineLimit(3...8)
        } header: {
            Text("Notas")
        }
    }

    // MARK: - CTA

    private var ctaBar: some View {
        Button {
            Task { await attemptSave() }
        } label: {
            HStack(spacing: RistakTheme.Spacing.xs) {
                if model.busy {
                    ProgressView()
                        .tint(RistakTheme.onAccent)
                }
                Text(model.ctaTitle)
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(model.busy)
        .padding(.horizontal, RistakTheme.Spacing.lg)
        .padding(.vertical, RistakTheme.Spacing.sm)
    }
}

// MARK: - Subvista: selector de calendario

/// Subvista «Calendarios» dentro del mismo sheet (paridad RN: nunca un modal
/// encima del modal).
private struct AppointmentCalendarSelectView: View {
    @Bindable var model: AppointmentFormViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if model.calendars.isEmpty {
                Text("No hay calendarios conectados.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
            }
            ForEach(model.calendars) { calendar in
                Button {
                    model.selectCalendar(id: calendar.id)
                    dismiss()
                } label: {
                    HStack(spacing: RistakTheme.Spacing.sm) {
                        Circle()
                            .fill(calendar.displayColor)
                            .frame(width: 10, height: 10)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(calendar.name)
                                .foregroundStyle(calendar.isActive ? RistakTheme.textPrimary : RistakTheme.textDim)
                            if calendar.isRoundRobin {
                                Text("Round robin · requiere asignar equipo")
                                    .font(.caption)
                                    .foregroundStyle(RistakTheme.textMute)
                            }
                        }
                        Spacer()
                        if calendar.id == model.selectedCalendarID {
                            Image(systemName: "checkmark")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(RistakTheme.accent)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle("Calendarios")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Subvista: ruedas de fecha

private struct AppointmentDateWheelView: View {
    @Bindable var model: AppointmentFormViewModel

    private var daysInMonth: Int {
        CalendarDateMath.daysInMonth(year: model.day.year, month: model.day.month, timeZone: model.timeZone)
    }

    private var yearRange: [Int] {
        let current = CalendarDateMath.day(from: Date(), timeZone: model.timeZone).year
        return Array((current - 1)...(current + 3))
    }

    var body: some View {
        VStack {
            HStack(spacing: 0) {
                Picker("Día", selection: dayBinding) {
                    ForEach(1...daysInMonth, id: \.self) { value in
                        Text("\(value)").tag(value)
                    }
                }
                .pickerStyle(.wheel)

                Picker("Mes", selection: monthBinding) {
                    ForEach(1...12, id: \.self) { value in
                        Text(BusinessFormatters.shortMonths[value - 1]).tag(value)
                    }
                }
                .pickerStyle(.wheel)

                Picker("Año", selection: yearBinding) {
                    ForEach(yearRange, id: \.self) { value in
                        Text(String(value)).tag(value)
                    }
                }
                .pickerStyle(.wheel)
            }
            .frame(maxHeight: 260)

            Spacer()
        }
        .padding(.horizontal)
        .navigationTitle("Elige la fecha")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var dayBinding: Binding<Int> {
        Binding(
            get: { min(model.day.day, daysInMonth) },
            set: { model.day.day = min(max($0, 1), daysInMonth) }
        )
    }

    private var monthBinding: Binding<Int> {
        Binding(
            get: { model.day.month },
            set: { newValue in
                model.day.month = min(max(newValue, 1), 12)
                let maxDay = CalendarDateMath.daysInMonth(year: model.day.year, month: model.day.month, timeZone: model.timeZone)
                if model.day.day > maxDay { model.day.day = maxDay }
            }
        )
    }

    private var yearBinding: Binding<Int> {
        Binding(
            get: { model.day.year },
            set: { newValue in
                model.day.year = newValue
                let maxDay = CalendarDateMath.daysInMonth(year: model.day.year, month: model.day.month, timeZone: model.timeZone)
                if model.day.day > maxDay { model.day.day = maxDay }
            }
        )
    }
}

// MARK: - Subvista: ruedas de hora

private struct AppointmentTimeWheelView: View {
    @Bindable var model: AppointmentFormViewModel

    var body: some View {
        VStack {
            HStack(spacing: 0) {
                Picker("Hora", selection: $model.hour12) {
                    ForEach(1...12, id: \.self) { value in
                        Text("\(value)").tag(value)
                    }
                }
                .pickerStyle(.wheel)

                Picker("Minutos", selection: $model.minute) {
                    ForEach(Array(stride(from: 0, through: 55, by: 5)), id: \.self) { value in
                        Text(String(format: "%02d", value)).tag(value)
                    }
                }
                .pickerStyle(.wheel)

                Picker("Meridiano", selection: $model.isPM) {
                    Text("a.m.").tag(false)
                    Text("p.m.").tag(true)
                }
                .pickerStyle(.wheel)
            }
            .frame(maxHeight: 260)

            Spacer()
        }
        .padding(.horizontal)
        .navigationTitle("Elige la hora")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Subvista: ruedas de duración

private struct AppointmentDurationWheelView: View {
    @Bindable var model: AppointmentFormViewModel

    var body: some View {
        VStack {
            HStack(spacing: 0) {
                Picker("Horas", selection: $model.durationHours) {
                    ForEach(0...12, id: \.self) { value in
                        Text("\(value) h").tag(value)
                    }
                }
                .pickerStyle(.wheel)

                Picker("Minutos", selection: $model.durationMinutesPart) {
                    ForEach(0...59, id: \.self) { value in
                        Text("\(value) min").tag(value)
                    }
                }
                .pickerStyle(.wheel)
            }
            .frame(maxHeight: 260)

            Spacer()
        }
        .padding(.horizontal)
        .navigationTitle("Duración")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Layout de chips con salto de línea

/// Layout que acomoda chips en filas (wrap), estilo etiquetas.
private struct FlowChips: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            totalWidth = max(totalWidth, x - spacing)
        }
        return CGSize(width: proposal.width ?? totalWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
