import Foundation
import Observation
import SwiftUI

/// Store de configuración de la cuenta y del usuario (doc research/10):
/// - `GET /api/settings/timezone` → zona horaria del NEGOCIO (nunca la del
///   dispositivo), fallback `America/Mexico_City`.
/// - `GET /api/config?keys=…` (batch) → prefs globales `mobile_chat_*`,
///   `account_currency`, vistos, etc. Valores string ("1/true/yes/on" → bool).
/// - `GET /api/user-config?keys=…` → prefs por usuario (notificaciones,
///   `mobile_chat_appointment_entry_mode`) con fallback al global.
/// Escrituras optimistas con rollback (`POST /api/config`, `POST /api/user-config`).
@MainActor
@Observable
final class AppConfigStore {
    static let defaultTimeZoneIdentifier = "America/Mexico_City"

    // MARK: Estado

    private(set) var businessTimeZone: TimeZone = TimeZone(identifier: AppConfigStore.defaultTimeZoneIdentifier)!
    private(set) var timezoneSource: String?

    /// Valores globales cargados (solo claves con valor no-null).
    private(set) var appConfig: [String: String] = [:]
    /// Valores por usuario cargados.
    private(set) var userConfig: [String: String] = [:]

    /// ¿Ya terminó la carga inicial (aunque haya fallado alguna parte)?
    private(set) var isLoaded = false
    /// ¿Se pudo leer `/api/config` (necesario para la regla de moneda)?
    private(set) var appConfigLoadSucceeded = false
    /// Claves con escritura en vuelo (deshabilitar su control mientras).
    private(set) var savingKeys: Set<String> = []

    init() {}

    // MARK: - Carga

    /// Carga inicial (llamar al abrir sesión). Las tres llamadas van en paralelo;
    /// los fallos se degradan a defaults del cliente.
    func load() async {
        async let timezoneTask = fetchTimezone()
        async let appConfigTask = fetchKeyedConfig(path: "/api/config", keys: RistakAppConfigKey.batchKeys)
        async let userConfigTask = fetchKeyedConfig(path: "/api/user-config", keys: RistakUserConfigKey.batchKeys)

        let (timezoneResult, appConfigResult, userConfigResult) = await (timezoneTask, appConfigTask, userConfigTask)

        if let identifier = timezoneResult?.timezone?.trimmingCharacters(in: .whitespacesAndNewlines),
           !identifier.isEmpty,
           let zone = TimeZone(identifier: identifier) {
            businessTimeZone = zone
            timezoneSource = timezoneResult?.source
        }

        if let payload = appConfigResult {
            appConfigLoadSucceeded = true
            appConfig = Self.compactValues(payload.config)
        }

        if let payload = userConfigResult {
            userConfig = Self.compactValues(payload.config)
        }

        isLoaded = true
    }

    /// Recarga completa (p. ej. pull-to-refresh de Ajustes o re-login).
    func refresh() async {
        await load()
    }

    /// Limpia el estado al cerrar sesión / cambiar de empresa.
    func reset() {
        businessTimeZone = TimeZone(identifier: Self.defaultTimeZoneIdentifier)!
        timezoneSource = nil
        appConfig = [:]
        userConfig = [:]
        isLoaded = false
        appConfigLoadSucceeded = false
        savingKeys = []
    }

    private func fetchTimezone() async -> RistakTimezoneSettings? {
        try? await APIClient.shared.get("/api/settings/timezone")
    }

    private func fetchKeyedConfig(path: String, keys: [String]) async -> RistakKeyedConfigPayload? {
        try? await APIClient.shared.get(path, query: ["keys": keys.joined(separator: ",")])
    }

    private static func compactValues(_ raw: [String: String?]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in raw {
            if let value { result[key] = value }
        }
        return result
    }

    // MARK: - Escrituras optimistas con rollback

    /// Escribe una clave global (`POST /api/config {key, value}`). Optimista:
    /// aplica el valor local, y si el POST falla lo revierte y relanza el error
    /// (la UI muestra "No se guardó el ajuste").
    func setAppConfigValue(_ value: String?, forKey key: String) async throws {
        try await write(
            path: "/api/config",
            key: key,
            value: value,
            dictionary: \AppConfigStore.appConfig
        )
    }

    func setAppConfigBool(_ value: Bool, forKey key: String) async throws {
        try await setAppConfigValue(value ? "true" : "false", forKey: key)
    }

    /// Escribe una clave por usuario (`POST /api/user-config {key, value}`,
    /// whitelist del backend).
    func setUserConfigValue(_ value: String?, forKey key: String) async throws {
        try await write(
            path: "/api/user-config",
            key: key,
            value: value,
            dictionary: \AppConfigStore.userConfig
        )
    }

    func setUserConfigBool(_ value: Bool, forKey key: String) async throws {
        try await setUserConfigValue(value ? "true" : "false", forKey: key)
    }

    /// Serializa un array de strings como JSON (p. ej. `calendar_push_notification_calendar_ids`).
    func setUserConfigStringArray(_ values: [String], forKey key: String) async throws {
        let data = try? JSONEncoder().encode(values)
        let json = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        try await setUserConfigValue(json, forKey: key)
    }

    func setAppConfigStringArray(_ values: [String], forKey key: String) async throws {
        let data = try? JSONEncoder().encode(values)
        let json = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        try await setAppConfigValue(json, forKey: key)
    }

    private func write(
        path: String,
        key: String,
        value: String?,
        dictionary keyPath: ReferenceWritableKeyPath<AppConfigStore, [String: String]>
    ) async throws {
        let previous = self[keyPath: keyPath][key]

        if let value {
            self[keyPath: keyPath][key] = value
        } else {
            self[keyPath: keyPath].removeValue(forKey: key)
        }

        savingKeys.insert(key)
        defer { savingKeys.remove(key) }

        do {
            let _: APIAcknowledgment = try await APIClient.shared.post(
                path,
                body: RistakConfigWriteBody(key: key, value: value)
            )
        } catch {
            if let previous {
                self[keyPath: keyPath][key] = previous
            } else {
                self[keyPath: keyPath].removeValue(forKey: key)
            }
            throw error
        }
    }

    // MARK: - Helpers de parseo

    private func boolValue(_ raw: String?, default defaultValue: Bool) -> Bool {
        RistakStringBool.parse(raw) ?? defaultValue
    }

    private func stringArrayValue(_ raw: String?) -> [String] {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8) else { return [] }
        guard let values = try? JSONDecoder().decode([RistakJSONValue].self, from: data) else { return [] }
        return values.compactMap { $0.stringValue }
    }

    // MARK: - Accessors tipados: app_config (globales)

    /// Toggle "Mostrar como primer chat" (agente fijo arriba de la bandeja).
    var aiAgentChatEnabled: Bool {
        boolValue(appConfig[RistakAppConfigKey.aiAgentEnabled], default: true)
    }

    /// Toggle "Sugerir respuestas".
    var aiReplySuggestionsEnabled: Bool {
        boolValue(appConfig[RistakAppConfigKey.aiReplySuggestionsEnabled], default: false)
    }

    /// Toggle "Mostrar archivados".
    var showArchivedChats: Bool {
        boolValue(appConfig[RistakAppConfigKey.showArchived], default: true)
    }

    /// Segmented "Ordenar conversaciones".
    var chatSortMode: RistakChatSortMode {
        RistakChatSortMode.parse(appConfig[RistakAppConfigKey.sortMode])
    }

    /// Toggle "Vista previa".
    var showLastMessagePreview: Bool {
        boolValue(appConfig[RistakAppConfigKey.showLastPreview], default: true)
    }

    /// Toggle "Indicadores de no leídos".
    var showUnreadIndicators: Bool {
        boolValue(appConfig[RistakAppConfigKey.showUnreadIndicators], default: true)
    }

    /// Panel Apariencia.
    var themePreference: RistakThemePreference {
        RistakThemePreference.parse(appConfig[RistakAppConfigKey.themePreference])
    }

    /// Bandeja "Juntos"/"Separado": `'all'` o un phoneNumberId.
    var selectedWhatsAppPhoneID: String {
        let raw = appConfig[RistakAppConfigKey.selectedWhatsAppPhoneID]?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let raw, !raw.isEmpty else { return "all" }
        return raw
    }

    /// Panel Privacidad: vistos externos (read receipts).
    var sendReadReceiptsEnabled: Bool {
        boolValue(appConfig[RistakAppConfigKey.sendReadReceipts], default: true)
    }

    /// Calendario default de la cuenta (solo lectura en móvil).
    var defaultCalendarID: String {
        appConfig[RistakAppConfigKey.defaultCalendarID] ?? ""
    }

    /// Chips de filtro visibles de la bandeja (JSON array de ids).
    var chatFilterChipIDs: [String] {
        stringArrayValue(appConfig[RistakAppConfigKey.filterChipIDs])
    }

    /// Presets de filtros custom, crudo (el módulo Chats define su modelo).
    var customFilterPresetsRaw: String? {
        appConfig[RistakAppConfigKey.customFilterPresets]
    }

    // MARK: Moneda de la cuenta

    /// Moneda de la cuenta normalizada, o `nil` si `/api/config` no se pudo
    /// leer. REGLA DURA (doc 01 §10): sin `account_currency` la app NO debe
    /// crear registros de dinero.
    var accountCurrency: String? {
        guard appConfigLoadSucceeded else { return nil }
        return BusinessFormatters.normalizeCurrencyCode(appConfig[RistakAppConfigKey.accountCurrency])
    }

    /// ¿Se pueden crear registros de dinero? (`account_currency` legible).
    var canCreateMoneyRecords: Bool {
        accountCurrency != nil
    }

    /// Moneda para FORMATEO de montos existentes (fallback visual `MXN`).
    var displayCurrencyCode: String {
        accountCurrency ?? "MXN"
    }

    // MARK: - Accessors tipados: user_config (por usuario)

    /// Toggle "Mensajes del chat".
    var chatPushEnabled: Bool {
        boolValue(userConfig[RistakUserConfigKey.chatPushEnabled], default: true)
    }

    /// Toggle "Citas agendadas".
    var calendarPushEnabled: Bool {
        boolValue(userConfig[RistakUserConfigKey.calendarPushEnabled], default: false)
    }

    /// Toggle "Citas confirmadas".
    var appointmentConfirmationPushEnabled: Bool {
        boolValue(userConfig[RistakUserConfigKey.appointmentConfirmationPushEnabled], default: true)
    }

    /// Toggle "Pagos".
    var paymentPushEnabled: Bool {
        boolValue(userConfig[RistakUserConfigKey.paymentPushEnabled], default: true)
    }

    /// Toggle "Timbre de notificación".
    var pushSoundEnabled: Bool {
        boolValue(userConfig[RistakUserConfigKey.pushSoundEnabled], default: true)
    }

    /// Toggle "Vibración de notificación" (sin efecto en iOS; paridad de UI).
    var pushVibrationEnabled: Bool {
        boolValue(userConfig[RistakUserConfigKey.pushVibrationEnabled], default: true)
    }

    /// Calendarios con alertas; `[]` significa TODOS.
    var calendarPushCalendarIDs: [String] {
        stringArrayValue(userConfig[RistakUserConfigKey.calendarPushCalendarIDs])
    }

    /// Preferencia del sheet de citas del chat (`form` | `calendar`).
    var appointmentEntryMode: RistakAppointmentEntryMode {
        RistakAppointmentEntryMode.parse(userConfig[RistakUserConfigKey.appointmentEntryMode])
    }

    // MARK: - Tema

    /// Resolución del tema para `preferredColorScheme`:
    /// `system` → nil (sigue al SO); `light`/`dark` literales;
    /// `auto` → oscuro de 19:00 a 05:59 en la zona horaria del negocio.
    var preferredColorScheme: ColorScheme? {
        switch themePreference {
        case .system:
            return nil
        case .light:
            return .light
        case .dark:
            return .dark
        case .auto:
            return isNightTime() ? .dark : .light
        }
    }

    /// ¿Es horario nocturno (≥ 19:00 o < 06:00) en la zona del negocio?
    func isNightTime(at date: Date = Date()) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = businessTimeZone
        let hour = calendar.component(.hour, from: date)
        return hour >= 19 || hour < 6
    }

    // MARK: - Formatters

    /// Formateadores de negocio con la zona horaria y moneda vigentes.
    var formatters: BusinessFormatters {
        BusinessFormatters(timeZone: businessTimeZone, currencyCode: displayCurrencyCode)
    }
}
