import SwiftUI
import UIKit

/// Panel «Notificaciones» (doc 10 §5.1 `renderNotifications`, doc 11 §10.2):
/// - Card de permiso nativo con botón «Activar»/«Actualizar» (PushRegistrar) y
///   deep link «Abrir Ajustes» cuando el permiso está bloqueado.
/// - Toggles por usuario (`/api/user-config`): chat, citas, confirmaciones,
///   pagos, sonido y vibración (esta última sin efecto en iOS — paridad UI).
/// - «Calendarios con alertas»: multiselección → re-registro del token con los
///   `calendarIds` nuevos.
struct SettingsNotificationsPanel: View {
    @Environment(SettingsModel.self) private var model
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.openURL) private var openURL

    @State private var saveError = SettingsSaveErrorPresenter()
    @State private var pushStatusMessage: String?
    @State private var pushAlertTitle: String?
    @State private var pushAlertMessage: String?

    private var push: PushRegistrar { PushRegistrar.shared }

    var body: some View {
        SettingsPanelScroll {
            permissionCard

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

                    Divider()

                    SettingsToggleRow(
                        title: "Citas agendadas",
                        subtitle: "Avísame cuando alguien reserve una cita nueva.",
                        isOn: appConfig.calendarPushEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.calendarPushEnabled)
                    ) { newValue in
                        toggleCalendarPush(newValue)
                    }

                    if appConfig.calendarPushEnabled {
                        calendarsCard
                    }

                    Divider()

                    SettingsToggleRow(
                        title: "Citas confirmadas",
                        subtitle: "Avísame cuando un cliente confirme que sí asistirá.",
                        isOn: appConfig.appointmentConfirmationPushEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.appointmentConfirmationPushEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.appointmentConfirmationPushEnabled)
                    }

                    Divider()

                    SettingsToggleRow(
                        title: "Pagos",
                        subtitle: "Avísame cuando se registre un pago.",
                        isOn: appConfig.paymentPushEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakUserConfigKey.paymentPushEnabled)
                    ) { newValue in
                        writeUserBool(newValue, key: RistakUserConfigKey.paymentPushEnabled)
                    }
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

    // MARK: - Card de permiso

    private var permissionCard: some View {
        let granted = push.permissionState == .granted

        return SectionCard(title: "Este celular") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    Image(systemName: granted ? "checkmark.circle.fill" : "bell.badge")
                        .font(.title3.weight(.medium))
                        .foregroundStyle(granted ? RistakTheme.pos : RistakTheme.warn)
                        .frame(width: 42, height: 42)
                        .background(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                                .fill(granted ? RistakTheme.posSoft : RistakTheme.warnSoft)
                        )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(granted
                            ? "Alertas activas en este celular · \(enabledTypesCount) tipos prendidos."
                            : "Permiso nativo: \(permissionLabel).")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(RistakTheme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)

                        if let pushStatusMessage {
                            Text(pushStatusMessage)
                                .font(.footnote)
                                .foregroundStyle(RistakTheme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    Spacer(minLength: 0)
                }

                HStack(spacing: RistakTheme.Spacing.xs) {
                    Button {
                        Task { await activatePush() }
                    } label: {
                        HStack(spacing: 6) {
                            if push.isWorking {
                                ProgressView().controlSize(.small)
                            }
                            Text(granted ? "Actualizar" : "Activar")
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(push.isWorking)

                    if push.permissionState == .denied {
                        Button("Abrir Ajustes") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                openURL(url)
                            }
                        }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                    }
                }
            }
        }
    }

    /// Etiqueta del permiso nativo (labels RN: Activo/Bloqueado/No soportado/Activar).
    private var permissionLabel: String {
        switch push.permissionState {
        case .granted: return "Activo"
        case .denied: return "Bloqueado"
        case .notDetermined: return "Activar"
        case .unknown: return "No soportado"
        }
    }

    /// «N tipos prendidos»: chat + citas + confirmaciones + pagos activos.
    private var enabledTypesCount: Int {
        [
            appConfig.chatPushEnabled,
            appConfig.calendarPushEnabled,
            appConfig.appointmentConfirmationPushEnabled,
            appConfig.paymentPushEnabled,
        ].filter { $0 }.count
    }

    private func activatePush() async {
        pushStatusMessage = "Activando alertas en este celular..."
        let calendarIDs = appConfig.calendarPushEnabled ? appConfig.calendarPushCalendarIDs : []
        let outcome = await push.activate(calendarIDs: calendarIDs)

        switch outcome {
        case .subscribed:
            pushStatusMessage = "Alertas activas en este celular."
        case .notConfigured(let message):
            pushStatusMessage = message
            pushAlertTitle = "Falta preparar alertas"
            pushAlertMessage = message
        case .denied(let message):
            pushStatusMessage = message
            pushAlertTitle = "No se activaron"
            pushAlertMessage = message
        case .failed(let message):
            pushStatusMessage = message
            pushAlertTitle = "No se activaron las alertas"
            pushAlertMessage = message
        }
    }

    // MARK: - Calendarios con alertas

    private var calendarsCard: some View {
        let selectedIDs = appConfig.calendarPushCalendarIDs
        let isSavingIDs = appConfig.savingKeys.contains(RistakUserConfigKey.calendarPushCalendarIDs)

        return VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            HStack {
                Text("Calendarios con alertas")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)

                Spacer(minLength: RistakTheme.Spacing.xs)

                Text(selectedIDs.isEmpty ? "Todos" : "\(selectedIDs.count) seleccionados")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            }

            switch model.calendars {
            case .idle, .loading:
                Text("Cargando calendarios...")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            case .failed(let message), .accessDenied(let message), .featureBlocked(let message):
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            case .loaded(let calendars):
                if calendars.isEmpty {
                    Text("No hay calendarios activos para elegir.")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                } else {
                    calendarChips(calendars: calendars, selectedIDs: selectedIDs, isSaving: isSavingIDs)
                }
            }
        }
        .padding(RistakTheme.Spacing.sm)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                .fill(RistakTheme.surface2)
        )
    }

    private func calendarChips(calendars: [RistakCalendar], selectedIDs: [String], isSaving: Bool) -> some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 150), spacing: RistakTheme.Spacing.xs)],
            alignment: .leading,
            spacing: RistakTheme.Spacing.xs
        ) {
            calendarChip(
                title: "Todos los calendarios",
                dotColor: nil,
                isSelected: selectedIDs.isEmpty,
                isDisabled: isSaving
            ) {
                writeCalendarIDs([])
            }

            ForEach(calendars) { calendar in
                calendarChip(
                    title: calendar.name,
                    dotColor: calendarDotColor(calendar),
                    isSelected: selectedIDs.contains(calendar.id),
                    isDisabled: isSaving
                ) {
                    var ids = selectedIDs
                    if let index = ids.firstIndex(of: calendar.id) {
                        ids.remove(at: index)
                    } else {
                        ids.append(calendar.id)
                    }
                    writeCalendarIDs(ids)
                }
            }
        }
    }

    /// Chip de calendario: seleccionado = relleno sólido de acento + texto
    /// blanco (regla de selección de ARCHITECTURE.md).
    private func calendarChip(
        title: String,
        dotColor: Color?,
        isSelected: Bool,
        isDisabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let dotColor {
                    Circle()
                        .fill(isSelected ? RistakTheme.onAccent : dotColor)
                        .frame(width: 8, height: 8)
                }
                Text(title)
                    .font(.footnote.weight(.medium))
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity)
            .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textPrimary)
            .background(
                Capsule().fill(isSelected ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .sensoryFeedback(.selection, trigger: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func calendarDotColor(_ calendar: RistakCalendar) -> Color {
        let hex = calendar.eventColor.trimmingCharacters(in: .whitespacesAndNewlines)
        return Self.color(fromHex: hex) ?? RistakTheme.accent
    }

    /// Parseo mínimo de `#rrggbb` (color del calendario; fallback acento).
    private static func color(fromHex raw: String) -> Color? {
        var hex = raw
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        return Color(red: red, green: green, blue: blue)
    }

    // MARK: - Escrituras

    private func writeUserBool(_ value: Bool, key: String) {
        saveError.run {
            try await appConfig.setUserConfigBool(value, forKey: key)
        }
    }

    /// «Citas agendadas»: al encender, si hay exactamente 1 calendario activo
    /// y la selección está vacía, se auto-selecciona (doc 10 §4.7). Luego se
    /// re-registra el token con los `calendarIds` vigentes.
    private func toggleCalendarPush(_ enabled: Bool) {
        saveError.run {
            try await appConfig.setUserConfigBool(enabled, forKey: RistakUserConfigKey.calendarPushEnabled)

            if enabled,
               let calendars = model.calendars.value,
               calendars.count == 1,
               appConfig.calendarPushCalendarIDs.isEmpty,
               let only = calendars.first {
                try await appConfig.setUserConfigStringArray([only.id], forKey: RistakUserConfigKey.calendarPushCalendarIDs)
            }

            await reRegisterTokenIfGranted()
        }
    }

    private func writeCalendarIDs(_ ids: [String]) {
        saveError.run {
            try await appConfig.setUserConfigStringArray(ids, forKey: RistakUserConfigKey.calendarPushCalendarIDs)
            await reRegisterTokenIfGranted()
        }
    }

    /// Re-registro silencioso del device con los `calendarIds` nuevos (solo si
    /// el permiso ya está concedido — nunca disparar el prompt desde un chip).
    private func reRegisterTokenIfGranted() async {
        await push.refreshPermissionState()
        guard push.permissionState == .granted else { return }
        let ids = appConfig.calendarPushEnabled ? appConfig.calendarPushCalendarIDs : []
        _ = await push.activate(calendarIDs: ids)
    }
}
