import SwiftUI

/// Sheet autocontenida «Nueva cita» para un contacto YA conocido (User #6,
/// contrato para el proxy del agente de chat en fase 2). La presenta, por
/// ejemplo, el icono de calendario del header de una conversación: como el
/// contacto ya está resuelto, SE OMITE el buscador de contactos y arranca
/// directo en el formulario.
///
/// Es self-contained: carga los calendarios (`CalendarsService`) y la zona de
/// negocio (`AppConfigStore`) por su cuenta, y llama `onSaved` al guardar.
struct AppointmentComposeSheet: View {
    let contactID: String
    let contactName: String?
    let contactPhone: String?
    let onSaved: () -> Void

    init(
        contactID: String,
        contactName: String?,
        contactPhone: String?,
        onSaved: @escaping () -> Void
    ) {
        self.contactID = contactID
        self.contactName = contactName
        self.contactPhone = contactPhone
        self.onSaved = onSaved
    }

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.dismiss) private var dismiss

    @State private var phase: Phase = .loading
    @State private var formModel: AppointmentFormViewModel?

    private enum Phase: Equatable {
        case loading
        case ready
        case noCalendars
        case error(String)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Nueva cita")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // Mientras no hay formulario, ofrecemos el cierre desde aquí
                    // (el formulario trae su propia barra inferior de acción).
                    if formModel == nil {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                dismiss()
                            } label: {
                                Image(systemName: "xmark")
                            }
                            .accessibilityLabel("Cerrar")
                        }
                    }
                }
        }
        .task {
            await load()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            RistakLoadingView(message: "Cargando calendario…")

        case .error(let message):
            RistakErrorState(message: message) {
                Task { await load(force: true) }
            }

        case .noCalendars:
            RistakEmptyState(
                icon: "calendar",
                title: "No hay calendarios conectados.",
                message: "Conecta o crea un calendario desde el escritorio para poder agendar."
            )

        case .ready:
            if let formModel {
                AppointmentFormView(model: formModel) { _ in
                    onSaved()
                    dismiss()
                }
            }
        }
    }

    @MainActor
    private func load(force: Bool = false) async {
        if !force, formModel != nil { return }
        phase = .loading
        do {
            let calendars = try await CalendarsService.calendars()
            guard !calendars.isEmpty else {
                phase = .noCalendars
                return
            }
            let timeZone = appConfig.businessTimeZone
            let today = CalendarDateMath.day(from: Date(), timeZone: timeZone)
            let selection = AppointmentContactSelection(
                id: contactID,
                name: contactName ?? "",
                phone: contactPhone ?? ""
            )
            let preferredID = appConfig.defaultCalendarID
            formModel = AppointmentFormViewModel(
                createIn: calendars,
                preferredCalendarID: preferredID.isEmpty ? nil : preferredID,
                prefill: AppointmentPrefill(day: today),
                contact: selection,
                timeZone: timeZone
            )
            phase = .ready
        } catch let error as RistakAPIError {
            phase = .error(error.message)
        } catch {
            phase = .error("No se pudo cargar el calendario.")
        }
    }
}
