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
    var emptyHint: String = "Busca un contacto para agendar."
    /// Texto del CTA de alta rápida (User #5: «Nuevo contacto», a ancho total).
    var newContactTitle: String = "Nuevo contacto"
    let onSelect: (AppointmentContactSelection) -> Void

    @State private var query = ""
    @State private var results: [ChatContact] = []
    @State private var recentChats: [ChatContact] = []
    @State private var searching = false
    @State private var loadingRecents = true
    @State private var showNewContact = false
    private let contactsService = ContactsService()

    /// Avatar de fila (40pt). El separador arranca alineado al texto: avatar +
    /// gap `Spacing.sm` (12) = 52pt, idéntico en todas las filas del listado.
    private static let avatarSize: CGFloat = 40
    private var rowSeparatorInset: CGFloat { Self.avatarSize + RistakTheme.Spacing.sm }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var visibleContacts: [ChatContact] {
        trimmedQuery.isEmpty ? recentChats : results
    }

    var body: some View {
        // Todo en UN solo `List`: la alta rápida «Nuevo contacto» es la PRIMERA
        // fila del listado y se desplaza con el contenido (ya no queda fija
        // arriba). Sigue a ancho completo (User #5). Separadores unificados con
        // `.ristakRowSeparator()` (mismo inset/tinte) y sin las líneas nativas
        // en filas de estado/CTA (#1.1).
        List {
            Button {
                showNewContact = true
            } label: {
                Label(newContactTitle, systemImage: "person.badge.plus")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    // Fondo transparente (User #3): solo texto de acento + borde
                    // fino de acento, sin relleno de superficie.
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                            .fill(Color.clear)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                            .strokeBorder(RistakTheme.accent, lineWidth: 1.5)
                    )
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(
                top: RistakTheme.Spacing.xs,
                leading: RistakTheme.Spacing.lg,
                bottom: RistakTheme.Spacing.sm,
                trailing: RistakTheme.Spacing.lg
            ))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)

            if searching {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ProgressView()
                    Text("Buscando contactos...")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                }
                .listRowSeparator(.hidden)
            } else if visibleContacts.isEmpty {
                if loadingRecents && trimmedQuery.count < 2 {
                    HStack(spacing: RistakTheme.Spacing.xs) {
                        ProgressView()
                        Text("Cargando contactos...")
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                    .listRowSeparator(.hidden)
                } else {
                    Text(emptyHint)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .listRowSeparator(.hidden)
                }
            } else {
                ForEach(visibleContacts) { contact in
                    contactRow(contact)
                        .ristakRowSeparator(leadingInset: rowSeparatorInset)
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Buscar contacto")
        .task {
            // SWR: el último directorio exitoso se pinta desde memoria antes
            // de salir a red. Ya no se reconstruye la bandeja de chats completa
            // cada vez que alguien toca «Nueva cita».
            let cached = contactsService.cachedPickerContacts()
            recentChats = cached
            loadingRecents = cached.isEmpty
            if !trimmedQuery.isEmpty, results.isEmpty {
                results = filterContacts(cached, query: trimmedQuery)
            }
            if let fresh = try? await contactsService.fetchPickerContacts() {
                recentChats = fresh
                // Si el usuario ya empezó a escribir mientras llegaban los
                // recientes, una consulta de 1 carácter debe aparecer ahora;
                // las búsquedas remotas (>=2) conservan su propia respuesta.
                if trimmedQuery.count == 1 {
                    results = filterContacts(fresh, query: trimmedQuery)
                    searching = false
                }
            }
            loadingRecents = false
        }
        .task(id: query) {
            let requestedQuery = trimmedQuery
            guard !requestedQuery.isEmpty else {
                results = []
                searching = false
                return
            }

            let cached = contactsService.cachedPickerContacts(query: requestedQuery)
            results = cached.isEmpty
                ? filterContacts(recentChats, query: requestedQuery)
                : cached
            guard requestedQuery.count >= 2 else {
                searching = false
                return
            }

            searching = results.isEmpty
            try? await Task.sleep(nanoseconds: 90_000_000)
            guard !Task.isCancelled else { return }
            if let found = try? await contactsService.fetchPickerContacts(query: requestedQuery),
               !Task.isCancelled,
               requestedQuery == trimmedQuery {
                results = found
            }
            guard requestedQuery == trimmedQuery else { return }
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
                    size: Self.avatarSize,
                    channel: ChatRowSignals.badgeChannel(contact)
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

    private func filterContacts(_ contacts: [ChatContact], query: String) -> [ChatContact] {
        let folded = query.folding(
            options: [.caseInsensitive, .diacriticInsensitive],
            locale: Locale(identifier: "es_MX")
        ).lowercased()
        let digits = query.filter(\.isNumber)
        return contacts.filter { contact in
            let text = [contact.name, contact.email]
                .joined(separator: " ")
                .folding(
                    options: [.caseInsensitive, .diacriticInsensitive],
                    locale: Locale(identifier: "es_MX")
                )
                .lowercased()
            return text.contains(folded)
                || (!digits.isEmpty && contact.phone.filter(\.isNumber).contains(digits))
        }
    }
}

// MARK: - Contact picker como sheet modal reutilizable

/// Envuelve `AppointmentContactPickerView` en su propio `NavigationStack` con
/// título y botón de cierre. Es el MISMO buscador del alta de cita, reutilizado
/// como modal para invitados (User #4): buscar contactos existentes + botón
/// «Nuevo contacto». Devuelve la selección y se cierra.
struct AppointmentContactPickerSheet: View {
    var title: String = "Agregar invitados"
    var emptyHint: String = "Busca un contacto para invitar."
    let onSelect: (AppointmentContactSelection) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AppointmentContactPickerView(
                title: title,
                emptyHint: emptyHint,
                onSelect: { selection in
                    onSelect(selection)
                    dismiss()
                }
            )
            .navigationTitle(title)
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
                            if saving {
                                ProgressView()
                                    .tint(RistakTheme.onAccent)
                            }
                            Text("Crear contacto")
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(saving)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
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
