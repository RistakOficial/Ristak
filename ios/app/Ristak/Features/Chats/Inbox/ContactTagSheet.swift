import SwiftUI

/// Sheet «Agregar etiqueta» (doc research/03 §4.4): buscador
/// «Buscar o crear etiqueta», lista del catálogo, fila «Crear "<texto>"» si no
/// existe exacta; aplicar = `POST /contacts/bulk/tags` con un solo contacto.
/// Si el contacto ya la tiene: aviso informativo «Etiqueta ya agregada».
struct ContactTagSheet: View {
    let contact: ChatContact
    let viewModel: InboxViewModel

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var isApplying = false
    @State private var infoMessage: String?
    @State private var errorMessage: String?

    private var filteredTags: [ContactTag] {
        let query = ristakFoldedText(searchText)
        let catalog = viewModel.tagsCatalog.filter { !$0.isSystem }
        guard !query.isEmpty else { return catalog }
        return catalog.filter { ristakFoldedText($0.name).contains(query) }
    }

    private var hasExactMatch: Bool {
        let query = ristakFoldedText(searchText)
        guard !query.isEmpty else { return true }
        return viewModel.tagsCatalog.contains { ristakFoldedText($0.name) == query }
    }

    var body: some View {
        SheetScaffold(title: "Agregar etiqueta", subtitle: ChatRowSignals.displayName(contact)) {
            VStack(spacing: 0) {
                searchField
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.xs)

                if let infoMessage {
                    Text(infoMessage)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.info)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, RistakTheme.Spacing.lg)
                        .padding(.bottom, RistakTheme.Spacing.xs)
                }

                List {
                    if !hasExactMatch, !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button {
                            createAndApply()
                        } label: {
                            Label("Crear \"\(searchText.trimmingCharacters(in: .whitespacesAndNewlines))\"", systemImage: "plus.circle")
                                .foregroundStyle(RistakTheme.accent)
                        }
                        .disabled(isApplying)
                    }

                    ForEach(filteredTags) { tag in
                        Button {
                            apply(tag)
                        } label: {
                            HStack {
                                Label(tag.name, systemImage: "tag")
                                    .foregroundStyle(RistakTheme.textPrimary)
                                Spacer()
                                if contact.tags.contains(tag.id) {
                                    Image(systemName: "checkmark")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(RistakTheme.textDim)
                                }
                            }
                        }
                        .disabled(isApplying)
                    }

                    if filteredTags.isEmpty, hasExactMatch {
                        Text("No hay etiquetas guardadas todavía.")
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }
                .listStyle(.plain)
            }
        }
        .task { await viewModel.ensureTagsLoaded() }
        .alert("No se guardó la etiqueta", isPresented: errorBinding) {
            Button("Entendido", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var searchField: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)

            TextField("Buscar o crear etiqueta", text: $searchText)
                .font(.body)
                .autocorrectionDisabled()

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(RistakTheme.textMute)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Limpiar búsqueda")
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control)
                .fill(RistakTheme.controlBackground)
        )
    }

    private func apply(_ tag: ContactTag) {
        guard !isApplying else { return }
        isApplying = true
        infoMessage = nil
        Task {
            do {
                let outcome = try await viewModel.applyTag(tag, to: contact)
                isApplying = false
                switch outcome {
                case .applied:
                    dismiss()
                case .alreadyTagged:
                    infoMessage = "Etiqueta ya agregada"
                }
            } catch {
                isApplying = false
                errorMessage = (error as? RistakAPIError)?.message ?? "Intenta otra vez."
            }
        }
    }

    private func createAndApply() {
        let name = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !isApplying else { return }
        isApplying = true
        Task {
            do {
                try await viewModel.createAndApplyTag(named: name, to: contact)
                isApplying = false
                dismiss()
            } catch {
                isApplying = false
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
