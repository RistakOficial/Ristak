import SwiftUI

// Sheets del composer: programar mensaje, plantillas, canal y etiquetas.

// MARK: - Programar mensaje (docs 04 §4 / 05 §2.10)

struct ThreadScheduleMessageSheet: View {
    @Bindable var viewModel: ConversationViewModel
    @State var state: ScheduleSheetState
    @Environment(\.dismiss) private var dismiss
    @Environment(AppConfigStore.self) private var appConfig

    @State private var isSaving = false

    var body: some View {
        SheetScaffold(
            title: state.editingId == nil ? "Programar mensaje" : "Editar programación",
            subtitle: viewModel.displayName
        ) {
            Form {
                Section("Mensaje") {
                    TextField("Escribe el mensaje", text: $state.text, axis: .vertical)
                        .lineLimit(3...8)
                }

                Section {
                    DatePicker(
                        "Fecha y hora",
                        selection: $state.date,
                        in: Date().addingTimeInterval(60)...,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                } footer: {
                    Text("La hora se programa en la zona horaria del negocio (\(appConfig.businessTimeZone.identifier)).")
                }

                Section {
                    Button {
                        save()
                    } label: {
                        if isSaving {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text(state.editingId == nil ? "Programar" : "Guardar cambios")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isSaving)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        Task {
            let ok = await viewModel.submitSchedule(state)
            isSaving = false
            if ok { dismiss() }
        }
    }
}

// MARK: - Plantillas (doc 05 §2.9)

struct TemplatesPickerSheet: View {
    @Bindable var viewModel: ConversationViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var templates: [WhatsAppTemplate] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var sendingTemplateID: String?

    var body: some View {
        SheetScaffold(title: "Plantillas", subtitle: viewModel.displayName) {
            VStack(spacing: 0) {
                if let reason = viewModel.templatesSheetReason {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, RistakTheme.Spacing.lg)
                        .padding(.bottom, RistakTheme.Spacing.xs)
                }

                if isLoading {
                    RistakLoadingView(message: "Cargando plantillas…")
                } else if let errorMessage {
                    RistakErrorState(message: errorMessage) {
                        Task { await load() }
                    }
                } else if templates.isEmpty {
                    RistakEmptyState(
                        icon: "square.text.square",
                        title: "Sin plantillas aprobadas",
                        message: "Sincroniza y aprueba plantillas en Configuración > WhatsApp para poder enviarlas."
                    )
                } else {
                    List(templates) { template in
                        Button {
                            send(template)
                        } label: {
                            HStack(alignment: .top, spacing: RistakTheme.Spacing.sm) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(template.name)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(RistakTheme.textPrimary)
                                    Text(template.previewText)
                                        .font(.caption)
                                        .foregroundStyle(RistakTheme.textDim)
                                        .lineLimit(3)
                                }
                                Spacer(minLength: 0)
                                if sendingTemplateID == template.id {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Text(template.statusLabel)
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(RistakTheme.pos)
                                }
                            }
                        }
                        .disabled(sendingTemplateID != nil)
                    }
                    .listStyle(.plain)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
        .onDisappear {
            viewModel.templatesSheetReason = nil
        }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            templates = try await viewModel.fetchSendableTemplates()
        } catch {
            errorMessage = (error as? RistakAPIError)?.message ?? "No se pudieron cargar las plantillas."
        }
        isLoading = false
    }

    private func send(_ template: WhatsAppTemplate) {
        guard sendingTemplateID == nil else { return }
        sendingTemplateID = template.id
        Task {
            await viewModel.sendTemplate(template)
            sendingTemplateID = nil
            dismiss()
        }
    }
}

// MARK: - Canal de envío (doc 05 §7.1)

struct ChannelPickerSheet: View {
    @Bindable var viewModel: ConversationViewModel

    var body: some View {
        SheetScaffold(title: "Elegir canal de envío", subtitle: viewModel.displayName) {
            List(viewModel.channelOptions) { option in
                Button {
                    viewModel.selectChannel(option)
                } label: {
                    HStack(spacing: RistakTheme.Spacing.sm) {
                        ComposerChannelIconView(channel: option.channel, size: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.title)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(RistakTheme.textPrimary)
                            Text(option.disabledReason ?? option.subtitle)
                                .font(.caption)
                                .foregroundStyle(option.disabledReason == nil ? RistakTheme.textDim : RistakTheme.warn)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                        if option.channel == viewModel.selectedChannel {
                            Image(systemName: "checkmark")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(RistakTheme.accent)
                        }
                    }
                    .opacity(option.disabledReason == nil ? 1 : 0.6)
                }
            }
            .listStyle(.plain)
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Etiquetas

struct TagPickerSheet: View {
    @Bindable var viewModel: ConversationViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var tags: [ContactTag] = []
    @State private var isLoading = true
    @State private var searchText = ""
    @State private var isApplying = false

    private var filteredTags: [ContactTag] {
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return tags }
        return tags.filter { $0.name.lowercased().contains(query) }
    }

    private var canCreate: Bool {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return false }
        return !tags.contains { $0.name.lowercased() == query.lowercased() }
    }

    var body: some View {
        SheetScaffold(title: "Agregar etiqueta", subtitle: viewModel.displayName) {
            VStack(spacing: 0) {
                TextField("Buscar o crear etiqueta", text: $searchText)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, RistakTheme.Spacing.sm)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control)
                            .fill(RistakTheme.surface)
                            .overlay(
                                RoundedRectangle(cornerRadius: RistakTheme.Radius.control)
                                    .strokeBorder(RistakTheme.border, lineWidth: 0.5)
                            )
                    )
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.xs)

                if isLoading {
                    RistakLoadingView(message: "Cargando etiquetas…")
                } else {
                    List {
                        if canCreate {
                            Button {
                                apply(searchText.trimmingCharacters(in: .whitespaces))
                            } label: {
                                Label("Crear «\(searchText.trimmingCharacters(in: .whitespaces))»", systemImage: "plus")
                                    .foregroundStyle(RistakTheme.accent)
                            }
                        }
                        ForEach(filteredTags) { tag in
                            Button {
                                apply(tag.id)
                            } label: {
                                Label(tag.name, systemImage: "tag")
                                    .foregroundStyle(RistakTheme.textPrimary)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .disabled(isApplying)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            tags = (try? await viewModel.fetchTags()) ?? []
            isLoading = false
        }
    }

    private func apply(_ tagIdOrName: String) {
        guard !isApplying else { return }
        isApplying = true
        Task {
            let ok = await viewModel.addTag(tagIdOrName)
            isApplying = false
            if ok { dismiss() }
        }
    }
}
