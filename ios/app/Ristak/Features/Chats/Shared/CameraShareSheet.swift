import SwiftUI

/// «Enviar media» de la cámara global (paridad mobile/ `ContactPickerSheet` en
/// modo `cameraShare`, App.tsx L14792): vista previa de la foto/video arriba,
/// buscador + lista de contactos con selección múltiple, y un mensaje opcional
/// con botón de envío abajo. Se manda a cada destinatario por WhatsApp.
struct CameraShareSheet: View {
    @Bindable var viewModel: CameraShareViewModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var captionFocused: Bool

    private var subtitle: String {
        viewModel.selectedCount > 0
            ? "\(viewModel.selectedCount) seleccionado\(viewModel.selectedCount == 1 ? "" : "s")"
            : "Elige destinatarios y agrega un mensaje"
    }

    var body: some View {
        SheetScaffold(title: "Enviar media", subtitle: subtitle) {
            VStack(spacing: 0) {
                preview
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.md)

                searchField
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.xs)

                contactList

                footer
            }
        }
        .task { await viewModel.runSearch() }
        .onChange(of: viewModel.searchText) { viewModel.searchTextChanged() }
        .alert(
            "Enviar media",
            isPresented: Binding(
                get: { viewModel.alertMessage != nil },
                set: { if !$0 { viewModel.alertMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) {}
        } message: {
            Text(viewModel.alertMessage ?? "")
        }
    }

    // MARK: - Vista previa

    private var preview: some View {
        ZStack {
            if let image = viewModel.previewImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                RistakTheme.surface2
                Image(systemName: "video.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(RistakTheme.textDim)
            }

            if viewModel.media.kind == .video {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(RistakTheme.onAccent)
                    .shadow(radius: 6)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 200)
        .clipShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                .strokeBorder(RistakTheme.border, lineWidth: 0.5)
        )
    }

    // MARK: - Buscador

    private var searchField: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)

            TextField("Buscar contacto", text: $viewModel.searchText)
                .font(.body)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            if !viewModel.searchText.isEmpty {
                Button {
                    viewModel.searchText = ""
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
                .fill(RistakTheme.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control)
                        .strokeBorder(RistakTheme.border, lineWidth: 0.5)
                )
        )
    }

    // MARK: - Lista de contactos

    @ViewBuilder
    private var contactList: some View {
        if viewModel.isSearching, viewModel.results.isEmpty {
            Spacer(minLength: 0)
            HStack(spacing: RistakTheme.Spacing.xs) {
                ProgressView()
                    .controlSize(.small)
                Text("Buscando contactos...")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
            }
            Spacer(minLength: 0)
        } else if viewModel.results.isEmpty {
            Spacer(minLength: 0)
            Text("No hay contactos para mostrar.")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
            Spacer(minLength: 0)
        } else {
            List(viewModel.results) { contact in
                Button {
                    viewModel.toggle(contact)
                } label: {
                    contactRow(contact)
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 6, leading: RistakTheme.Spacing.lg, bottom: 6, trailing: RistakTheme.Spacing.lg))
                .ristakRowSeparator()
            }
            .listStyle(.plain)
        }
    }

    private func contactRow(_ contact: ChatContact) -> some View {
        let selected = viewModel.isSelected(contact)
        return HStack(spacing: RistakTheme.Spacing.sm) {
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

            Spacer(minLength: RistakTheme.Spacing.xs)

            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(selected ? RistakTheme.accent : RistakTheme.textMute)
        }
        .contentShape(Rectangle())
    }

    // MARK: - Pie: mensaje + envío

    private var footer: some View {
        HStack(alignment: .bottom, spacing: RistakTheme.Spacing.sm) {
            TextField("Agregar mensaje...", text: $viewModel.caption, axis: .vertical)
                .font(.body)
                .lineLimit(1...4)
                .focused($captionFocused)
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

            Button {
                captionFocused = false
                Task {
                    let ok = await viewModel.send()
                    if ok { dismiss() }
                }
            } label: {
                Group {
                    if viewModel.isSending {
                        ProgressView()
                            .tint(RistakTheme.onAccent)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(RistakTheme.onAccent)
                    }
                }
                .frame(width: 46, height: 46)
                .background(
                    Circle().fill(
                        viewModel.selectedCount == 0 || viewModel.isSending
                            ? RistakTheme.accent.opacity(0.4)
                            : RistakTheme.accent
                    )
                )
            }
            .buttonStyle(.plain)
            .disabled(viewModel.selectedCount == 0 || viewModel.isSending)
            .accessibilityLabel(
                viewModel.selectedCount > 0
                    ? "Enviar media a \(viewModel.selectedCount) destinatarios"
                    : "Selecciona destinatarios para enviar"
            )
        }
        .padding(.horizontal, RistakTheme.Spacing.lg)
        .padding(.top, RistakTheme.Spacing.sm)
        .padding(.bottom, RistakTheme.Spacing.md)
    }
}
