import SwiftUI

/// Sheet de detalles de una cita (doc 07 §6.1): hero con el color del
/// calendario, fecha y rango horario, contacto, cambio de estado, dirección y
/// notas, invitados y acciones Editar / Eliminar (destructiva con
/// confirmación anclada). La edición es un push DENTRO del mismo sheet.
struct AppointmentDetailSheet: View {
    let calendars: [RistakCalendar]
    let timeZone: TimeZone
    let canWrite: Bool
    /// Refresca la lista de eventos tras cambios (estado/edición).
    let onChanged: () -> Void
    let onDeleted: () -> Void

    @State private var appointment: CalendarAppointment
    @State private var changingStatus = false
    @State private var deleting = false
    @State private var showDeleteConfirm = false
    @State private var showEdit = false
    @State private var editModel: AppointmentFormViewModel?
    @State private var errorAlert: DetailAlert?
    @State private var successCount = 0

    @Environment(\.dismiss) private var dismiss

    init(
        appointment: CalendarAppointment,
        calendars: [RistakCalendar],
        timeZone: TimeZone,
        canWrite: Bool,
        onChanged: @escaping () -> Void,
        onDeleted: @escaping () -> Void
    ) {
        _appointment = State(initialValue: appointment)
        self.calendars = calendars
        self.timeZone = timeZone
        self.canWrite = canWrite
        self.onChanged = onChanged
        self.onDeleted = onDeleted
    }

    private struct DetailAlert: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    private var calendar: RistakCalendar? {
        calendars.first { $0.id == appointment.calendarId }
    }

    private var formatters: BusinessFormatters {
        BusinessFormatters(timeZone: timeZone)
    }

    private var parsedNotes: (notes: String, guests: [AppointmentGuestEntry]) {
        AppointmentGuestNotesCodec.parse(notes: appointment.notes)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                    heroCard
                    statusRow
                    contactRow
                    detailSection
                    if canWrite {
                        actionsSection
                    }
                }
                .padding(RistakTheme.Spacing.lg)
            }
            .navigationTitle(appointment.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Cerrar")
                }
            }
            .navigationDestination(isPresented: $showEdit) {
                if let editModel {
                    AppointmentFormView(model: editModel) { saved in
                        appointment = saved
                        showEdit = false
                        self.editModel = nil
                        onChanged()
                    }
                }
            }
        }
        .alert(
            errorAlert?.title ?? "",
            isPresented: Binding(
                get: { errorAlert != nil },
                set: { if !$0 { errorAlert = nil } }
            ),
            presenting: errorAlert
        ) { _ in
            Button("Entendido", role: .cancel) {}
        } message: { alert in
            Text(alert.message)
        }
        .sensoryFeedback(.success, trigger: successCount)
    }

    // MARK: - Hero

    private var heroCard: some View {
        let accent = calendar?.displayColor ?? RistakTheme.accent
        let dayLabel: String
        let timeLabel: String
        if let start = appointment.startDate {
            let businessDay = CalendarDateMath.day(from: start, timeZone: timeZone)
            dayLabel = CalendarDateMath.dayHeader(businessDay, timeZone: timeZone)
            if let end = appointment.endDate, end > start {
                timeLabel = "\(formatters.messageTime(start)) – \(formatters.messageTime(end))"
            } else {
                timeLabel = formatters.messageTime(start)
            }
        } else {
            dayLabel = "Sin fecha"
            timeLabel = "Sin hora"
        }

        return VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                Circle()
                    .fill(accent)
                    .frame(width: 10, height: 10)
                Text(calendar?.name ?? "Calendario")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
                Spacer()
                if let status = appointment.appointmentStatus {
                    TagPillView(text: status.displayLabel, dotColor: status.displayColor)
                }
            }

            Text(dayLabel)
                .font(.title3.bold())
                .foregroundStyle(RistakTheme.textPrimary)

            Text(timeLabel)
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(RistakTheme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                .fill(accent.opacity(0.12))
        )
        .accessibilityElement(children: .combine)
    }

    // MARK: - Estado

    @ViewBuilder
    private var statusRow: some View {
        if canWrite {
            HStack {
                Label("Estado", systemImage: "clock")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(RistakTheme.textPrimary)

                Spacer()

                if changingStatus {
                    ProgressView()
                } else {
                    Menu {
                        ForEach(AppointmentStatus.allCases, id: \.self) { status in
                            Button {
                                Task { await changeStatus(to: status) }
                            } label: {
                                if status == appointment.appointmentStatus {
                                    Label(status.displayLabel, systemImage: "checkmark")
                                } else {
                                    Text(status.displayLabel)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Circle()
                                .fill((appointment.appointmentStatus ?? .confirmed).displayColor)
                                .frame(width: 8, height: 8)
                            Text(appointment.appointmentStatus?.displayLabel ?? appointment.appointmentStatusRaw)
                                .font(.subheadline.weight(.medium))
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.caption2)
                        }
                        .foregroundStyle(RistakTheme.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(RistakTheme.controlRest))
                    }
                    .accessibilityLabel("Cambiar estado")
                }
            }
        } else if let status = appointment.appointmentStatus {
            HStack {
                Label("Estado", systemImage: "clock")
                    .font(.subheadline.weight(.medium))
                Spacer()
                TagPillView(text: status.displayLabel, dotColor: status.displayColor)
            }
        }
    }

    private func changeStatus(to status: AppointmentStatus) async {
        guard status != appointment.appointmentStatus, !appointment.id.isEmpty else { return }
        changingStatus = true
        defer { changingStatus = false }
        do {
            let updated = try await CalendarsService.updateAppointment(
                id: appointment.id,
                AppointmentDraftRequest(appointmentStatus: status.rawValue)
            )
            appointment = updated
            successCount += 1
            onChanged()
        } catch let error as RistakAPIError {
            errorAlert = DetailAlert(title: "No se pudo actualizar", message: error.message)
        } catch {
            errorAlert = DetailAlert(title: "No se pudo actualizar", message: "Intenta otra vez.")
        }
    }

    // MARK: - Contacto

    @ViewBuilder
    private var contactRow: some View {
        if !appointment.contactName.isEmpty || !appointment.contactPhone.isEmpty {
            HStack(spacing: RistakTheme.Spacing.sm) {
                ContactAvatarView(
                    name: appointment.contactName.isEmpty ? appointment.contactPhone : appointment.contactName,
                    size: 44
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(appointment.contactName.isEmpty ? appointment.contactPhone : appointment.contactName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                    if !appointment.contactPhone.isEmpty {
                        Text(appointment.contactPhone)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                    } else if !appointment.contactEmail.isEmpty {
                        Text(appointment.contactEmail)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }
                Spacer()
            }
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Detalle

    @ViewBuilder
    private var detailSection: some View {
        let parsed = parsedNotes
        if !appointment.address.isEmpty || !parsed.notes.isEmpty || !parsed.guests.isEmpty {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                Text("Detalle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
                    .textCase(.uppercase)

                if !appointment.address.isEmpty {
                    Label {
                        Text(appointment.address)
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textPrimary)
                    } icon: {
                        Image(systemName: "mappin.and.ellipse")
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }

                if !parsed.notes.isEmpty {
                    Label {
                        Text(parsed.notes)
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textPrimary)
                    } icon: {
                        Image(systemName: "note.text")
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }

                if !parsed.guests.isEmpty {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Invitados")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(RistakTheme.textPrimary)
                            ForEach(parsed.guests, id: \.self) { guest in
                                Text("\(guest.name) · \(guest.contact)")
                                    .font(.footnote)
                                    .foregroundStyle(RistakTheme.textDim)
                            }
                        }
                    } icon: {
                        Image(systemName: "person.2")
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }
            }
        }
    }

    // MARK: - Acciones

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            Text("Acciones")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(RistakTheme.textDim)
                .textCase(.uppercase)

            Button {
                guard !appointment.id.isEmpty else {
                    errorAlert = DetailAlert(
                        title: "No se puede editar",
                        message: "Esta cita no tiene un ID válido del backend."
                    )
                    return
                }
                editModel = AppointmentFormViewModel(
                    edit: appointment,
                    calendars: calendars,
                    timeZone: timeZone
                )
                showEdit = true
            } label: {
                actionRow(
                    icon: "pencil",
                    title: "Editar cita",
                    subtitle: "Cambiar título, estado, horario, dirección o notas.",
                    tint: RistakTheme.textPrimary
                )
            }
            .buttonStyle(.plain)

            Button {
                showDeleteConfirm = true
            } label: {
                actionRow(
                    icon: "trash",
                    title: "Eliminar cita",
                    subtitle: "Borra esta cita del calendario.",
                    tint: RistakTheme.neg
                )
            }
            .buttonStyle(.plain)
            .disabled(deleting)
            .confirmationDialog(
                "Eliminar cita",
                isPresented: $showDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Eliminar", role: .destructive) {
                    Task { await deleteAppointment() }
                }
                Button("Cancelar", role: .cancel) {}
            } message: {
                Text("Esta acción borra la cita del calendario.")
            }
        }
    }

    private func actionRow(icon: String, title: String, subtitle: String, tint: Color) -> some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Image(systemName: icon)
                .font(.body.weight(.medium))
                .foregroundStyle(tint)
                .frame(width: 34, height: 34)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                        .fill(RistakTheme.controlRest)
                )

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(tint)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(2)
            }

            Spacer()

            if deleting && tint == RistakTheme.neg {
                ProgressView()
            }
        }
        .contentShape(Rectangle())
    }

    private func deleteAppointment() async {
        guard !appointment.id.isEmpty else {
            errorAlert = DetailAlert(title: "No se pudo eliminar", message: "Intenta otra vez.")
            return
        }
        deleting = true
        defer { deleting = false }
        do {
            try await CalendarsService.deleteEvent(id: appointment.id)
            successCount += 1
            onDeleted()
            dismiss()
        } catch {
            errorAlert = DetailAlert(title: "No se pudo eliminar", message: "Intenta otra vez.")
        }
    }
}
