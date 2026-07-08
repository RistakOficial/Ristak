import SwiftUI

/// Sheet "Agregar etiqueta" (copy exacto de /movil, doc 06 §4.1-etiquetas):
/// buscador "Buscar o crear etiqueta", catálogo de etiquetas de usuario,
/// fila «Crear "<texto>"» cuando no hay match exacto, y marca
/// "Ya está agregada" para las que el contacto ya tiene.
struct ContactTagsSheet: View {
    let viewModel: ContactInfoViewModel

    @Environment(\.dismiss) private var dismiss

    @State private var searchText = ""
    @State private var isWorking = false
    /// Mensaje inline (éxito/info/error) — regla móvil: confirmar con cambio
    /// visible, error sí puede ser aviso.
    @State private var statusMessage: String?
    @State private var statusIsError = false
    @State private var successPulse = 0

    var body: some View {
        SheetScaffold(
            title: "Agregar etiqueta",
            subtitle: viewModel.contact?.name
        ) {
            VStack(spacing: 0) {
                searchField
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.sm)

                if let statusMessage {
                    Text(statusMessage)
                        .font(.footnote)
                        .foregroundStyle(statusIsError ? RistakTheme.neg : RistakTheme.textDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, RistakTheme.Spacing.lg)
                        .padding(.bottom, RistakTheme.Spacing.xs)
                }

                listContent
            }
        }
        .sensoryFeedback(.success, trigger: successPulse)
    }

    // MARK: - Buscador

    private var searchField: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)

            TextField("Buscar o crear etiqueta", text: $searchText)
                .font(.subheadline)
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled()

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textMute)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Limpiar búsqueda")
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.controlBackground)
        )
    }

    // MARK: - Lista

    @ViewBuilder
    private var listContent: some View {
        let filtered = filteredTags
        let trimmedSearch = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasExactMatch = filtered.contains {
            $0.name.compare(trimmedSearch, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }

        if !viewModel.tagCatalogLoaded && filtered.isEmpty {
            RistakLoadingView(message: "Cargando etiquetas")
        } else if filtered.isEmpty && trimmedSearch.isEmpty {
            RistakEmptyState(
                icon: "tag",
                title: "Sin etiquetas",
                message: "Escribe un nombre para crear una etiqueta nueva."
            )
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    if !trimmedSearch.isEmpty && !hasExactMatch {
                        createRow(trimmedSearch)
                        rowDivider
                    }

                    ForEach(filtered) { tag in
                        tagRow(tag)
                        if tag.id != filtered.last?.id {
                            rowDivider
                        }
                    }
                }
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.bottom, RistakTheme.Spacing.lg)
            }
        }
    }

    private var rowDivider: some View {
        Divider()
            .overlay(RistakTheme.border.opacity(0.5))
            .padding(.leading, RistakTheme.Spacing.xs)
    }

    private var filteredTags: [ContactTag] {
        let catalog = viewModel.tagCatalog.filter { !$0.isSystem }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return catalog }
        return catalog.filter {
            $0.name.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    private func tagRow(_ tag: ContactTag) -> some View {
        let alreadyAdded = viewModel.contactHasTag(tag)
        return Button {
            guard !alreadyAdded else {
                showStatus("Etiqueta ya agregada", isError: false)
                return
            }
            apply { await viewModel.addTag(tag) }
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: "tag")
                    .font(.subheadline)
                    .foregroundStyle(alreadyAdded ? RistakTheme.textMute : RistakTheme.accent)

                Text(tag.name)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if alreadyAdded {
                    Text("Ya está agregada")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textMute)
                }
            }
            .padding(.vertical, RistakTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
    }

    private func createRow(_ name: String) -> some View {
        Button {
            apply { await viewModel.createAndAddTag(named: name) }
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: "plus.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.accent)

                VStack(alignment: .leading, spacing: 1) {
                    Text("Crear \"\(name)\"")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                    Text("Crear etiqueta y agregarla a este chat")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer(minLength: 0)

                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .padding(.vertical, RistakTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
    }

    // MARK: - Acciones

    private func apply(_ operation: @escaping () async -> ContactInfoViewModel.TagActionResult) {
        guard !isWorking else { return }
        isWorking = true
        statusMessage = nil
        Task {
            let result = await operation()
            isWorking = false
            switch result {
            case .added:
                successPulse += 1
                dismiss()
            case .alreadyAdded:
                showStatus("Etiqueta ya agregada", isError: false)
            case .failed(let message):
                showStatus(message, isError: true)
            }
        }
    }

    private func showStatus(_ message: String, isError: Bool) {
        statusMessage = message
        statusIsError = isError
    }
}
