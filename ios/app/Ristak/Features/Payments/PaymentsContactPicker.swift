import SwiftUI
import Observation

/// Picker de contacto contact-first del módulo Pagos (doc 08 §6.3.1 y RN
/// §6.7): con menos de 2 caracteres lista los chats recientes; con búsqueda
/// usa `GET /api/contacts/search`.
@MainActor
@Observable
final class PaymentsContactPickerModel {
    var query = "" {
        didSet {
            guard oldValue != query else { return }
            scheduleSearch()
        }
    }

    private(set) var results: [PickedPaymentContact] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    private var searchTask: Task<Void, Never>?
    private let contactsService = ContactsService()
    private let chatsService = ChatsService()

    func loadInitial() async {
        await performSearch(query: query)
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let current = query
        searchTask = Task { [weak self] in
            // Debounce corto (paridad /movil: 90 ms).
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            await self?.performSearch(query: current)
        }
    }

    private func performSearch(query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            if trimmed.count < 2 {
                // Contactos recientes de la bandeja (RN: `getChats('', 0, 60)`).
                let recents = try await chatsService.fetchChats(query: "", limit: 60, offset: 0)
                guard trimmed == self.query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                results = recents.map { PickedPaymentContact(chatContact: $0) }
            } else {
                let found = try await contactsService.searchContacts(query: trimmed)
                guard trimmed == self.query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
                results = found.map { PickedPaymentContact(chatContact: $0) }
            }
        } catch let error as RistakAPIError {
            guard !Task.isCancelled else { return }
            results = []
            errorMessage = error.message
        } catch {
            guard !Task.isCancelled else { return }
            results = []
            errorMessage = "No se pudieron cargar los contactos."
        }
    }
}

/// Sheet «Seleccionar contacto» (bottom sheet con búsqueda).
struct PaymentsContactPickerSheet: View {
    var title: String = "Seleccionar contacto"
    var onPick: (PickedPaymentContact) -> Void

    @State private var model = PaymentsContactPickerModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetScaffold(title: "Cliente", subtitle: title) {
            VStack(spacing: 0) {
                searchField
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.sm)

                content
            }
        }
        .task {
            await model.loadInitial()
        }
    }

    private var searchField: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)

            TextField("Buscar contacto", text: $model.query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            if !model.query.isEmpty {
                Button {
                    model.query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(RistakTheme.textMute)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Limpiar búsqueda")
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.controlBackground)
        )
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading && model.results.isEmpty {
            RistakLoadingView(message: "Buscando contactos...")
        } else if let message = model.errorMessage, model.results.isEmpty {
            RistakErrorState(message: message) {
                Task { await model.loadInitial() }
            }
        } else if model.results.isEmpty {
            RistakEmptyState(
                icon: "person.crop.circle.badge.questionmark",
                title: "No se encontraron contactos.",
                message: "Busca por nombre, teléfono o correo."
            )
        } else {
            List(model.results) { contact in
                Button {
                    onPick(contact)
                    dismiss()
                } label: {
                    HStack(spacing: RistakTheme.Spacing.sm) {
                        ContactAvatarView(name: contact.displayName, photoURL: contact.photoURL, size: 42)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(contact.displayName)
                                .font(.body.weight(.medium))
                                .foregroundStyle(RistakTheme.textPrimary)
                                .lineLimit(1)

                            if !contact.secondaryLabel.isEmpty {
                                Text(contact.secondaryLabel)
                                    .font(.caption)
                                    .foregroundStyle(RistakTheme.textDim)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
        }
    }
}
