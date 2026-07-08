import SwiftUI

/// Raíz del módulo Ajustes (doc research/10):
/// - Compacto (iPhone): `NavigationStack` con la lista principal y push a los
///   8 paneles.
/// - Regular (iPad): `NavigationSplitView` — lista de paneles | detalle.
/// Footer con versión (`CFBundleShortVersionString` + build) y «Cerrar sesión»
/// con la doble opción RN: Cerrar sesión / Cambiar de app.
struct SettingsRootView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(SessionStore.self) private var session
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.colorScheme) private var colorScheme

    @State private var model = SettingsModel()

    // Navegación compacta (iPhone).
    @State private var path: [SettingsPanel] = []
    // Selección en iPad.
    @State private var selectedPanel: SettingsPanel?

    @State private var showLogoutDialog = false

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                splitLayout
            } else {
                compactLayout
            }
        }
        .environment(model)
        .task {
            async let sections: Void = model.loadIfNeeded()
            async let permission: Void = PushRegistrar.shared.refreshPermissionState()
            _ = await (sections, permission)
        }
        .confirmationDialog(
            "Cerrar sesión",
            isPresented: $showLogoutDialog,
            titleVisibility: .visible
        ) {
            Button("Cerrar sesión", role: .destructive) {
                Task { await session.logout(switchApp: false) }
            }
            Button("Cambiar de app") {
                Task { await session.logout(switchApp: true) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text(logoutMessage)
        }
    }

    /// Mensaje del diálogo: `<nombre> · <servidor>` (paridad RN doc 10 §4.18).
    private var logoutMessage: String {
        var parts: [String] = []
        if let name = session.user?.fullName, !name.isEmpty {
            parts.append(name)
        }
        if let host = session.baseURL?.host() {
            parts.append(host)
        }
        let identity = parts.joined(separator: " · ")
        return identity.isEmpty
            ? "Salir de este dispositivo."
            : identity
    }

    // MARK: - iPhone

    private var compactLayout: some View {
        NavigationStack(path: $path) {
            settingsList(selection: nil)
                .navigationTitle("Ajustes")
                .navigationDestination(for: SettingsPanel.self) { panel in
                    panelView(panel)
                }
        }
    }

    // MARK: - iPad

    private var splitLayout: some View {
        NavigationSplitView {
            settingsList(selection: $selectedPanel)
                .navigationTitle("Ajustes")
        } detail: {
            NavigationStack {
                if let selectedPanel {
                    panelView(selectedPanel)
                        .id(selectedPanel)
                } else {
                    RistakEmptyState(
                        icon: "gearshape.fill",
                        title: "Ajustes",
                        message: "Elige una sección para configurarla."
                    )
                }
            }
        }
    }

    // MARK: - Lista principal

    private func settingsList(selection: Binding<SettingsPanel?>?) -> some View {
        listContainer(selection: selection)
            .refreshable {
                async let sections: Void = model.reloadAll()
                async let config: Void = appConfig.refresh()
                _ = await (sections, config)
            }
            // Dock por dirección de scroll (#11). Solo compacto; en iPad (split)
            // el modifier no oculta nada. Ver `ShellScrollTracking.swift`.
            .reportsShellScroll()
    }

    /// En COMPACTO (iPhone) la lista NO recibe binding de `selection`: cada fila
    /// es un `NavigationLink(value:)` que empuja su panel en el `NavigationStack`
    /// del `compactLayout`. Un `selection:` constante hacía que iOS tratara las
    /// filas como seleccionables y, en algunos casos, se «comiera» el tap sin
    /// empujar el panel. En REGULAR (iPad) sí usa `selection` para pilotar el
    /// detalle del `NavigationSplitView`.
    @ViewBuilder
    private func listContainer(selection: Binding<SettingsPanel?>?) -> some View {
        if let selection {
            List(selection: selection) { listSections }
        } else {
            List { listSections }
        }
    }

    @ViewBuilder
    private var listSections: some View {
        Section {
            ForEach(SettingsPanel.allCases) { panel in
                row(for: panel)
                    .tag(panel)
            }
        }

        Section {
            Button(role: .destructive) {
                showLogoutDialog = true
            } label: {
                SettingsMainRow(
                    systemImage: "rectangle.portrait.and.arrow.right",
                    tint: RistakTheme.neg,
                    title: "Cerrar sesión",
                    subtitle: "Salir de este dispositivo.",
                    meta: nil
                )
            }
        } footer: {
            Text(versionFooter)
                .font(.footnote)
                .foregroundStyle(RistakTheme.textMute)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, RistakTheme.Spacing.xs)
        }
    }

    @ViewBuilder
    private func row(for panel: SettingsPanel) -> some View {
        if horizontalSizeClass == .regular {
            SettingsMainRow(
                systemImage: panel.systemImage,
                tint: iconTint(for: panel),
                title: panel.title,
                subtitle: panel.subtitle,
                meta: meta(for: panel)
            )
        } else {
            NavigationLink(value: panel) {
                SettingsMainRow(
                    systemImage: panel.systemImage,
                    tint: iconTint(for: panel),
                    title: panel.title,
                    subtitle: panel.subtitle,
                    meta: meta(for: panel)
                )
            }
        }
    }

    /// Iconos glyph-only; rojo reservado a notificaciones y logout (doc 10 §5.1).
    private func iconTint(for panel: SettingsPanel) -> Color {
        switch panel {
        case .numbers, .chats: return RistakTheme.pos
        case .customFields: return RistakTheme.warn
        case .notifications: return RistakTheme.neg
        case .templates, .agent, .appearance, .privacy: return RistakTheme.textDim
        }
    }

    private func meta(for panel: SettingsPanel) -> String? {
        switch panel {
        case .numbers:
            return model.numbersMeta
        case .templates:
            return model.templatesMeta
        case .agent:
            return model.agentMeta(chatEnabled: appConfig.aiAgentChatEnabled)
        case .chats:
            return appConfig.chatSortMode == .recent ? "Recientes" : "No leídas"
        case .customFields:
            return model.customFieldsMeta
        case .appearance:
            return SettingsThemeMeta.label(for: appConfig, systemScheme: colorScheme)
        case .privacy:
            return appConfig.sendReadReceiptsEnabled ? "Vistos activos" : "Vistos apagados"
        case .notifications:
            switch PushRegistrar.shared.permissionState {
            case .granted: return "Activo"
            case .denied: return "Bloqueado"
            case .notDetermined: return "Activar"
            case .unknown: return "No soportado"
            }
        }
    }

    /// «Versión 1.0.0 (42)» desde el Info.plist.
    private var versionFooter: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "Ristak · Versión \(version) (\(build))"
    }

    // MARK: - Paneles

    @ViewBuilder
    private func panelView(_ panel: SettingsPanel) -> some View {
        switch panel {
        case .numbers:
            SettingsWhatsAppNumbersPanel()
        case .templates:
            SettingsTemplatesPanel()
        case .agent:
            SettingsAgentPanel()
        case .chats:
            SettingsChatListPanel()
        case .customFields:
            SettingsCustomFieldsPanel()
        case .appearance:
            SettingsAppearancePanel()
        case .privacy:
            SettingsPrivacyPanel()
        case .notifications:
            SettingsNotificationsPanel()
        }
    }
}

// MARK: - Fila de la lista principal

/// Fila estándar de la lista de Ajustes: icono glyph, título, descripción y
/// meta al trailing (doc 10 §5.1).
private struct SettingsMainRow: View {
    let systemImage: String
    let tint: Color
    let title: String
    let subtitle: String
    let meta: String?

    var body: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(tint)
                .frame(width: 30)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(RistakTheme.textPrimary)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(2)
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            if let meta, !meta.isEmpty {
                Text(meta)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}
