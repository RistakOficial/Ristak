import SwiftUI

/// Sheet "Meter a una automatización" (#7). Lista las automatizaciones
/// PUBLICADAS y, al tocar una, inscribe al contacto (modo inmediato) con una
/// confirmación sutil (check en la fila + háptico) — sin popup intrusivo.
/// El error de inscripción se pinta inline bajo la lista.
struct ContactAutomationEnrollSheet: View {
    let contactID: String
    let contactName: String
    /// Se llama al inscribir con éxito para que la ficha muestre un aviso sutil.
    var onEnrolled: (_ automationName: String) -> Void = { _ in }

    @State private var viewModel: ContactAutomationsViewModel
    @Environment(\.dismiss) private var dismiss

    init(
        contactID: String,
        contactName: String,
        onEnrolled: @escaping (_ automationName: String) -> Void = { _ in }
    ) {
        self.contactID = contactID
        self.contactName = contactName
        self.onEnrolled = onEnrolled
        _viewModel = State(initialValue: ContactAutomationsViewModel(contactID: contactID))
    }

    var body: some View {
        SheetScaffold(title: "Meter a una automatización", subtitle: contactName) {
            content
        }
        .task { await viewModel.loadIfNeeded() }
        .sensoryFeedback(.success, trigger: viewModel.successFeedbackCount)
    }

    // MARK: Contenido por fase

    @ViewBuilder
    private var content: some View {
        switch viewModel.phase {
        case .idle, .loading:
            RistakLoadingView(message: "Cargando automatizaciones…")

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
            loadedContent
        }
    }

    @ViewBuilder
    private var loadedContent: some View {
        @Bindable var viewModel = viewModel
        let items = viewModel.filteredAutomations

        VStack(spacing: 0) {
            if !viewModel.publishedAutomations.isEmpty {
                searchField(text: $viewModel.searchText)
            }

            if viewModel.publishedAutomations.isEmpty {
                RistakEmptyState(
                    icon: "bolt.slash",
                    title: "Sin automatizaciones",
                    message: "No hay automatizaciones publicadas para inscribir a este contacto."
                )
            } else if items.isEmpty {
                RistakEmptyState(
                    icon: "magnifyingglass",
                    title: "Sin resultados",
                    message: "No encontramos automatizaciones que coincidan con tu búsqueda."
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: RistakTheme.Spacing.xs) {
                        ForEach(items) { automation in
                            automationRow(automation)
                        }
                    }
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.top, RistakTheme.Spacing.xs)
                    .padding(.bottom, RistakTheme.Spacing.lg)
                }
            }

            if let enrollError = viewModel.enrollError, !enrollError.isEmpty {
                errorBanner(enrollError)
            }
        }
    }

    // MARK: Buscador (fondo surface + borde, per design system)

    private func searchField(text: Binding<String>) -> some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)

            TextField("Buscar automatización", text: text)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)

            if !text.wrappedValue.isEmpty {
                Button {
                    text.wrappedValue = ""
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
                .fill(RistakTheme.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .stroke(RistakTheme.border, lineWidth: 1)
        )
        .padding(.horizontal, RistakTheme.Spacing.lg)
        .padding(.bottom, RistakTheme.Spacing.xs)
    }

    // MARK: Fila de automatización (tap = inscribir)

    private func automationRow(_ automation: ContactAutomationSummary) -> some View {
        let isEnrolling = viewModel.enrollingID == automation.id
        let isEnrolled = viewModel.enrolledID == automation.id
        let description = automation.description.trimmingCharacters(in: .whitespacesAndNewlines)

        return Button {
            guard !isEnrolling, !isEnrolled else { return }
            Task {
                let ok = await viewModel.enroll(automation)
                guard ok else { return }
                // Confirmación sutil: se ve el check un instante y se cierra.
                try? await Task.sleep(for: .milliseconds(650))
                onEnrolled(automation.displayName)
                dismiss()
            }
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(isEnrolled ? RistakTheme.posSoft : RistakTheme.accentSoft)
                    .frame(width: 40, height: 40)
                    .overlay(
                        Image(systemName: isEnrolled ? "checkmark" : "arrow.triangle.branch")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(isEnrolled ? RistakTheme.pos : RistakTheme.accent)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(automation.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    if isEnrolled {
                        Text("Agregado a la automatización")
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.pos)
                            .lineLimit(1)
                    } else if !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                trailingAccessory(isEnrolling: isEnrolling, isEnrolled: isEnrolled)
            }
            .padding(.vertical, RistakTheme.Spacing.xs)
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(RistakTheme.surface)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isEnrolling)
        .accessibilityLabel("Meter a \(automation.displayName)")
    }

    @ViewBuilder
    private func trailingAccessory(isEnrolling: Bool, isEnrolled: Bool) -> some View {
        if isEnrolling {
            ProgressView()
                .controlSize(.small)
        } else if isEnrolled {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(RistakTheme.pos)
        } else {
            Image(systemName: "plus.circle")
                .font(.title3)
                .foregroundStyle(RistakTheme.accent)
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(RistakTheme.neg)
            Text(message)
                .font(.footnote)
                .foregroundStyle(RistakTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, RistakTheme.Spacing.xs)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.negSoft)
        )
        .padding(.horizontal, RistakTheme.Spacing.lg)
        .padding(.bottom, RistakTheme.Spacing.md)
    }
}
