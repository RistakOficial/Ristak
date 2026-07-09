import SwiftUI

// MARK: - Fondo estándar de panel

/// Contenedor scroll estándar de los paneles de Ajustes: cards sobre fondo
/// agrupado (capa de contenido opaca, sin glass — ARCHITECTURE.md).
struct SettingsPanelScroll<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: RistakTheme.Spacing.sm) {
                content
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, RistakTheme.Spacing.sm)
        }
        .background(RistakTheme.bgGrouped)
    }
}

// MARK: - Toggle con guardado optimista

/// Fila de toggle de Ajustes: título + descripción, deshabilitada mientras su
/// clave se guarda (`savingKeys`), con la escritura optimista delegada al
/// caller (que hace rollback + alerta «No se guardó el ajuste» si falla).
struct SettingsToggleRow: View {
    let title: String
    let subtitle: String
    let isOn: Bool
    var isSaving: Bool = false
    var isDisabled: Bool = false
    let onChange: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { isOn }, set: { onChange($0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(RistakTheme.textPrimary)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            }
        }
        .disabled(isSaving || isDisabled)
        .sensoryFeedback(.selection, trigger: isOn)
    }
}

// MARK: - Segmented con regla de selección Ristak

/// Tabs segmentadas planas: opción seleccionada = relleno SÓLIDO de acento +
/// texto blanco (sin glass, sin contorno, sin sombra); reposo = pista neutra.
/// Regla de selección obligatoria de ARCHITECTURE.md.
struct SettingsSegmentTabs: View {
    struct Option: Identifiable {
        let id: String
        let title: String
    }

    let options: [Option]
    let selectedID: String
    var isDisabled: Bool = false
    let onSelect: (String) -> Void

    var body: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            ForEach(options) { option in
                let isSelected = option.id == selectedID
                Button {
                    guard !isSelected else { return }
                    onSelect(option.id)
                } label: {
                    Text(option.title)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textPrimary)
                        .background(
                            Capsule().fill(isSelected ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
                        )
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .disabled(isDisabled)
        .sensoryFeedback(.selection, trigger: selectedID)
    }
}

// MARK: - Fila radio (Apariencia)

/// Fila seleccionable tipo radio: icono, título, descripción y check de acento.
struct SettingsRadioRow: View {
    let systemImage: String
    let title: String
    let subtitle: String
    let isSelected: Bool
    var isDisabled: Bool = false
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: systemImage)
                    .font(.body.weight(.medium))
                    .foregroundStyle(isSelected ? RistakTheme.accent : RistakTheme.textDim)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(RistakTheme.textPrimary)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? RistakTheme.accent : RistakTheme.textMute)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .sensoryFeedback(.selection, trigger: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Card de acción de panel (header con botón «Actualizar»)

/// Card superior de panel (paridad «action card» RN): icono tonal, título,
/// subtítulo y botón de acción con spinner.
struct SettingsActionCard: View {
    let systemImage: String
    let title: String
    let subtitle: String
    var actionTitle: String? = nil
    var isWorking: Bool = false
    var action: (() -> Void)? = nil

    var body: some View {
        SectionCard {
            HStack(alignment: .center, spacing: RistakTheme.Spacing.sm) {
                Image(systemName: systemImage)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(RistakTheme.accent)
                    .frame(width: 42, height: 42)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                            .fill(RistakTheme.accentSoft)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(RistakTheme.textPrimary)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                if let actionTitle, let action {
                    Button(action: action) {
                        if isWorking {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text(actionTitle)
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .disabled(isWorking)
                }
            }
        }
    }
}

// MARK: - Estados por sección

/// Estado «sin acceso» (403 `read_access_required`) de una sección.
struct SettingsAccessDeniedView: View {
    let message: String

    var body: some View {
        RistakEmptyState(
            icon: "lock.fill",
            title: "Sin acceso",
            message: message
        )
    }
}

/// Render estándar de un `SettingsLoadState` con contenido custom.
struct SettingsLoadStateView<Value: Sendable, Content: View>: View {
    let state: SettingsLoadState<Value>
    let loadingMessage: String
    let retry: () -> Void
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        switch state {
        case .idle, .loading:
            // Sin loader de pantalla completa al abrir (estilo WhatsApp): los
            // paneles hidratan su caché al instante (estado `.loaded`), así que
            // este caso solo se alcanza en la primerísima instalación sin caché.
            // Mostramos la página vacía del panel (fondo agrupado, sin spinner);
            // el contenido aparece solo al revalidar. El único indicador de carga
            // permitido es el pull-to-refresh que adjunta cada panel.
            SettingsPanelScroll { EmptyView() }
        case .accessDenied(let message):
            SettingsAccessDeniedView(message: message)
        case .featureBlocked(let message):
            RistakEmptyState(
                icon: "slash.circle",
                title: "Función no disponible",
                message: message
            )
        case .failed(let message):
            RistakErrorState(message: message, retry: retry)
        case .loaded(let value):
            content(value)
        }
    }
}

// MARK: - Alerta «No se guardó el ajuste»

/// Estado de alerta de guardado fallido (rollback ya aplicado por
/// `AppConfigStore`); copy exacto RN: «No se guardó el ajuste» + mensaje del
/// backend o «Intenta otra vez.» (doc 10 §3.3).
@MainActor
@Observable
final class SettingsSaveErrorPresenter {
    var message: String?

    /// Ejecuta una escritura optimista y captura el fallo como alerta.
    func run(_ operation: @escaping () async throws -> Void) {
        Task {
            do {
                try await operation()
            } catch let error as RistakAPIError {
                message = error.message.isEmpty ? "Intenta otra vez." : error.message
            } catch {
                message = "Intenta otra vez."
            }
        }
    }
}

extension View {
    /// Adjunta la alerta estándar «No se guardó el ajuste».
    func settingsSaveErrorAlert(_ presenter: SettingsSaveErrorPresenter) -> some View {
        alert(
            "No se guardó el ajuste",
            isPresented: Binding(
                get: { presenter.message != nil },
                set: { if !$0 { presenter.message = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { presenter.message = nil }
        } message: {
            Text(presenter.message ?? "Intenta otra vez.")
        }
    }
}

// MARK: - Pill de acción pequeña (filas de números)

/// Pill compacta para acciones por fila («Usar»/«En chats», «Hacer
/// principal»/«Principal»). Activa = relleno sólido de acento + texto blanco.
struct SettingsPillButton: View {
    let title: String
    var isActive: Bool = false
    var isWorking: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if isWorking {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Text(title)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(isActive ? RistakTheme.onAccent : RistakTheme.textPrimary)
            .background(
                Capsule().fill(isActive ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || isWorking)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
