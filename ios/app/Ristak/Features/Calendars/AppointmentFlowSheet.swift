import SwiftUI

/// Sheet del flujo Nueva cita / Editar cita. En creación arranca con el
/// contact picker (título «Nueva cita», subtítulo = fecha elegida) y pasa al
/// formulario dentro del MISMO sheet al elegir contacto (doc 07 §6.1); con
/// contacto precargado (deep link / chat) salta directo al formulario.
struct AppointmentFlowSheet: View {
    let context: AppointmentFlowContext
    let calendars: [RistakCalendar]
    let preferredCalendarID: String?
    let timeZone: TimeZone
    let onSaved: (CalendarAppointment) -> Void

    @State private var formModel: AppointmentFormViewModel?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let formModel {
                    AppointmentFormView(model: formModel, onSaved: onSaved)
                } else if case .create(let prefill, _) = context.kind {
                    AppointmentContactPickerView(
                        title: "Nueva cita",
                        subtitle: CalendarDateMath.dayHeader(prefill.day, timeZone: timeZone),
                        emptyHint: "Busca un contacto para agendar.",
                        onSelect: { selection in
                            withAnimation(.snappy) {
                                formModel = makeCreateModel(prefill: prefill, contact: selection)
                            }
                        }
                    )
                    .navigationTitle("Nueva cita")
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
                }
            }
        }
        .onAppear {
            guard formModel == nil else { return }
            switch context.kind {
            case .edit(let appointment):
                formModel = AppointmentFormViewModel(
                    edit: appointment,
                    calendars: calendars,
                    timeZone: timeZone
                )
            case .create(let prefill, let contact):
                if let contact {
                    formModel = makeCreateModel(prefill: prefill, contact: contact)
                }
            }
        }
    }

    private func makeCreateModel(prefill: AppointmentPrefill, contact: AppointmentContactSelection) -> AppointmentFormViewModel {
        AppointmentFormViewModel(
            createIn: calendars,
            preferredCalendarID: preferredCalendarID,
            prefill: prefill,
            contact: contact,
            timeZone: timeZone
        )
    }
}

// MARK: - Contact picker

/// Buscador de contacto para agendar: ≥2 caracteres busca en
/// `/api/contacts/search`; sin búsqueda muestra chats recientes (paridad RN).
/// Filas SIN icono de enviar mensaje — la acción es agendar.
struct AppointmentContactPickerView: View {
    let title: String
    let subtitle: String
    var emptyHint: String = "Busca un contacto para agendar."
    let onSelect: (AppointmentContactSelection) -> Void

    @State private var query = ""
    @State private var results: [ChatContact] = []
    @State private var recentChats: [ChatContact] = []
    @State private var searching = false
    @State private var loadingRecents = true
    @State private var showNewContact = false

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var visibleContacts: [ChatContact] {
        trimmedQuery.count >= 2 ? results : recentChats
    }

    var body: some View {
        List {
            Section {
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
                }

                Button {
                    showNewContact = true
                } label: {
                    Label("Crear contacto nuevo", systemImage: "person.badge.plus")
                        .foregroundStyle(RistakTheme.accent)
                }
            }

            Section {
                if searching {
                    HStack(spacing: RistakTheme.Spacing.xs) {
                        ProgressView()
                        Text("Buscando contactos...")
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                } else if visibleContacts.isEmpty {
                    if loadingRecents && trimmedQuery.count < 2 {
                        HStack(spacing: RistakTheme.Spacing.xs) {
                            ProgressView()
                            Text("Cargando contactos...")
                                .font(.subheadline)
                                .foregroundStyle(RistakTheme.textDim)
                        }
                    } else {
                        Text(emptyHint)
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                } else {
                    ForEach(visibleContacts) { contact in
                        contactRow(contact)
                    }
                }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Buscar contacto")
        .task {
            recentChats = (try? await ChatsService().fetchChats(limit: 25)) ?? []
            loadingRecents = false
        }
        .task(id: query) {
            guard trimmedQuery.count >= 2 else {
                results = []
                searching = false
                return
            }
            searching = true
            try? await Task.sleep(nanoseconds: 240_000_000)
            guard !Task.isCancelled else { return }
            let found = (try? await ContactsService().searchContacts(query: trimmedQuery)) ?? []
            guard !Task.isCancelled else { return }
            results = found
            searching = false
        }
        .sheet(isPresented: $showNewContact) {
            AppointmentNewContactSheet { selection in
                showNewContact = false
                onSelect(selection)
            }
            .presentationDetents([.medium, .large])
        }
    }

    private func contactRow(_ contact: ChatContact) -> some View {
        Button {
            onSelect(AppointmentContactSelection(chat: contact))
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                ContactAvatarView(
                    name: contact.name.isEmpty ? contact.phone : contact.name,
                    photoURL: contact.profilePhotoUrl.flatMap(URL.init(string:)),
                    size: 40
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(contact.name.isEmpty ? (contact.phone.isEmpty ? contact.email : contact.phone) : contact.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)
                    if !contact.phone.isEmpty || !contact.email.isEmpty {
                        Text(contact.phone.isEmpty ? contact.email : contact.phone)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Crear contacto inline

/// Alta rápida de contacto desde el flujo de citas (`POST /api/contacts`).
/// NOTA: cuando el módulo Chats exponga su `NewContactSheet(onCreated:)`
/// compartido, este sheet puede sustituirse por aquél.
struct AppointmentNewContactSheet: View {
    let onCreated: (AppointmentContactSelection) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var phone = ""
    @State private var email = ""
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        SheetScaffold(title: "Crear contacto") {
            Form {
                Section {
                    TextField("Nombre", text: $name, prompt: Text("Nombre completo"))
                        .textContentType(.name)
                    TextField("Teléfono", text: $phone, prompt: Text("Teléfono con lada"))
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                    TextField("Correo", text: $email, prompt: Text("correo@dominio.com"))
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(RistakTheme.neg)
                    }
                }

                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack(spacing: RistakTheme.Spacing.xs) {
                            if saving { ProgressView() }
                            Text("Crear contacto")
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(saving)
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func save() async {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPhone = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !(trimmedPhone.isEmpty && trimmedEmail.isEmpty) else {
            errorMessage = "Escribe nombre y teléfono o correo."
            return
        }

        saving = true
        errorMessage = nil
        defer { saving = false }
        do {
            let created = try await ContactsService().createContact(
                ContactCreateRequest(
                    name: trimmedName,
                    email: trimmedEmail.isEmpty ? nil : trimmedEmail,
                    phone: trimmedPhone.isEmpty ? nil : trimmedPhone
                )
            )
            onCreated(AppointmentContactSelection(chat: created))
            dismiss()
        } catch let error as RistakAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "No se pudo crear el contacto. Intenta otra vez."
        }
    }
}

// MARK: - Selector de calendarios (raíz)

/// Sheet/popover «Calendarios» de la pantalla principal: color, nombre y
/// check en el activo. Cambiarlo recarga eventos y persiste la selección.
struct CalendarPickerSheet: View {
    let calendars: [RistakCalendar]
    let selectedID: String?
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetScaffold(title: "Calendarios") {
            if calendars.isEmpty {
                RistakEmptyState(
                    icon: "calendar",
                    title: "No hay calendarios conectados.",
                    message: "Conecta o crea un calendario desde el escritorio."
                )
            } else {
                List {
                    ForEach(calendars) { calendar in
                        Button {
                            onSelect(calendar.id)
                            dismiss()
                        } label: {
                            HStack(spacing: RistakTheme.Spacing.sm) {
                                Circle()
                                    .fill(calendar.displayColor)
                                    .frame(width: 12, height: 12)

                                VStack(alignment: .leading, spacing: 1) {
                                    Text(calendar.name)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(calendar.isActive ? RistakTheme.textPrimary : RistakTheme.textDim)
                                    if !calendar.isActive {
                                        Text("Inactivo")
                                            .font(.caption)
                                            .foregroundStyle(RistakTheme.textMute)
                                    }
                                }

                                Spacer()

                                if calendar.id == selectedID {
                                    Image(systemName: "checkmark")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(RistakTheme.accent)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(calendar.id == selectedID ? .isSelected : [])
                    }
                }
                .listStyle(.plain)
            }
        }
    }
}
