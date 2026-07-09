import SwiftUI
import UIKit

/// Ficha "Info del contacto" (doc 06 §4.1). Contrato cross-agente:
/// `ContactInfoScreen(contactID:)` — el hilo la pushea en compacto y la
/// bandeja/iPad la presentan en sheet/inspector.
struct ContactInfoScreen: View {
    @State private var viewModel: ContactInfoViewModel

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(SessionStore.self) private var session
    @Environment(AccessStore.self) private var access
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    // Edición inline (patrón /movil: lápiz → input, check guarda, X cancela).
    private enum EditingField {
        case name
        case phone
        case email
    }

    @State private var editingField: EditingField?
    @State private var draftText = ""
    @FocusState private var inlineFieldFocused: Bool

    // Presentaciones
    @State private var showTagsSheet = false
    @State private var showPaymentsPanel = false
    @State private var showAppointmentsPanel = false
    @State private var showJourneyPanel = false
    @State private var showArchivePanel = false
    @State private var showAutomationsSheet = false
    @State private var editingCustomField: ContactInfoViewModel.CustomFieldRow?
    @State private var tagPendingRemoval: ContactTag?

    /// Aviso sutil tras inscribir en una automatización (auto-oculta).
    @State private var automationNotice: String?

    private let localFlags = ContactLocalFlagsStore.shared

    /// Canal de mensajería del contacto (el mismo del header del hilo). Se muestra
    /// bajo el nombre. `nil` si el hilo no detectó canal → no se pinta la fila.
    private let channel: RistakChatChannel?

    init(contactID: String, channel: RistakChatChannel? = nil) {
        _viewModel = State(initialValue: ContactInfoViewModel(contactID: contactID))
        self.channel = channel
    }

    var body: some View {
        Group {
            switch viewModel.phase {
            case .loading:
                RistakLoadingView(message: "Cargando contacto…")

            case .notFound:
                RistakEmptyState(
                    icon: "person.crop.circle.badge.questionmark",
                    title: "Contacto no disponible",
                    message: "Este contacto ya no está disponible o fue movido a la papelera."
                )

            case .accessDenied(let message):
                RistakEmptyState(
                    icon: "lock.fill",
                    title: "Sin acceso",
                    message: message
                )

            case .failed(let message):
                RistakErrorState(message: message) {
                    Task { await viewModel.load() }
                }

            case .loaded:
                content
            }
        }
        .navigationTitle("Info del contacto")
        .navigationBarTitleDisplayMode(.inline)
        .background(RistakTheme.bgGrouped)
        .task {
            localFlags.configure(accountKey: session.baseURL?.host())
            await viewModel.loadIfNeeded()
        }
        // Journey completo en paralelo (paridad /movil: la ficha carga su
        // recorrido de forma silenciosa). Se recarga si vuelve a aparecer.
        .task(id: appConfig.businessTimeZone) {
            await viewModel.loadJourneyIfNeeded(formatters: appConfig.formatters)
        }
        .sensoryFeedback(.success, trigger: viewModel.successFeedbackCount)
        // Alert genérico de errores de guardado (nombre/teléfono/correo/quitar etiqueta).
        .alert(
            viewModel.alert?.title ?? "",
            isPresented: Binding(
                get: { viewModel.alert != nil },
                set: { if !$0 { viewModel.alert = nil } }
            ),
            presenting: viewModel.alert
        ) { _ in
            Button("Entendido", role: .cancel) {}
        } message: { alert in
            Text(alert.message)
        }
        // Confirmación de cambio de número (copy /movil, doc 06 §4.1.6).
        .alert(
            "Confirmar nuevo número",
            isPresented: Binding(
                get: { viewModel.phoneConfirmation != nil },
                set: { if !$0 { viewModel.phoneConfirmation = nil } }
            ),
            presenting: viewModel.phoneConfirmation
        ) { confirmation in
            Button("Sí, cambiar número") {
                Task { await viewModel.confirmPhoneChange(confirmation) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: { confirmation in
            Text("Revisa que el número esté bien escrito antes de guardarlo:\n\(confirmation.newPhone)\n\nNúmero actual: \(confirmation.currentPhone.isEmpty ? "sin número" : confirmation.currentPhone)")
        }
        // 409 de fusión — SOLO teléfono fusiona (audit doc 06).
        .alert(
            "El teléfono ya pertenece a otro contacto",
            isPresented: Binding(
                get: { viewModel.mergePrompt != nil },
                set: { if !$0 { viewModel.mergePrompt = nil } }
            ),
            presenting: viewModel.mergePrompt
        ) { prompt in
            Button("Fusionar contactos", role: .destructive) {
                Task { await viewModel.confirmMerge(prompt) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: { prompt in
            Text(mergeMessage(for: prompt))
        }
        // Quitar etiqueta (confirmación destructiva).
        .alert(
            "Quitar etiqueta",
            isPresented: Binding(
                get: { tagPendingRemoval != nil },
                set: { if !$0 { tagPendingRemoval = nil } }
            ),
            presenting: tagPendingRemoval
        ) { tag in
            Button("Quitar", role: .destructive) {
                Task { await viewModel.removeTag(tag) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: { tag in
            Text("Se quitará \"\(tag.name)\" de este contacto.")
        }
        .sheet(isPresented: $showTagsSheet) {
            ContactTagsSheet(viewModel: viewModel)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showPaymentsPanel) {
            ContactPaymentsPanel(
                contactName: viewModel.contact?.name ?? "",
                payments: viewModel.contact?.payments ?? [],
                totalPaid: viewModel.contact?.ltv ?? 0,
                formatters: appConfig.formatters
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAppointmentsPanel) {
            ContactAppointmentsPanel(
                contactName: viewModel.contact?.name ?? "",
                appointments: viewModel.contact?.appointments ?? [],
                timeZone: appConfig.businessTimeZone
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showJourneyPanel) {
            ContactJourneyPanel(
                phase: viewModel.journeyPhase,
                items: viewModel.journeyItems,
                timeZone: appConfig.businessTimeZone,
                onRetry: {
                    Task { await viewModel.retryJourney(formatters: appConfig.formatters) }
                }
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showArchivePanel) {
            ContactArchivePanel(
                contactName: viewModel.contact?.name ?? "",
                phase: viewModel.journeyPhase,
                items: viewModel.archiveItems,
                timeZone: appConfig.businessTimeZone,
                onRetry: {
                    Task { await viewModel.retryJourney(formatters: appConfig.formatters) }
                }
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $editingCustomField) { row in
            ContactCustomFieldEditorSheet(
                row: row,
                formatters: appConfig.formatters
            ) { newValue in
                await viewModel.saveCustomField(row: row, newValue: newValue)
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAutomationsSheet) {
            ContactAutomationEnrollSheet(
                contactID: viewModel.contactID,
                contactName: viewModel.contact?.name ?? ""
            ) { automationName in
                showAutomationNotice("Contacto agregado a «\(automationName)»")
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    /// Muestra un aviso sutil de éxito y lo oculta a los pocos segundos.
    private func showAutomationNotice(_ text: String) {
        withAnimation(.easeInOut(duration: 0.2)) { automationNotice = text }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation(.easeInOut(duration: 0.2)) { automationNotice = nil }
        }
    }

    private func mergeMessage(for prompt: ContactInfoViewModel.MergePrompt) -> String {
        var lines = [prompt.message]
        if let summary = prompt.conflictSummary {
            lines.append("Contacto en conflicto: \(summary)")
        }
        lines.append("Al fusionar, el otro contacto se combinará con este y se eliminará.")
        return lines.joined(separator: "\n\n")
    }

    // MARK: - Contenido

    @ViewBuilder
    private var content: some View {
        if let contact = viewModel.contact {
            ScrollView {
                VStack(spacing: RistakTheme.Spacing.md) {
                    if let automationNotice {
                        automationNoticePill(automationNotice)
                    }

                    if viewModel.isRefreshing {
                        refreshingPill
                    }

                    heroSection(contact)
                    metricsSection(contact)
                    mainDataSection(contact)
                    archiveSection(contact)
                    tagsSection(contact)
                    customFieldsSection
                    originSection(contact)
                    followUpSection(contact)
                    agentSection
                    automationsSection
                    localChatSection(contact)
                }
                .frame(maxWidth: horizontalSizeClass == .regular ? 640 : .infinity)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, RistakTheme.Spacing.md)
                .padding(.vertical, RistakTheme.Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await viewModel.refresh() }
        }
    }

    /// Pill "Actualizando datos" (paridad /movil, doc 06 §4.1).
    private var refreshingPill: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            ProgressView()
                .controlSize(.mini)
            Text("Actualizando datos")
                .font(.caption)
                .foregroundStyle(RistakTheme.textDim)
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, 6)
        .background(Capsule().fill(RistakTheme.controlRest))
        .transition(.opacity)
    }

    // MARK: Hero

    private func heroSection(_ contact: ContactDetail) -> some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            ContactAvatarView(
                name: contact.name,
                photoURL: contact.profilePhotoUrl.flatMap { URL(string: $0) },
                size: 76
            )

            if editingField == .name {
                inlineEditor(
                    placeholder: "Nombre del contacto",
                    keyboard: .default,
                    isSaving: viewModel.isSavingName
                ) {
                    let saved = await viewModel.saveName(draftText)
                    if saved { stopEditing() }
                }
                .frame(maxWidth: 320)
            } else {
                Button {
                    startEditing(.name, initial: contact.name)
                } label: {
                    HStack(spacing: RistakTheme.Spacing.xs) {
                        Text(contact.name.isEmpty ? "Contacto sin nombre" : contact.name)
                            .font(.title3.bold())
                            .foregroundStyle(RistakTheme.textPrimary)
                            .multilineTextAlignment(.center)

                        Image(systemName: "pencil")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canEditContact)
                .accessibilityLabel("Editar nombre")
            }

            if !heroDetailLine(contact).isEmpty {
                Text(heroDetailLine(contact))
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
            }

            // Canal de mensajería del contacto (de dónde se le escribe): badge +
            // nombre, justo bajo el nombre y encima de la etiqueta de estado.
            if let channel {
                HStack(spacing: RistakTheme.Spacing.xxs) {
                    ChannelBadgeView(channel: channel, size: 16)
                    Text(channel.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textDim)
                }
            }

            ContactInfoStageBadge(stage: ContactInfoStage(status: contact.status))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, RistakTheme.Spacing.xs)
    }

    private func heroDetailLine(_ contact: ContactDetail) -> String {
        if !contact.phone.isEmpty { return contact.phone }
        if !contact.email.isEmpty { return contact.email }
        return contact.source ?? ""
    }

    // MARK: Métricas (doc 06 §4.1.4)

    private func metricsSection(_ contact: ContactDetail) -> some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Button {
                showPaymentsPanel = true
            } label: {
                KPICardView(
                    icon: "banknote",
                    title: "Total",
                    value: appConfig.formatters.currency(contact.ltv),
                    delta: paymentsCountLabel(contact),
                    trend: contact.ltv > 0 ? .positive : .neutral
                )
            }
            .buttonStyle(.plain)
            .accessibilityHint("Ver pagos del contacto")

            Button {
                showAppointmentsPanel = true
            } label: {
                KPICardView(
                    icon: "calendar",
                    title: "Citas",
                    value: "\(contact.appointments.count)",
                    delta: appointmentsCountLabel,
                    trend: .neutral
                )
            }
            .buttonStyle(.plain)
            .accessibilityHint("Ver citas del contacto")
        }
    }

    private func paymentsCountLabel(_ contact: ContactDetail) -> String {
        let count = contact.successfulPaymentsCount
        return count == 1 ? "1 pago" : "\(count) pagos"
    }

    private var appointmentsCountLabel: String {
        let active = viewModel.activeAppointmentsCount
        return active == 1 ? "1 activa" : "\(active) activas"
    }

    // MARK: Datos principales (doc 06 §4.1.6)

    private func mainDataSection(_ contact: ContactDetail) -> some View {
        SectionCard(title: "Datos principales") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                // Número principal (editable).
                if editingField == .phone {
                    editableRowHeader("Número")
                    inlineEditor(
                        placeholder: "+52...",
                        keyboard: .phonePad,
                        isSaving: viewModel.isSavingPhone
                    ) {
                        if viewModel.requestPhoneChange(draftText) {
                            stopEditing()
                        }
                    }
                } else {
                    editableRow(
                        label: "Número",
                        value: contact.phone,
                        placeholder: "Sin número"
                    ) {
                        startEditing(.phone, initial: contact.phone)
                    }
                }

                // Teléfonos adicionales (solo lectura, doc 06 §6.11).
                ForEach(additionalPhones(contact)) { phone in
                    ContactInfoRow(
                        label: phone.label.isEmpty ? "Adicional" : phone.label,
                        value: phone.phone
                    )
                }

                divider

                // Correo (editable).
                if editingField == .email {
                    editableRowHeader("Correo")
                    inlineEditor(
                        placeholder: "correo@ejemplo.com",
                        keyboard: .emailAddress,
                        isSaving: viewModel.isSavingEmail
                    ) {
                        let saved = await viewModel.saveEmail(draftText)
                        if saved { stopEditing() }
                    }
                } else {
                    editableRow(
                        label: "Correo",
                        value: contact.email,
                        placeholder: "Sin correo"
                    ) {
                        startEditing(.email, initial: contact.email)
                    }
                }

                divider

                ContactInfoRow(
                    label: "Contacto creado",
                    value: ContactInfoDates.longDate(fromISO: contact.createdAt, timeZone: appConfig.businessTimeZone)
                )

                HStack(spacing: RistakTheme.Spacing.sm) {
                    Text("Estado")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .frame(width: 112, alignment: .leading)

                    ContactInfoStageBadge(stage: ContactInfoStage(status: contact.status))
                }
            }
        }
    }

    private func additionalPhones(_ contact: ContactDetail) -> [ContactPhoneNumber] {
        contact.phones.filter { !$0.isPrimary && $0.phone != contact.phone }
    }

    private var divider: some View {
        Divider().overlay(RistakTheme.border.opacity(0.6))
    }

    private func editableRowHeader(_ label: String) -> some View {
        Text(label)
            .font(.subheadline)
            .foregroundStyle(RistakTheme.textDim)
    }

    private func editableRow(
        label: String,
        value: String,
        placeholder: String,
        onEdit: @escaping () -> Void
    ) -> some View {
        Button(action: onEdit) {
            HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.sm) {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(width: 112, alignment: .leading)

                Text(value.isEmpty ? placeholder : value)
                    .font(.subheadline)
                    .foregroundStyle(value.isEmpty ? RistakTheme.textMute : RistakTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "pencil")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canEditContact)
        .accessibilityLabel("Editar \(label.lowercased())")
    }

    /// Campo de edición inline: TextField + check para guardar + X para
    /// cancelar (patrón /movil).
    private func inlineEditor(
        placeholder: String,
        keyboard: UIKeyboardType,
        isSaving: Bool,
        onSave: @escaping () async -> Void
    ) -> some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            TextField(placeholder, text: $draftText)
                .font(.subheadline)
                .keyboardType(keyboard)
                .textInputAutocapitalization(keyboard == .default ? .words : .never)
                .autocorrectionDisabled()
                .focused($inlineFieldFocused)
                .submitLabel(.done)
                .onSubmit {
                    Task { await onSave() }
                }
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.controlBackground)
                )

            if isSaving {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button {
                    Task { await onSave() }
                } label: {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(RistakTheme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Guardar")

                Button {
                    stopEditing()
                } label: {
                    Image(systemName: "xmark.circle")
                        .font(.title3)
                        .foregroundStyle(RistakTheme.textDim)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancelar")
            }
        }
    }

    private func startEditing(_ field: EditingField, initial: String) {
        draftText = initial
        editingField = field
        inlineFieldFocused = true
    }

    private func stopEditing() {
        editingField = nil
        draftText = ""
        inlineFieldFocused = false
    }

    /// Permisos: sin escritura en Contactos se oculta/deshabilita la edición.
    private var canEditContact: Bool {
        access.canWrite(module: .contacts)
    }

    // MARK: Multimedia / archivos compartidos (doc 06 §4.1 + mobile/ archivos)

    /// Fila resumen "Archivos compartidos" que abre el panel de multimedia
    /// (fotos/videos/documentos/enlaces del chat). Los items se derivan del
    /// journey completo (mismo origen que el "Viaje de cliente").
    private func archiveSection(_ contact: ContactDetail) -> some View {
        SectionCard {
            ContactArchiveSummaryRow(
                phase: viewModel.journeyPhase,
                items: viewModel.archiveItems
            ) {
                if viewModel.journeyPhase == .failed {
                    Task { await viewModel.retryJourney(formatters: appConfig.formatters) }
                }
                showArchivePanel = true
            }
        }
    }

    // MARK: Etiquetas

    private func tagsSection(_ contact: ContactDetail) -> some View {
        SectionCard(title: "Etiquetas") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                ContactInfoFlowLayout(spacing: RistakTheme.Spacing.xs) {
                    // Etiqueta interna (client/booked/lead): visible e inmutable.
                    ContactInfoStageBadge(stage: ContactInfoStage(status: contact.status))

                    ForEach(viewModel.contactTags) { tag in
                        removableTagPill(tag)
                    }
                }

                if viewModel.contactTags.isEmpty {
                    Text("Este chat aún no tiene etiquetas.")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textMute)
                }

                if canEditContact {
                    Button {
                        showTagsSheet = true
                    } label: {
                        Label("Agregar etiqueta", systemImage: "plus")
                            .font(.subheadline.weight(.medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }

    private func removableTagPill(_ tag: ContactTag) -> some View {
        HStack(spacing: 5) {
            Text(tag.name)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(1)

            if canEditContact {
                Button {
                    tagPendingRemoval = tag
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(RistakTheme.textDim)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Quitar etiqueta \(tag.name)")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(RistakTheme.controlRest))
    }

    // MARK: Campos personalizados (doc 06 §4.1.10)

    private var customFieldsSection: some View {
        SectionCard(title: "Campos personalizados") {
            let rows = viewModel.customFieldRows
            if rows.isEmpty {
                Text(viewModel.definitionsLoadFailed
                     ? "No se cargaron los campos personalizados."
                     : "No hay campos personalizados guardados para este contacto.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textMute)
            } else {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    ForEach(rows) { row in
                        customFieldRow(row)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func customFieldRow(_ row: ContactInfoViewModel.CustomFieldRow) -> some View {
        let display = ContactInfoCustomFieldValueFormat.displayString(
            row.value?.value,
            dataType: row.dataType,
            options: row.options,
            formatters: appConfig.formatters
        )

        if row.isEditable && canEditContact {
            Button {
                editingCustomField = row
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.sm) {
                    Text(row.label)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .frame(width: 112, alignment: .leading)

                    Text(display.isEmpty ? "Sin dato" : display)
                        .font(.subheadline)
                        .foregroundStyle(display.isEmpty ? RistakTheme.textMute : RistakTheme.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .multilineTextAlignment(.leading)

                    if viewModel.savingFieldID == row.id {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "pencil")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Editar \(row.label)")
        } else {
            ContactInfoRow(label: row.label, value: display)
        }
    }

    // MARK: Origen y conversión (doc 06 §4.1.7)

    @ViewBuilder
    private func originSection(_ contact: ContactDetail) -> some View {
        let rows = originRows(contact)
        SectionCard(title: "Origen y conversión") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                ForEach(rows, id: \.0) { label, value in
                    ContactInfoRow(label: label, value: value)
                }

                if !rows.isEmpty {
                    divider
                }

                // Viaje de cliente: abre el recorrido completo (nuevo → viejo).
                ContactJourneySummaryRow(
                    phase: viewModel.journeyPhase,
                    count: viewModel.journeyItems.count
                ) {
                    if viewModel.journeyPhase == .failed {
                        Task { await viewModel.retryJourney(formatters: appConfig.formatters) }
                    }
                    showJourneyPanel = true
                }
            }
        }
    }

    /// Sólo lo esencial de la conversión: canal, fecha de conversión, fecha de
    /// primer pago y fecha de primera cita. Cada fila aparece SÓLO si tiene
    /// valor (sin filas vacías, sin el resto de la atribución).
    private func originRows(_ contact: ContactDetail) -> [(String, String)] {
        var rows: [(String, String)] = []

        // Canal donde convirtió (etiqueta legible del origen; se oculta si es
        // genérico/desconocido).
        if let channel = conversionChannelLabel(contact) {
            rows.append(("Canal donde convirtió", channel))
        }
        // Fecha de conversión: cuando el visitante se convirtió en contacto.
        let conversion = ContactInfoDates.dateTime(fromISO: contact.createdAt, timeZone: appConfig.businessTimeZone)
        if !conversion.isEmpty {
            rows.append(("Fecha de conversión", conversion))
        }
        // Fecha de primer pago (primer pago recibido).
        if let firstPayment = firstPaymentDateLabel() {
            rows.append(("Fecha de primer pago", firstPayment))
        }
        // Fecha de primera cita.
        if let firstAppointment = firstAppointmentDateLabel(contact) {
            rows.append(("Fecha de primera cita", firstAppointment))
        }
        return rows
    }

    private func conversionChannelLabel(_ contact: ContactDetail) -> String? {
        guard let raw = firstNonEmpty(
            contact.source,
            contact.attributionSessionSource,
            contact.whatsappAttributionPlatform
        ) else { return nil }
        let label = ContactInfoChannelLabel.friendly(raw)
        return label.isEmpty ? nil : label
    }

    private func firstPaymentDateLabel() -> String? {
        let dates = viewModel.receivedPayments
            .compactMap { RistakDateParsing.date(fromISO: $0.paymentDate ?? $0.createdAt) }
        guard let first = dates.min() else { return nil }
        var style = Date.FormatStyle(date: .abbreviated, time: .shortened)
        style.locale = BusinessFormatters.locale
        style.timeZone = appConfig.businessTimeZone
        return first.formatted(style)
    }

    private func firstAppointmentDateLabel(_ contact: ContactDetail) -> String? {
        guard let first = contact.firstAppointmentDate,
              RistakDateParsing.date(fromISO: first) != nil else { return nil }
        let formatted = ContactInfoDates.dateTime(fromISO: first, timeZone: appConfig.businessTimeZone)
        return formatted.isEmpty ? nil : formatted
    }

    private func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            if let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return nil
    }

    // MARK: Seguimiento (doc 06 §4.1.8)

    @ViewBuilder
    private func followUpSection(_ contact: ContactDetail) -> some View {
        let recent = Array(viewModel.receivedPayments.prefix(3))
        let next = viewModel.nextAppointment

        if next != nil || !recent.isEmpty {
            SectionCard(title: "Seguimiento") {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    if let next {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Próxima cita")
                                .font(.subheadline)
                                .foregroundStyle(RistakTheme.textDim)
                            Text(nextAppointmentLine(next))
                                .font(.subheadline)
                                .foregroundStyle(RistakTheme.textPrimary)
                        }
                    }

                    if next != nil && !recent.isEmpty {
                        divider
                    }

                    ForEach(recent) { payment in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(appConfig.formatters.currency(payment.amount, currencyOverride: payment.currency))
                                    .font(.subheadline.weight(.semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(RistakTheme.textPrimary)
                                Text(ContactInfoDates.dateTime(fromISO: payment.paymentDate ?? payment.createdAt, timeZone: appConfig.businessTimeZone))
                                    .font(.caption)
                                    .foregroundStyle(RistakTheme.textDim)
                            }

                            Spacer()

                            Text(ContactInfoPaymentStatus.label(payment.status))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(ContactInfoPaymentStatus.color(payment.status))
                        }
                    }
                }
            }
        }
    }

    private func nextAppointmentLine(_ appointment: ContactEmbeddedAppointment) -> String {
        var parts: [String] = []
        let when = ContactInfoDates.dateTime(fromISO: appointment.startTime, timeZone: appConfig.businessTimeZone)
        if !when.isEmpty { parts.append(when) }
        let title = (appointment.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let status = ContactInfoAppointmentStatus.label(appointment.status)
        parts.append(title.isEmpty ? status : "\(title) · \(status)")
        return parts.joined(separator: "\n")
    }

    // MARK: Agente conversacional (copy doc 03 §4.4)

    @ViewBuilder
    private var agentSection: some View {
        if let state = viewModel.agentState, viewModel.agentPanelVisible {
            SectionCard(title: "Agente conversacional") {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    HStack(spacing: RistakTheme.Spacing.xs) {
                        Text(state.agentName?.isEmpty == false ? state.agentName! : "Agente")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(RistakTheme.textPrimary)

                        Text(agentStatusLabel(state.status))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(agentStatusColor(state.status))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(RistakTheme.controlRest))

                        Spacer()

                        if viewModel.isAgentActionRunning {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }

                    if let summary = state.signalSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                        Text(summary)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                    }

                    agentActions(for: state)
                }
            }
        }
    }

    @ViewBuilder
    private func agentActions(for state: ConversationAgentState) -> some View {
        let status = state.status.lowercased()
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            if status == "active" {
                agentActionRow(
                    title: "Pausar agente",
                    subtitle: "Detiene el agente durante 24 horas.",
                    icon: "pause.circle"
                ) { await viewModel.agentPause() }

                agentActionRow(
                    title: "Tomar chat",
                    subtitle: "Detiene al agente y deja esta conversación en humano.",
                    icon: "person.fill.checkmark"
                ) { await viewModel.agentTakeOver() }

                agentActionRow(
                    title: "Omitir agente",
                    subtitle: "El agente no vuelve a tomar este chat hasta reactivarlo.",
                    icon: "nosign",
                    isDestructive: true
                ) { await viewModel.agentSkip() }
            } else {
                agentActionRow(
                    title: "Continuar agente",
                    subtitle: "El agente vuelve a atender este chat.",
                    icon: "play.circle"
                ) { await viewModel.agentResume() }
            }
        }
    }

    private func agentActionRow(
        title: String,
        subtitle: String,
        icon: String,
        isDestructive: Bool = false,
        action: @escaping () async -> Void
    ) -> some View {
        Button {
            Task { await action() }
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isDestructive ? RistakTheme.neg : RistakTheme.accent)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(isDestructive ? RistakTheme.neg : RistakTheme.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isAgentActionRunning)
    }

    private func agentStatusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "active": return "Activo"
        case "paused": return "Pausado"
        case "human": return "En humano"
        case "skipped": return "Omitido"
        case "completed": return "Completado"
        case "discarded": return "Descartado"
        default: return status.capitalized
        }
    }

    private func agentStatusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "active": return RistakTheme.pos
        case "paused": return RistakTheme.warn
        case "skipped", "discarded": return RistakTheme.neg
        default: return RistakTheme.textDim
        }
    }

    // MARK: Automatizaciones ("Meter a automatización", #7)

    /// Acceso a inscribir el contacto en una automatización publicada. Solo se
    /// muestra con permiso de escritura en Contactos (acción mutante); el backend
    /// re-valida el módulo de automatizaciones por request.
    @ViewBuilder
    private var automationsSection: some View {
        if canEditContact {
            SectionCard {
                Button {
                    showAutomationsSheet = true
                } label: {
                    HStack(spacing: RistakTheme.Spacing.sm) {
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                            .fill(RistakTheme.accentSoft)
                            .frame(width: 44, height: 44)
                            .overlay(
                                Image(systemName: "arrow.triangle.branch")
                                    .font(.system(size: 19, weight: .semibold))
                                    .foregroundStyle(RistakTheme.accent)
                            )

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Meter a una automatización")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(RistakTheme.textPrimary)
                                .lineLimit(1)

                            Text("Inscribe al contacto en una secuencia publicada.")
                                .font(.footnote)
                                .foregroundStyle(RistakTheme.textDim)
                                .lineLimit(2)
                        }

                        Spacer(minLength: 0)

                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(RistakTheme.textMute)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Meter a una automatización")
            }
        }
    }

    /// Aviso sutil de éxito tras inscribir en una automatización.
    private func automationNoticePill(_ text: String) -> some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "checkmark.circle.fill")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.pos)
            Text(text)
                .font(.footnote.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.posSoft)
        )
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    // MARK: Chat en este dispositivo (estado local, doc 03 §4.8)

    private func localChatSection(_ contact: ContactDetail) -> some View {
        SectionCard(title: "Chat en este dispositivo") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                Toggle(isOn: archivedBinding(contact.id)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Archivar chat")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(RistakTheme.textPrimary)
                        Text("Mueve la conversación a Archivados.")
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }

                Toggle(isOn: mutedBinding(contact.id)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Silenciar chat")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(RistakTheme.textPrimary)
                        Text("Marca este chat como silenciado.")
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }

                Text("Se guarda solo en este dispositivo.")
                    .font(.caption2)
                    .foregroundStyle(RistakTheme.textMute)
            }
        }
    }

    private func archivedBinding(_ contactID: String) -> Binding<Bool> {
        Binding(
            get: { localFlags.isArchived(contactID) },
            set: { localFlags.setArchived($0, for: contactID) }
        )
    }

    private func mutedBinding(_ contactID: String) -> Binding<Bool> {
        Binding(
            get: { localFlags.isMuted(contactID) },
            set: { localFlags.setMuted($0, for: contactID) }
        )
    }
}

// MARK: - Layout de chips (wrap)

/// Layout de flujo simple para pills de etiquetas (envuelve a la siguiente
/// línea cuando no cabe).
struct ContactInfoFlowLayout: Layout {
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
        let maxWidth = bounds.width
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(
                at: CGPoint(x: bounds.minX + x, y: bounds.minY + y),
                anchor: .topLeading,
                proposal: ProposedViewSize(size)
            )
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
