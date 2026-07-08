import SwiftUI

/// Panel «Privacidad» (doc 10 §5.1 `renderPrivacy`, solo RN): vistos externos
/// (read receipts) → `chat_send_read_receipts_enabled` global.
struct SettingsPrivacyPanel: View {
    @Environment(AppConfigStore.self) private var appConfig

    @State private var saveError = SettingsSaveErrorPresenter()

    var body: some View {
        SettingsPanelScroll {
            Text("Ajustes que afectan lo que tus clientes pueden saber de tu lectura.")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textDim)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, RistakTheme.Spacing.xxs)

            SectionCard(title: "Vistos de chat") {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    Text("Decide si Ristak le avisa al proveedor cuando ya viste un mensaje.")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                        .fixedSize(horizontal: false, vertical: true)

                    SettingsToggleRow(
                        title: "Marcar mensajes como leídos o vistos",
                        subtitle: "Envía el visto real al abrir o marcar leído un chat.",
                        isOn: appConfig.sendReadReceiptsEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakAppConfigKey.sendReadReceipts)
                    ) { newValue in
                        saveError.run {
                            try await appConfig.setAppConfigBool(newValue, forKey: RistakAppConfigKey.sendReadReceipts)
                        }
                    }
                }
            }

            Text("Si lo apagas, Ristak limpia los no leídos dentro de la app, pero no manda doble check, mark seen ni acuse externo a WhatsApp API, WhatsApp QR, Messenger o Instagram.")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textMute)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, RistakTheme.Spacing.xxs)
        }
        .navigationTitle("Privacidad")
        .navigationBarTitleDisplayMode(.inline)
        .settingsSaveErrorAlert(saveError)
    }
}
