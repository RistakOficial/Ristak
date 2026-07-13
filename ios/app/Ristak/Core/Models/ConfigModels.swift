import Foundation

// MARK: - Respuestas de configuración

/// `GET /api/settings/timezone` → `{ success, timezone, source }` (NO se desenvuelve).
struct RistakTimezoneSettings: Decodable, Sendable {
    let success: Bool?
    let timezone: String?
    let source: String?

    enum CodingKeys: String, CodingKey {
        case success, timezone, source
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        timezone = container.flexibleString(forKey: .timezone)
        source = container.flexibleString(forKey: .source)
    }
}

/// `GET /api/config` y `GET /api/user-config` → `{ success, config: { k: v|null } }`.
/// Valores tolerantes: strings tal cual, números/bools serializados, null → nil.
struct RistakKeyedConfigPayload: Decodable, Sendable {
    let success: Bool?
    /// Valor por clave; `.some(nil)` = clave presente con `null`.
    let config: [String: String?]

    enum CodingKeys: String, CodingKey {
        case success, config
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        let raw = (try? container.decodeIfPresent([String: RistakJSONValue].self, forKey: .config)) ?? nil
        var result: [String: String?] = [:]
        for (key, value) in raw ?? [:] {
            result[key] = value.configStringValue
        }
        config = result
    }
}

/// Body de escritura `POST /api/config` / `POST /api/user-config`: `{ key, value }`.
struct RistakConfigWriteBody: Encodable, Sendable {
    let key: String
    let value: String?
}

/// Body de escritura batch: `{ config: { k: v } }`.
struct RistakConfigBatchWriteBody: Encodable, Sendable {
    let config: [String: String?]
}

// MARK: - Claves de configuración (doc research/10 §3)

/// Claves de `app_config` (globales del tenant) que usa la app móvil.
enum RistakAppConfigKey {
    static let aiAgentEnabled = "mobile_chat_ai_agent_enabled"
    static let aiReplySuggestionsEnabled = "mobile_chat_ai_reply_suggestions_enabled"
    static let showArchived = "mobile_chat_show_archived"
    static let sortMode = "mobile_chat_sort_mode"
    static let showLastPreview = "mobile_chat_show_last_preview"
    static let showUnreadIndicators = "mobile_chat_show_unread_indicators"
    static let themePreference = "mobile_chat_theme_preference"
    /// Señal de tono claro/oscuro del CRM de ESCRITORIO (`ThemeContext.tsx` →
    /// `theme_color`, `'light' | 'dark'`). La app móvil la LEE para heredar el
    /// claro/oscuro elegido en el escritorio y la ESCRIBE al cambiar el tema
    /// para que escritorio y otras sesiones se sincronicen. El escritorio NUNCA
    /// codifica claro/oscuro en `theme_dir` (esa clave es solo la familia visual
    /// Aurora/Onyx/Brut/Nimbus), así que la única señal de tono válida es
    /// `theme_color`. (Añadido para #6 THEME SYNC — no existe en la app RN.)
    static let desktopThemeColor = "theme_color"
    static let selectedWhatsAppPhoneID = "mobile_chat_selected_whatsapp_phone_id"
    static let sendReadReceipts = "chat_send_read_receipts_enabled"
    static let defaultCalendarID = "default_calendar_id"
    static let accountCurrency = "account_currency"
    static let filterChipIDs = "mobile_chat_filter_chip_ids"
    static let customFilterPresets = "mobile_chat_custom_filter_presets"

    /// Batch que carga `AppConfigStore` al iniciar sesión.
    static let batchKeys: [String] = [
        accountCurrency,
        aiAgentEnabled,
        aiReplySuggestionsEnabled,
        showArchived,
        sortMode,
        showLastPreview,
        showUnreadIndicators,
        themePreference,
        desktopThemeColor,
        selectedWhatsAppPhoneID,
        sendReadReceipts,
        defaultCalendarID,
        filterChipIDs,
        customFilterPresets,
    ]
}

/// Defaults de producto para preferencias opcionales. Mantenerlos explícitos
/// evita que una clave ausente termine habilitando funciones por accidente.
enum RistakAppConfigDefaults {
    static let aiReplySuggestionsEnabled = false
}

/// Claves whitelisteadas de `user_app_config` (por usuario).
enum RistakUserConfigKey {
    static let chatPushEnabled = "chat_push_notifications_enabled"
    static let calendarPushEnabled = "calendar_push_notifications_enabled"
    static let appointmentConfirmationPushEnabled = "appointment_confirmation_push_notifications_enabled"
    static let paymentPushEnabled = "payment_push_notifications_enabled"
    static let pushSoundEnabled = "push_notification_sound_enabled"
    static let pushVibrationEnabled = "push_notification_vibration_enabled"
    static let calendarPushCalendarIDs = "calendar_push_notification_calendar_ids"
    static let appointmentEntryMode = "mobile_chat_appointment_entry_mode"

    static let batchKeys: [String] = [
        chatPushEnabled,
        calendarPushEnabled,
        appointmentConfirmationPushEnabled,
        paymentPushEnabled,
        pushSoundEnabled,
        pushVibrationEnabled,
        calendarPushCalendarIDs,
        appointmentEntryMode,
    ]
}

// MARK: - Valores tipados

/// `mobile_chat_theme_preference`: valor inválido → `.system`.
enum RistakThemePreference: String, Codable, CaseIterable, Sendable {
    case system
    case light
    case dark
    case auto

    static func parse(_ raw: String?) -> RistakThemePreference {
        guard let raw else { return .system }
        return RistakThemePreference(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ?? .system
    }
}

/// `mobile_chat_sort_mode`.
enum RistakChatSortMode: String, Codable, Sendable {
    case recent
    case unread

    static func parse(_ raw: String?) -> RistakChatSortMode {
        guard let raw else { return .recent }
        return RistakChatSortMode(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ?? .recent
    }
}

/// `mobile_chat_appointment_entry_mode`.
enum RistakAppointmentEntryMode: String, Codable, Sendable {
    case form
    case calendar

    static func parse(_ raw: String?) -> RistakAppointmentEntryMode {
        guard let raw else { return .form }
        return RistakAppointmentEntryMode(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ?? .form
    }
}
