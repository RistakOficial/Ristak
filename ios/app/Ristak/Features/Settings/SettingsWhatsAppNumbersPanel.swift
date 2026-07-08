import SwiftUI

/// Panel «Números de WhatsApp» (doc 10 §5.1 `renderNumbers`, solo RN):
/// - Action card con botón «Actualizar» (`POST /whatsapp-api/refresh`).
/// - Card «Bandeja de chats»: segmented Juntos | Separado →
///   `mobile_chat_selected_whatsapp_phone_id` (`'all'` o phoneNumberId).
/// - Lista de números con pills «Usar»/«En chats» y «Hacer principal»/«Principal».
struct SettingsWhatsAppNumbersPanel: View {
    @Environment(SettingsModel.self) private var model
    @Environment(AppConfigStore.self) private var appConfig

    @State private var saveError = SettingsSaveErrorPresenter()
    @State private var refreshErrorMessage: String?
    @State private var defaultErrorMessage: String?
    @State private var noNumberAlert = false
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
        .settingsSaveErrorAlert(saveError)
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
        .alert("Números de WhatsApp", isPresented: $noNumberAlert) {
            Button("Entendido", role: .cancel) {}
        } message: {
            Text("No hay un número disponible para separar la bandeja.")
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

            inboxCard(status: status)

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

    // MARK: - Bandeja Juntos/Separado

    private func inboxCard(status: WhatsAppAPIStatus) -> some View {
        let selectedID = appConfig.selectedWhatsAppPhoneID
        let isSeparated = selectedID != "all"
        let separatedNumber = status.phoneNumbers.first { $0.id == selectedID }

        return SectionCard(title: "Bandeja de chats") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                Text("Usa todos juntos para ver la bandeja completa o separa por un remitente cuando necesites trabajar sólo un número.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .fixedSize(horizontal: false, vertical: true)

                SettingsSegmentTabs(
                    options: [
                        .init(id: "all", title: "Juntos"),
                        .init(id: "separate", title: "Separado"),
                    ],
                    selectedID: isSeparated ? "separate" : "all",
                    isDisabled: appConfig.savingKeys.contains(RistakAppConfigKey.selectedWhatsAppPhoneID)
                ) { optionID in
                    if optionID == "all" {
                        writeSelectedPhone("all")
                    } else {
                        // «Separado»: usa el número ya seleccionado o el default.
                        let fallback = status.phoneNumbers.first { $0.isDefaultSender } ?? status.phoneNumbers.first
                        guard let target = separatedNumber ?? fallback else {
                            noNumberAlert = true
                            return
                        }
                        writeSelectedPhone(target.id)
                    }
                }

                if isSeparated, let number = separatedNumber {
                    Text("Separado por \(separatedHint(number)).")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                }
            }
        }
    }

    private func separatedHint(_ number: WhatsAppPhoneNumber) -> String {
        let phone = number.displayPhoneNumber ?? number.phoneNumber
        if let phone, !phone.isEmpty, phone != number.displayTitle {
            return "\(number.displayTitle) · \(phone)"
        }
        return number.displayTitle
    }

    private func writeSelectedPhone(_ value: String) {
        saveError.run {
            try await appConfig.setAppConfigValue(value, forKey: RistakAppConfigKey.selectedWhatsAppPhoneID)
        }
    }

    // MARK: - Fila de número

    private func numberRow(_ number: WhatsAppPhoneNumber) -> some View {
        let isInboxSelected = appConfig.selectedWhatsAppPhoneID == number.id

        return VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
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
                    title: isInboxSelected ? "En chats" : "Usar",
                    isActive: isInboxSelected,
                    isDisabled: appConfig.savingKeys.contains(RistakAppConfigKey.selectedWhatsAppPhoneID)
                ) {
                    writeSelectedPhone(number.id)
                }

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
