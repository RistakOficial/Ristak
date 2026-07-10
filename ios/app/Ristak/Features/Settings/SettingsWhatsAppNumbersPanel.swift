import SwiftUI

/// Panel «Números de WhatsApp» (doc 10 §5.1 `renderNumbers`, solo RN):
/// - Action card con botón «Actualizar» (`POST /whatsapp-api/refresh`).
/// - Lista de números con pill «Hacer principal»/«Principal».
///
/// La selección de qué número VE la bandeja (Juntos/Separado + «Usar») se
/// retiró: los filtros de la propia lista de chats ya cubren ese caso mejor.
struct SettingsWhatsAppNumbersPanel: View {
    @Environment(SettingsModel.self) private var model

    @State private var refreshErrorMessage: String?
    @State private var defaultErrorMessage: String?
    @State private var pendingDefaultID: String?

    var body: some View {
        SettingsLoadStateView(
            state: model.whatsapp,
            loadingMessage: "Cargando números...",
            retry: { Task { await model.loadWhatsApp() } }
        ) { status in
            content(status: status)
        }
        .navigationTitle("Números de WhatsApp")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.loadWhatsApp() }
        .alert(
            "Números de WhatsApp",
            isPresented: Binding(
                get: { refreshErrorMessage != nil },
                set: { if !$0 { refreshErrorMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { refreshErrorMessage = nil }
        } message: {
            Text(refreshErrorMessage ?? "")
        }
        .alert(
            "No se pudo cambiar el principal",
            isPresented: Binding(
                get: { defaultErrorMessage != nil },
                set: { if !$0 { defaultErrorMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { defaultErrorMessage = nil }
        } message: {
            Text(defaultErrorMessage ?? "")
        }
        .confirmationDialog(
            "¿Hacer principal este número?",
            isPresented: Binding(
                get: { pendingDefaultID != nil },
                set: { if !$0 { pendingDefaultID = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Hacer principal") {
                guard let id = pendingDefaultID else { return }
                pendingDefaultID = nil
                Task {
                    if let message = await model.setDefaultPhoneNumber(id: id) {
                        defaultErrorMessage = message
                    }
                }
            }
            Button("Cancelar", role: .cancel) { pendingDefaultID = nil }
        } message: {
            Text("Los envíos nuevos saldrán desde este remitente.")
        }
    }

    // MARK: - Contenido

    private func content(status: WhatsAppAPIStatus) -> some View {
        SettingsPanelScroll {
            SettingsActionCard(
                systemImage: "iphone",
                title: "Números de WhatsApp",
                subtitle: status.connected
                    ? "Administra remitentes conectados."
                    : "Conecta WhatsApp para enviar desde la app móvil.",
                actionTitle: "Actualizar",
                isWorking: model.isRefreshingWhatsApp
            ) {
                Task {
                    if let message = await model.refreshWhatsApp() {
                        refreshErrorMessage = message
                    }
                }
            }

            if status.phoneNumbers.isEmpty {
                SectionCard {
                    Text("Todavía no hay números de WhatsApp conectados.")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, RistakTheme.Spacing.md)
                }
            } else {
                SectionCard(title: "Remitentes") {
                    VStack(spacing: 0) {
                        ForEach(Array(status.phoneNumbers.enumerated()), id: \.element.id) { index, number in
                            numberRow(number)
                            if index < status.phoneNumbers.count - 1 {
                                Divider().padding(.vertical, RistakTheme.Spacing.xs)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Fila de número

    private func numberRow(_ number: WhatsAppPhoneNumber) -> some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            HStack(spacing: RistakTheme.Spacing.sm) {
                ContactAvatarView(
                    name: number.displayTitle,
                    photoURL: number.profilePictureUrl.flatMap(URL.init(string:)),
                    size: 40
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(number.displayTitle)
                        .font(.body.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    Text(subtitle(for: number))
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)
            }

            HStack(spacing: RistakTheme.Spacing.xs) {
                SettingsPillButton(
                    title: number.isDefaultSender ? "Principal" : "Hacer principal",
                    isActive: number.isDefaultSender,
                    isWorking: model.settingDefaultPhoneID == number.id,
                    isDisabled: number.isDefaultSender || model.settingDefaultPhoneID != nil
                ) {
                    pendingDefaultID = number.id
                }

                Spacer(minLength: 0)
            }
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
    }

    /// Subtítulo `<número || 'Sin número visible'> · <estado>` (doc 10 §5.1).
    private func subtitle(for number: WhatsAppPhoneNumber) -> String {
        let phone: String = {
            let value = number.displayPhoneNumber ?? number.phoneNumber
            guard let value, !value.isEmpty else { return "Sin número visible" }
            return value
        }()
        return "\(phone) · \(stateLabel(for: number))"
    }

    /// Estado: apiReason si no disponible / «Respaldo QR» / «QR listo» /
    /// «Principal» / `status` / «Disponible».
    private func stateLabel(for number: WhatsAppPhoneNumber) -> String {
        if let availability = number.availability, !availability.available,
           let reason = availability.apiReason, !reason.isEmpty {
            return reason
        }
        if number.provider == "qr" {
            return "Respaldo QR"
        }
        if let availability = number.availability, availability.qrReady, !availability.apiAvailable {
            return "QR listo"
        }
        if number.isDefaultSender {
            return "Principal"
        }
        if let status = number.status, !status.isEmpty {
            return status
        }
        return "Disponible"
    }
}
