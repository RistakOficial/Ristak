import SwiftUI

/// Sheet «Programar mensaje» de la BANDEJA (docs 03 §4.4 y 05 §2.10): solo
/// texto, fecha y hora exactas mostradas en la zona horaria del negocio,
/// default +1 hora. Editar = mismo endpoint con `id` (aquí solo creación; el
/// composer tiene su propio sheet con edición y plantillas).
struct InboxScheduleMessageSheet: View {
    let contact: ChatContact
    let viewModel: InboxViewModel
    let businessTimeZone: TimeZone

    @Environment(\.dismiss) private var dismiss
    @State private var messageText = ""
    @State private var scheduledDate: Date
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(contact: ChatContact, viewModel: InboxViewModel, businessTimeZone: TimeZone) {
        self.contact = contact
        self.viewModel = viewModel
        self.businessTimeZone = businessTimeZone
        _scheduledDate = State(initialValue: viewModel.scheduleDefaultDate)
    }

    var body: some View {
        SheetScaffold(title: "Programar mensaje", subtitle: ChatRowSignals.displayName(contact)) {
            Form {
                Section("Mensaje") {
                    TextField(
                        "Escribe el mensaje que quieres programar…",
                        text: $messageText,
                        axis: .vertical
                    )
                    .lineLimit(3...8)
                }

                Section {
                    DatePicker(
                        "Fecha y hora",
                        selection: $scheduledDate,
                        in: Date().addingTimeInterval(60)...,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    // Regla dura: la hora se elige/lee en la zona del NEGOCIO.
                    .environment(\.timeZone, businessTimeZone)
                } header: {
                    Text("Envío")
                } footer: {
                    Text("La hora usa la zona horaria del negocio.")
                }

                Section {
                    Button {
                        save()
                    } label: {
                        if isSaving {
                            HStack {
                                ProgressView()
                                Text("Programando…")
                            }
                        } else {
                            Text("Programar")
                                .frame(maxWidth: .infinity)
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(isSaving || messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .scrollContentBackground(.hidden)
        }
        .alert("No se programó el mensaje", isPresented: errorBinding) {
            Button("Entendido", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            do {
                try await viewModel.scheduleMessage(for: contact, text: messageText, at: scheduledDate)
                isSaving = false
                dismiss()
            } catch {
                isSaving = false
                errorMessage = (error as? RistakAPIError)?.message ?? "Intenta otra vez."
            }
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )
    }
}
