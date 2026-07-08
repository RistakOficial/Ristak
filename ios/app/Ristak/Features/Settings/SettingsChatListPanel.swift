import SwiftUI

/// Panel «Lista de chat» (doc 10 §5.1 `renderChats`): orden de conversaciones,
/// archivados, vista previa e indicadores de no leídos — todo `app_config`
/// optimista con rollback («No se guardó el ajuste.» al fallar).
struct SettingsChatListPanel: View {
    @Environment(AppConfigStore.self) private var appConfig

    @State private var saveError = SettingsSaveErrorPresenter()

    var body: some View {
        SettingsPanelScroll {
            SectionCard(title: "Ordenar conversaciones") {
                SettingsSegmentTabs(
                    options: [
                        .init(id: RistakChatSortMode.recent.rawValue, title: "Más recientes"),
                        .init(id: RistakChatSortMode.unread.rawValue, title: "No leídas"),
                    ],
                    selectedID: appConfig.chatSortMode.rawValue,
                    isDisabled: appConfig.savingKeys.contains(RistakAppConfigKey.sortMode)
                ) { optionID in
                    saveError.run {
                        try await appConfig.setAppConfigValue(optionID, forKey: RistakAppConfigKey.sortMode)
                    }
                }
            }

            SectionCard(title: "Bandeja") {
                VStack(spacing: RistakTheme.Spacing.sm) {
                    SettingsToggleRow(
                        title: "Mostrar archivados",
                        subtitle: "Deja visible el acceso a chats archivados.",
                        isOn: appConfig.showArchivedChats,
                        isSaving: appConfig.savingKeys.contains(RistakAppConfigKey.showArchived)
                    ) { newValue in
                        saveError.run {
                            try await appConfig.setAppConfigBool(newValue, forKey: RistakAppConfigKey.showArchived)
                        }
                    }

                    Divider()

                    SettingsToggleRow(
                        title: "Vista previa",
                        subtitle: "Muestra un resumen debajo del nombre del contacto.",
                        isOn: appConfig.showLastMessagePreview,
                        isSaving: appConfig.savingKeys.contains(RistakAppConfigKey.showLastPreview)
                    ) { newValue in
                        saveError.run {
                            try await appConfig.setAppConfigBool(newValue, forKey: RistakAppConfigKey.showLastPreview)
                        }
                    }

                    Divider()

                    SettingsToggleRow(
                        title: "Indicadores de no leídos",
                        subtitle: "Muestra el contador cuando hay mensajes nuevos.",
                        isOn: appConfig.showUnreadIndicators,
                        isSaving: appConfig.savingKeys.contains(RistakAppConfigKey.showUnreadIndicators)
                    ) { newValue in
                        saveError.run {
                            try await appConfig.setAppConfigBool(newValue, forKey: RistakAppConfigKey.showUnreadIndicators)
                        }
                    }
                }
            }
        }
        .navigationTitle("Lista de chat")
        .navigationBarTitleDisplayMode(.inline)
        .settingsSaveErrorAlert(saveError)
    }
}
