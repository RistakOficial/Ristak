import SwiftUI

/// Panel «Apariencia» (doc 10 §5.1 `renderAppearance`): radio-list de tema
/// sistema/claro/noche/horario → `mobile_chat_theme_preference` (aplica en
/// vivo vía `AppConfigStore.preferredColorScheme` en RootView).
struct SettingsAppearancePanel: View {
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.colorScheme) private var colorScheme

    @State private var saveError = SettingsSaveErrorPresenter()

    private var isSaving: Bool {
        appConfig.savingKeys.contains(RistakAppConfigKey.themePreference)
    }

    var body: some View {
        SettingsPanelScroll {
            SectionCard(title: "Color del chat") {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    Text("Elige cómo quieres ver esta app en este celular.")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)

                    VStack(spacing: RistakTheme.Spacing.sm) {
                        ForEach(Self.options, id: \.preference) { option in
                            SettingsRadioRow(
                                systemImage: option.systemImage,
                                title: option.title,
                                subtitle: option.subtitle,
                                isSelected: appConfig.themePreference == option.preference,
                                isDisabled: isSaving
                            ) {
                                select(option.preference)
                            }
                        }
                    }
                }
            }

            Text("Ahorita la app se ve en modo \(SettingsThemeMeta.label(for: appConfig, systemScheme: colorScheme).lowercased()) y el fondo nativo del celular ya sigue esa preferencia.")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textMute)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, RistakTheme.Spacing.xxs)
        }
        .navigationTitle("Apariencia")
        .navigationBarTitleDisplayMode(.inline)
        .settingsSaveErrorAlert(saveError)
    }

    private func select(_ preference: RistakThemePreference) {
        guard preference != appConfig.themePreference else { return }
        saveError.run {
            try await appConfig.setAppConfigValue(preference.rawValue, forKey: RistakAppConfigKey.themePreference)
        }
    }

    private struct ThemeOption {
        let preference: RistakThemePreference
        let title: String
        let subtitle: String
        let systemImage: String
    }

    /// Opciones exactas `PHONE_CHAT_THEME_OPTIONS` (doc 10 §5.1).
    private static let options: [ThemeOption] = [
        ThemeOption(
            preference: .system,
            title: "Sistema",
            subtitle: "Usa el modo que tiene tu celular.",
            systemImage: "iphone"
        ),
        ThemeOption(
            preference: .light,
            title: "Claro",
            subtitle: "Mantiene la app con fondo claro.",
            systemImage: "sun.max"
        ),
        ThemeOption(
            preference: .dark,
            title: "Noche",
            subtitle: "Mantiene la app oscura todo el tiempo.",
            systemImage: "moon"
        ),
        ThemeOption(
            preference: .auto,
            title: "Horario",
            subtitle: "Claro de día y noche después de las 7 PM.",
            systemImage: "clock"
        ),
    ]
}

// MARK: - Meta de tema (compartida con la lista principal)

/// Meta-etiqueta del tema (doc 10 §4.17): «Claro», «Noche»,
/// «Horario: ‹Claro|Noche›», «Sistema: ‹Claro|Noche›».
enum SettingsThemeMeta {
    @MainActor
    static func label(for appConfig: AppConfigStore, systemScheme: ColorScheme) -> String {
        switch appConfig.themePreference {
        case .light:
            return "Claro"
        case .dark:
            return "Noche"
        case .auto:
            return "Horario: \(appConfig.isNightTime() ? "Noche" : "Claro")"
        case .system:
            return "Sistema: \(systemScheme == .dark ? "Noche" : "Claro")"
        }
    }
}
