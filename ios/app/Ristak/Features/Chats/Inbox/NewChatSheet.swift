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
    @State private var showNewContact = false

    var body: some View {
        SheetScaffold(title: "Nuevo chat", subtitle: "Busca un contacto para escribirle") {
            VStack(spacing: 0) {
                searchField
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.xs)

                // El botón «Nuevo contacto» ya NO va fijo arriba: es la PRIMERA
                // FILA de la lista (scrollea junto con el contenido). Debajo van
                // los resultados / estados, todos con el separador uniforme.
                List {
                    newContactRow
                        .listRowSeparator(.hidden)

                    if isSearching, results.isEmpty {
                        searchingRow
                            .listRowSeparator(.hidden)
                    } else if results.isEmpty {
                        emptyRow
                            .listRowSeparator(.hidden)
                    } else {
                        ForEach(results) { contact in
                            contactRow(contact)
                                .onTapGesture {
                                    dismiss()
                                    onSelect(contact)
                                }
                                .ristakRowSeparator()
                        }
                    }
                }
                .listStyle(.plain)
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
        .sheet(isPresented: $showNewContact) {
            NewContactSheet { created in
                // Contacto creado: cerrar ambos sheets y abrir su conversación
                // (mismo patrón que la «+» de Calendarios).
                showNewContact = false
                dismiss()
                onSelect(created)
            }
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: - Filas de la lista

    /// Fila 0: CTA para crear un contacto y abrir chat con él (paridad flujo
    /// «Nueva cita» / ContactSearchInput de escritorio). Estilo OUTLINE
    /// (contorneado) TRANSPARENTE: texto/ícono de acento + borde fino de acento
    /// sobre fondo transparente (sin relleno), para no competir en peso con las
    /// filas de contacto ni pintar un bloque sólido sobre la lista.
    private var newContactRow: some View {
        Button {
            showNewContact = true
        } label: {
            Label("Nuevo contacto", systemImage: "person.badge.plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(RistakTheme.accent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .strokeBorder(RistakTheme.accent, lineWidth: 1.5)
                )
                .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(
            top: RistakTheme.Spacing.xs,
            leading: RistakTheme.Spacing.lg,
            bottom: RistakTheme.Spacing.sm,
            trailing: RistakTheme.Spacing.lg
        ))
        .accessibilityLabel("Nuevo contacto")
    }

    private func contactRow(_ contact: ChatContact) -> some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            ContactAvatarView(
                name: ChatRowSignals.displayName(contact),
                photoURL: contact.profilePhotoUrl.flatMap(URL.init(string:)),
                size: 54,
                channel: ChatRowSignals.badgeChannel(contact)
            )
            // Misma huella (48×48) que la bandeja: avatar grande, alineación de
            // texto y separador idénticos entre listas.
            .frame(width: 48, height: 48)

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

            Spacer(minLength: 0)
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
        .contentShape(Rectangle())
    }

    private var searchingRow: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            ProgressView()
                .controlSize(.small)
            Text("Buscando contactos...")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, RistakTheme.Spacing.xl)
    }

    private var emptyRow: some View {
        RistakEmptyState(
            icon: "person.crop.circle.badge.questionmark",
            title: "Sin resultados",
            message: "Busca por nombre, teléfono o correo para iniciar una conversación."
        )
        .frame(maxWidth: .infinity)
        .padding(.top, RistakTheme.Spacing.xl)
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
