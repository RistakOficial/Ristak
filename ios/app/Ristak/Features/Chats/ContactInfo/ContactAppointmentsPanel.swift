import SwiftUI

/// Panel "Citas" (doc 06 §4.1 paneles secundarios): lista de citas embebidas
/// del contacto; tocar una abre su detalle (Cita / Inicio / Fin / Estado /
/// Notas). Estados y etiquetas según doc 07 §3.2.
struct ContactAppointmentsPanel: View {
    let contactName: String
    let appointments: [ContactEmbeddedAppointment]
    let timeZone: TimeZone

    @State private var selectedAppointment: ContactEmbeddedAppointment?

    var body: some View {
        SheetScaffold(title: "Citas", subtitle: contactName) {
            if appointments.isEmpty {
                RistakEmptyState(
                    icon: "calendar",
                    title: "Sin citas",
                    message: "Aún no hay citas para este contacto."
                )
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(appointments) { appointment in
                            appointmentRow(appointment)
                            if appointment.id != appointments.last?.id {
                                Divider()
                                    .overlay(RistakTheme.border.opacity(0.5))
                            }
                        }
                    }
                    .padding(.horizontal, RistakTheme.Spacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                            .fill(RistakTheme.surface)
                    )
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.lg)
                }
            }
        }
        .sheet(item: $selectedAppointment) { appointment in
            ContactAppointmentDetailSheet(appointment: appointment, timeZone: timeZone)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    private func appointmentRow(_ appointment: ContactEmbeddedAppointment) -> some View {
        Button {
            selectedAppointment = appointment
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(for: appointment))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    Text(ContactInfoDates.dateTime(fromISO: appointment.startTime, timeZone: timeZone))
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer()

                Text(ContactInfoAppointmentStatus.label(appointment.status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ContactInfoAppointmentStatus.color(appointment.status))

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(RistakTheme.textMute)
            }
            .padding(.vertical, RistakTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ver detalle de cita")
    }

    private func title(for appointment: ContactEmbeddedAppointment) -> String {
        let value = (appointment.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "(Sin título)" : value
    }
}

/// Detalle de cita embebida: Cita / Inicio / Fin / Estado / Notas.
private struct ContactAppointmentDetailSheet: View {
    let appointment: ContactEmbeddedAppointment
    let timeZone: TimeZone

    var body: some View {
        SheetScaffold(title: "Detalle de cita") {
            ScrollView {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    ContactInfoRow(label: "Cita", value: titleText)
                    ContactInfoRow(
                        label: "Inicio",
                        value: ContactInfoDates.dateTime(fromISO: appointment.startTime, timeZone: timeZone)
                    )
                    ContactInfoRow(
                        label: "Fin",
                        value: ContactInfoDates.dateTime(fromISO: appointment.endTime, timeZone: timeZone)
                    )

                    HStack(spacing: RistakTheme.Spacing.sm) {
                        Text("Estado")
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textDim)
                            .frame(width: 112, alignment: .leading)

                        Text(ContactInfoAppointmentStatus.label(appointment.status))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(ContactInfoAppointmentStatus.color(appointment.status))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(RistakTheme.controlRest))
                    }

                    if let address = appointment.address?.trimmingCharacters(in: .whitespacesAndNewlines), !address.isEmpty {
                        ContactInfoRow(label: "Dirección", value: address)
                    }

                    ContactInfoRow(label: "Notas", value: appointment.notes ?? "", placeholder: "Sin notas")
                }
                .padding(RistakTheme.Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                        .fill(RistakTheme.surface)
                )
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.bottom, RistakTheme.Spacing.lg)
            }
        }
    }

    private var titleText: String {
        let value = (appointment.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "(Sin título)" : value
    }
}
