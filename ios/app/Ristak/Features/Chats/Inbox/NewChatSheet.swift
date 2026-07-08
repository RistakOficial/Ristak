import SwiftUI

/// Sheet «Nuevo chat» (botón «+» del toolbar, doc research/03 §4.1/§1.3):
/// busca en `/contacts/search` fusionado con los chats recientes; tocar una
/// fila abre la conversación.
struct NewChatSheet: View {
    let viewModel: InboxViewModel
    let onSelect: (ChatContact) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var results: [ChatContact] = []
    @State private var isSearching = false
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        SheetScaffold(title: "Nuevo chat", subtitle: "Busca un contacto para escribirle") {
            VStack(spacing: 0) {
                searchField
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.xs)

                if isSearching, results.isEmpty {
                    Spacer()
                    ProgressView("Buscando contactos...")
                        .font(.subheadline)
                    Spacer()
                } else if results.isEmpty {
                    RistakEmptyState(
                        icon: "person.crop.circle.badge.questionmark",
                        title: "Sin resultados",
                        message: "Busca por nombre, teléfono o correo para iniciar una conversación."
                    )
                } else {
                    List(results) { contact in
                        Button {
                            dismiss()
                            onSelect(contact)
                        } label: {
                            HStack(spacing: RistakTheme.Spacing.sm) {
                                ContactAvatarView(
                                    name: ChatRowSignals.displayName(contact),
                                    photoURL: contact.profilePhotoUrl.flatMap(URL.init(string:)),
                                    size: 40,
                                    channel: ChatRowSignals.badgeChannel(contact)
                                )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ChatRowSignals.displayName(contact))
                                        .font(.body)
                                        .foregroundStyle(RistakTheme.textPrimary)
                                        .lineLimit(1)

                                    Text(ChatRowSignals.contactDetailSubtitle(contact))
                                        .font(.caption)
                                        .foregroundStyle(RistakTheme.textDim)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
        }
        .task {
            await runSearch()
        }
        .onChange(of: searchText) {
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(nanoseconds: 240_000_000)
                guard !Task.isCancelled else { return }
                await runSearch()
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)

            TextField("Buscar contacto", text: $searchText)
                .font(.body)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

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

    private func runSearch() async {
        isSearching = true
        results = await viewModel.newChatResults(query: searchText)
        isSearching = false
    }
}
