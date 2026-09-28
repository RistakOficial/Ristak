import SwiftUI
import UIKit

/// Panel «Notificaciones» (doc 10 §5.1 `renderNotifications`, doc 11 §10.2):
/// - Switch de activación visible sólo mientras push está apagado; el primer
///   toque abre el permiso nativo y, si ya fue negado, abre Ajustes de iOS.
/// - Toggles por usuario (`/api/user-config`): chat, citas, confirmaciones,
///   pagos, sonido y vibración (esta última sin efecto en iOS — paridad UI).
/// - Cada aviso activo ofrece sus propias condiciones, incluido Calendario del aviso.
struct SettingsNotificationsPanel: View {
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var saveError = SettingsSaveErrorPresenter()
    @State private var pushAlertTitle: String?
    @State private var pushAlertMessage: String?
    @State private var awaitingSystemSettings = false

    private var push: PushRegistrar { PushRegistrar.shared }

    var body: some View {
        SettingsPanelScroll {
            if shouldShowPermissionToggle {
                permissionToggle
            }

            SectionCard(title: "Avisos") {
                VStack(spacing: RistakTheme.Spacing.sm) {
                    SettingsToggleRow(
                        title: "Mensajes del chat",
                        subtitle: "Avísame cuando llegue un WhatsApp nuevo.",
                        isOn: appConfig.chatPushEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.chatPushEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.chatPushEnabled)
                    }
                    if appConfig.chatPushEnabled { filterLink("chat_push_contact_filter", title: "Mensajes del chat") }

                    Divider()

                    SettingsToggleRow(
                        title: "Citas agendadas",
                        subtitle: "Avísame cuando alguien reserve una cita nueva.",
                        isOn: appConfig.calendarPushEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.calendarPushEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.calendarPushEnabled)
                    }

                    if appConfig.calendarPushEnabled { filterLink("calendar_push_contact_filter", title: "Citas agendadas") }

                    Divider()

                    SettingsToggleRow(
                        title: "Citas confirmadas",
                        subtitle: "Avísame cuando un cliente confirme que sí asistirá.",
                        isOn: appConfig.appointmentConfirmationPushEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.appointmentConfirmationPushEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.appointmentConfirmationPushEnabled)
                    }
                    if appConfig.appointmentConfirmationPushEnabled { filterLink("appointment_confirmation_push_contact_filter", title: "Citas confirmadas") }

                    Divider()

                    SettingsToggleRow(
                        title: "Pagos",
                        subtitle: "Avísame cuando se registre un pago.",
                        isOn: appConfig.paymentPushEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.paymentPushEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.paymentPushEnabled)
                    }
                    if appConfig.paymentPushEnabled { filterLink("payment_push_contact_filter", title: "Pagos") }
                }
            }

            SectionCard(title: "Sonido y vibración") {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    Text("Controla cómo se sienten las alertas en este celular.")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)

                    SettingsToggleRow(
                        title: "Timbre de notificación",
                        subtitle: "Hace sonar el celular cuando llegue una alerta.",
                        isOn: appConfig.pushSoundEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.pushSoundEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.pushSoundEnabled)
                    }

                    Divider()

                    SettingsToggleRow(
                        title: "Vibración de notificación",
                        subtitle: "Vibra cuando entren mensajes, citas, confirmaciones o pagos.",
                        isOn: appConfig.pushVibrationEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.pushVibrationEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.pushVibrationEnabled)
                    }

                    // En iOS la vibración la decide el sistema; el ajuste
                    // aplica a Android (audit doc 10 #2 — se muestra por paridad).
                    Text("En iPhone la vibración la controla el sistema; este ajuste aplica a celulares Android.")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textMute)
                }
            }
        }
        .navigationTitle("Notificaciones")
        .navigationBarTitleDisplayMode(.inline)
        .settingsSaveErrorAlert(saveError)
        .task {
            await push.refreshPermissionState()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            Task {
                let shouldConfirmActivation = awaitingSystemSettings
                await push.refreshPermissionState()
                guard shouldConfirmActivation else { return }
                awaitingSystemSettings = false
                guard push.permissionState == .granted else { return }
                await activatePush()
            }
        }
        .alert(
            pushAlertTitle ?? "No se activaron",
            isPresented: Binding(
                get: { pushAlertMessage != nil },
                set: { if !$0 { pushAlertTitle = nil; pushAlertMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) {
                pushAlertTitle = nil
                pushAlertMessage = nil
            }
        } message: {
            Text(pushAlertMessage ?? "")
        }
    }

    // MARK: - Permiso del sistema

    private var shouldShowPermissionToggle: Bool {
        push.permissionState != .unknown && !push.isFullyActive
    }

    private var permissionToggle: some View {
        SectionCard {
            SettingsToggleRow(
                title: "Notificaciones apagadas",
                subtitle: permissionToggleSubtitle,
                isOn: false,
                isSaving: push.isWorking
            ) { enabled in
                guard enabled else { return }
                if push.permissionState == .denied {
                    awaitingSystemSettings = true
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        openURL(url)
                    }
                    return
                }

                Task { await activatePush() }
            }
        }
    }

    private var permissionToggleSubtitle: String {
        switch push.permissionState {
        case .denied:
            return "Toca el switch para abrir Ajustes y volver a activarlas."
        case .granted:
            return "Toca el switch para terminar de conectarlas con Ristak."
        case .notDetermined, .unknown:
            return "Toca el switch para activar las notificaciones."
        }
    }

    private func activatePush() async {
        let calendarIDs = appConfig.calendarPushEnabled ? appConfig.calendarPushCalendarIDs : []
        let outcome = await push.activate(calendarIDs: calendarIDs)

        switch outcome {
        case .subscribed:
            pushAlertTitle = "Notificaciones activadas"
            pushAlertMessage = "Ristak ya puede avisarte cuando llegue algo importante."
        case .notConfigured(let message):
            pushAlertTitle = "Falta preparar alertas"
            pushAlertMessage = message
        case .denied(let message):
            pushAlertTitle = "No se activaron"
            pushAlertMessage = message
        case .failed(let message):
            pushAlertTitle = "No se activaron las alertas"
            pushAlertMessage = message
        }
    }

    private func filterLink(_ key: String, title: String) -> some View {
        let raw = appConfig.userConfig[key] ?? ""
        let count = (try? JSONDecoder().decode(NotificationEventFilter.self, from: Data(raw.utf8)))?.conditionCount ?? 0
        return NavigationLink {
            NotificationContactFilterEditor(configKey: key, title: title)
        } label: {
            HStack {
                Label("Agregar filtro", systemImage: "plus")
                Spacer()
                if count > 0 { Text("\(count) \(count == 1 ? "condición" : "condiciones")").font(.caption).foregroundStyle(RistakTheme.textDim) }
                Image(systemName: "chevron.right").font(.caption)
            }
            .font(.subheadline)
            .padding(.vertical, RistakTheme.Spacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Filtros de \(title)")
    }

    private func writeUserBool(_ value: Bool, key: String) {
        saveError.run { try await appConfig.setUserConfigBool(value, forKey: key) }
    }
}
