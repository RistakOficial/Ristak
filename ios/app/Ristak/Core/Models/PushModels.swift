import Foundation

// MARK: - Config pública de push (doc 11 §5.1)

/// `GET /api/push/public-key` → `data`.
struct PushPublicKeyConfig: Decodable, Sendable, Equatable {
    /// Web Push (VAPID) disponible.
    let configured: Bool
    let publicKey: String?
    /// Hay transporte nativo (APNs/FCM local o broker central).
    let nativeConfigured: Bool?
    let androidConfigured: Bool?
    /// La app DEBE validar esto antes de registrar (doc 11 §5.1).
    let iosConfigured: Bool?

    enum CodingKeys: String, CodingKey {
        case configured, publicKey, nativeConfigured, androidConfigured, iosConfigured
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        configured = container.flexibleBool(forKey: .configured) ?? false
        publicKey = container.flexibleString(forKey: .publicKey)
        nativeConfigured = container.flexibleBool(forKey: .nativeConfigured)
        androidConfigured = container.flexibleBool(forKey: .androidConfigured)
        iosConfigured = container.flexibleBool(forKey: .iosConfigured)
    }
}

// MARK: - Registro de dispositivo (doc 11 §5.2)

/// Body exacto de `POST /api/push/mobile-devices`.
/// ⚠️ `token` = device token APNs en HEX (nunca base64 — audit doc 10 #1).
struct MobilePushDeviceRegistration: Encodable, Sendable {
    let token: String
    let platform: String
    /// `[]` = todos los calendarios.
    let calendarIds: [String]
    let appVersion: String
    let appBuild: String
    let deviceModel: String
    let osVersion: String
    /// Metadata explicita para que el broker nunca clasifique este token APNs
    /// como un cliente Expo/Android heredado.
    let clientType: String
    let appPackage: String

    init(
        token: String,
        platform: String = "ios",
        calendarIds: [String] = [],
        appVersion: String = "",
        appBuild: String = "",
        deviceModel: String = "",
        osVersion: String = "",
        clientType: String = "native",
        appPackage: String = Bundle.main.bundleIdentifier ?? "com.ristak.app"
    ) {
        self.token = token
        self.platform = platform
        self.calendarIds = calendarIds
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.deviceModel = deviceModel
        self.osVersion = osVersion
        self.clientType = clientType
        self.appPackage = appPackage
    }
}

/// `POST /api/push/mobile-devices` → 201 `data`.
struct MobilePushDeviceAck: Decodable, Sendable {
    let id: String?
    let platform: String?
    let enabled: Bool?
    let calendarIds: [String]?

    enum CodingKeys: String, CodingKey {
        case id, platform, enabled, calendarIds
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        platform = container.flexibleString(forKey: .platform)
        enabled = container.flexibleBool(forKey: .enabled)
        calendarIds = try? container.decodeIfPresent([String].self, forKey: .calendarIds)
    }
}

/// Body de `DELETE /api/push/mobile-devices`.
struct MobilePushDeviceDeleteRequest: Encodable, Sendable {
    let token: String
}

// MARK: - Resultado del flujo de registro (copys exactos doc 11 §10.1)

enum PushRegistrationOutcome: Equatable, Sendable {
    case subscribed
    case notConfigured(message: String)
    case denied(message: String)
    case failed(message: String)

    static let defaultNotConfiguredMessage =
        "Las notificaciones de iPhone todavía no están preparadas para esta instalación."
    static let defaultDeniedMessage =
        "Este celular no dio permiso para recibir notificaciones de Ristak."

    var message: String? {
        switch self {
        case .subscribed: return nil
        case .notConfigured(let message), .denied(let message), .failed(let message):
            return message
        }
    }
}

// MARK: - Deep links de push (doc 11 §10.3)

/// Destino tipado derivado del `userInfo` de una notificación.
/// Router de RN `getPhoneSectionFromNotification` portado 1:1.
enum RistakDeepLink: Equatable, Sendable {
    case chat(contactID: String?)
    case appointment(appointmentID: String?)
    case payments
    case analytics
    case settings

    /// Parsea el `userInfo` del push. Todos los campos custom son strings
    /// (el backend los castea con `String(value||'')`).
    static func parse(userInfo: [AnyHashable: Any]) -> RistakDeepLink {
        let url = string("url", in: userInfo) ?? string("route", in: userInfo) ?? "/movil"
        let category = string("category", in: userInfo) ?? ""
        let contactID = string("contactId", in: userInfo)
            ?? string("contact_id", in: userInfo)
            ?? queryValue(in: url, names: ["contact", "contactId"])

        let haystack = (url + " " + category).lowercased()

        if containsAny(haystack, ["/calendar", "appointment", "cita"]) {
            return .appointment(appointmentID: queryValue(in: url, names: ["id", "appointmentId"]))
        }
        if containsAny(haystack, ["/transactions", "/payments", "payment", "pago"]) {
            return .payments
        }
        if haystack.contains("analytic") {
            return .analytics
        }
        if containsAny(haystack, ["setting", "ajuste"]) {
            return .settings
        }
        // `contactId` presente o keywords de chat → Chats (default: Chats).
        return .chat(contactID: contactID)
    }

    private static func containsAny(_ haystack: String, _ needles: [String]) -> Bool {
        needles.contains { haystack.contains($0) }
    }

    private static func string(_ key: String, in userInfo: [AnyHashable: Any]) -> String? {
        guard let raw = userInfo[key] else { return nil }
        let value: String
        if let string = raw as? String {
            value = string
        } else if let number = raw as? NSNumber {
            value = number.stringValue
        } else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func queryValue(in url: String, names: [String]) -> String? {
        guard let components = URLComponents(string: url) else { return nil }
        for name in names {
            if let value = components.queryItems?.first(where: { $0.name == name })?.value,
               !value.isEmpty {
                return value
            }
        }
        return nil
    }
}
