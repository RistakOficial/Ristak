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

    func loadInitial() async {
        applyCachedResults(query: query)
        await performSearch(query: query)
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let current = query
        // Responde al teclado con el directorio en memoria; la petición no
        // forma parte del primer pintado.
        applyCachedResults(query: current)
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 90_000_000)
            guard !Task.isCancelled else { return }
            await self?.performSearch(query: current)
        }
    }

    private func performSearch(query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        applyCachedResults(query: trimmed)
        guard trimmed.isEmpty || trimmed.count >= 2 else {
            isLoading = false
            return
        }

        isLoading = results.isEmpty
        errorMessage = nil
        defer {
            if trimmed == self.query.trimmingCharacters(in: .whitespacesAndNewlines) {
                isLoading = false
            }
        }

        do {
            let found = try await contactsService.fetchPickerContacts(query: trimmed)
            guard !Task.isCancelled,
                  trimmed == self.query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            results = found.map { PickedPaymentContact(chatContact: $0) }
        } catch let error as RistakAPIError {
            guard !Task.isCancelled else { return }
            if results.isEmpty { errorMessage = error.message }
        } catch {
            guard !Task.isCancelled else { return }
            if results.isEmpty { errorMessage = "No se pudieron cargar los contactos." }
        }
    }

    private func applyCachedResults(query: String) {
        let cached = contactsService.cachedPickerContacts(query: query)
        if !cached.isEmpty || results.isEmpty {
            results = cached.map { PickedPaymentContact(chatContact: $0) }
        }
        errorMessage = nil
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
                        ContactAvatarView(
                            name: contact.displayName,
                            photoURL: contact.photoURL,
                            size: 42,
                            channel: contact.channel
                        )

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
