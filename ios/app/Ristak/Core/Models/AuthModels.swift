import Foundation

// MARK: - Niveles y roles

/// Nivel de acceso por módulo (`accessConfig`). Valores desconocidos → `.none`.
enum RistakAccessLevel: String, Codable, Sendable, Equatable {
    case none
    case read
    case write

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? "none"
        self = RistakAccessLevel(rawValue: raw) ?? .none
    }
}

/// Rol efectivo: todo lo que no sea `admin` se normaliza a `employee`.
enum RistakUserRole: String, Codable, Sendable, Equatable {
    case admin
    case employee

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = (raw == "admin") ? .admin : .employee
    }
}

// MARK: - Límites y módulos externos de licencia

struct RistakConversationalAgentLimits: Codable, Sendable, Equatable {
    var maxAgents: Int?

    enum CodingKeys: String, CodingKey {
        case maxAgents = "max_agents"
    }

    init(maxAgents: Int? = nil) {
        self.maxAgents = maxAgents
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        maxAgents = container.flexibleInt(forKey: .maxAgents)
    }
}

struct RistakLicenseLimits: Codable, Sendable, Equatable {
    var conversationalAgents: RistakConversationalAgentLimits?

    enum CodingKeys: String, CodingKey {
        case conversationalAgents = "conversational_agents"
    }

    init(conversationalAgents: RistakConversationalAgentLimits? = nil) {
        self.conversationalAgents = conversationalAgents
    }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        conversationalAgents = try? container?.decodeIfPresent(RistakConversationalAgentLimits.self, forKey: .conversationalAgents)
    }

    static let empty = RistakLicenseLimits()
}

/// Módulo externo del plan (`licenseExternalModules`, p. ej. `mdp_program`).
struct RistakLicenseExternalModule: Codable, Sendable, Equatable {
    var key: String?
    var label: String?
    var menuLabel: String?
    var enabled: Bool
    var sidebarPosition: Int?

    enum CodingKeys: String, CodingKey {
        case key, label, menuLabel, enabled, sidebarPosition
    }

    init(key: String? = nil, label: String? = nil, menuLabel: String? = nil, enabled: Bool = false, sidebarPosition: Int? = nil) {
        self.key = key
        self.label = label
        self.menuLabel = menuLabel
        self.enabled = enabled
        self.sidebarPosition = sidebarPosition
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = container.flexibleString(forKey: .key)
        label = container.flexibleString(forKey: .label)
        menuLabel = container.flexibleString(forKey: .menuLabel)
        enabled = container.flexibleBool(forKey: .enabled) ?? false
        sidebarPosition = container.flexibleInt(forKey: .sidebarPosition)
    }
}

// MARK: - Usuario autenticado

/// Shape exacto de `serializeAuthUser` (doc research/02 §5): devuelto por
/// `login`, `verify`, `me`, `profile`. Decodificación tolerante:
/// `id` puede ser Int o String, strings faltantes → "".
struct RistakUser: Codable, Sendable, Equatable {
    let id: String
    let username: String
    let email: String
    let firstName: String
    let lastName: String
    let fullName: String
    let phone: String
    let businessName: String
    let role: RistakUserRole
    let accessConfig: [String: RistakAccessLevel]
    let licenseEnforced: Bool
    let licensePlan: String?
    let licenseFeatures: [String: Bool]
    let licenseLimits: RistakLicenseLimits
    let licenseExternalModules: [String: RistakLicenseExternalModule]

    enum CodingKeys: String, CodingKey {
        case id, username, email, firstName, lastName, fullName, phone, businessName, role
        case accessConfig, licenseEnforced, licensePlan, licenseFeatures, licenseLimits
        case licenseExternalModules
    }

    init(
        id: String,
        username: String = "",
        email: String = "",
        firstName: String = "",
        lastName: String = "",
        fullName: String = "",
        phone: String = "",
        businessName: String = "",
        role: RistakUserRole = .employee,
        accessConfig: [String: RistakAccessLevel] = [:],
        licenseEnforced: Bool = false,
        licensePlan: String? = nil,
        licenseFeatures: [String: Bool] = [:],
        licenseLimits: RistakLicenseLimits = .empty,
        licenseExternalModules: [String: RistakLicenseExternalModule] = [:]
    ) {
        self.id = id
        self.username = username
        self.email = email
        self.firstName = firstName
        self.lastName = lastName
        self.fullName = fullName
        self.phone = phone
        self.businessName = businessName
        self.role = role
        self.accessConfig = accessConfig
        self.licenseEnforced = licenseEnforced
        self.licensePlan = licensePlan
        self.licenseFeatures = licenseFeatures
        self.licenseLimits = licenseLimits
        self.licenseExternalModules = licenseExternalModules
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        username = container.flexibleString(forKey: .username) ?? ""
        email = container.flexibleString(forKey: .email) ?? ""
        firstName = container.flexibleString(forKey: .firstName) ?? ""
        lastName = container.flexibleString(forKey: .lastName) ?? ""
        fullName = container.flexibleString(forKey: .fullName) ?? ""
        phone = container.flexibleString(forKey: .phone) ?? ""
        businessName = container.flexibleString(forKey: .businessName) ?? ""
        role = (try? container.decodeIfPresent(RistakUserRole.self, forKey: .role)) ?? .employee

        if let rawAccess = try? container.decodeIfPresent([String: RistakAccessLevel].self, forKey: .accessConfig) {
            accessConfig = rawAccess
        } else {
            accessConfig = [:]
        }

        licenseEnforced = container.flexibleBool(forKey: .licenseEnforced) ?? false
        licensePlan = container.flexibleString(forKey: .licensePlan)
        licenseFeatures = container.flexibleBoolMap(forKey: .licenseFeatures) ?? [:]
        licenseLimits = (try? container.decodeIfPresent(RistakLicenseLimits.self, forKey: .licenseLimits)) ?? .empty
        if let modules = try? container.decodeIfPresent([String: RistakLicenseExternalModule].self, forKey: .licenseExternalModules) {
            licenseExternalModules = modules
        } else {
            licenseExternalModules = [:]
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(username, forKey: .username)
        try container.encode(email, forKey: .email)
        try container.encode(firstName, forKey: .firstName)
        try container.encode(lastName, forKey: .lastName)
        try container.encode(fullName, forKey: .fullName)
        try container.encode(phone, forKey: .phone)
        try container.encode(businessName, forKey: .businessName)
        try container.encode(role.rawValue, forKey: .role)
        try container.encode(accessConfig, forKey: .accessConfig)
        try container.encode(licenseEnforced, forKey: .licenseEnforced)
        try container.encodeIfPresent(licensePlan, forKey: .licensePlan)
        try container.encode(licenseFeatures, forKey: .licenseFeatures)
        try container.encode(licenseLimits, forKey: .licenseLimits)
        try container.encode(licenseExternalModules, forKey: .licenseExternalModules)
    }

    var isAdmin: Bool { role == .admin }

    /// Nombre a mostrar: `fullName` → `username` → `email` (doc 02 §5).
    var displayName: String {
        if !fullName.isEmpty { return fullName }
        if !username.isEmpty { return username }
        return email
    }
}

// MARK: - Respuestas de auth

/// Metadatos del API token externo (`utils/apiTokens.js buildMetadata`).
struct RistakAPITokenMetadata: Codable, Sendable, Equatable {
    let hasToken: Bool
    let prefix: String?
    let lastFour: String?
    let preview: String?
    let createdAt: String?
    let lastUsedAt: String?
    let revokedAt: String?

    enum CodingKeys: String, CodingKey {
        case hasToken, prefix, lastFour, preview, createdAt, lastUsedAt, revokedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hasToken = container.flexibleBool(forKey: .hasToken) ?? false
        prefix = container.flexibleString(forKey: .prefix)
        lastFour = container.flexibleString(forKey: .lastFour)
        preview = container.flexibleString(forKey: .preview)
        createdAt = container.flexibleString(forKey: .createdAt)
        lastUsedAt = container.flexibleString(forKey: .lastUsedAt)
        revokedAt = container.flexibleString(forKey: .revokedAt)
    }
}

/// `POST /api/auth/login` → 200 (doc 02 §3.1).
struct RistakLoginResponse: Decodable, Sendable {
    let success: Bool?
    let message: String?
    let token: String?
    let appID: String?
    let apiTokenMetadata: RistakAPITokenMetadata?
    let user: RistakUser?

    enum CodingKeys: String, CodingKey {
        case success, message, token, user, apiTokenMetadata
        case appID = "appId"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        message = container.flexibleString(forKey: .message)
        token = container.flexibleString(forKey: .token)
        appID = container.flexibleString(forKey: .appID)
        apiTokenMetadata = try? container.decodeIfPresent(RistakAPITokenMetadata.self, forKey: .apiTokenMetadata)
        user = try container.decodeIfPresent(RistakUser.self, forKey: .user)
    }
}

/// `POST /api/auth/verify` → 200 `{ success, user }` (doc 02 §3.2).
struct RistakVerifyResponse: Decodable, Sendable {
    let success: Bool?
    let user: RistakUser?

    enum CodingKeys: String, CodingKey {
        case success, user
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        user = try container.decodeIfPresent(RistakUser.self, forKey: .user)
    }
}

/// `GET /api/license/status` (doc 13 §2.5).
struct RistakLicenseStatus: Decodable, Sendable {
    let success: Bool?
    let enforced: Bool
    let allowed: Bool
    let plan: String?
    let features: [String: Bool]
    let limits: RistakLicenseLimits
    let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case success, enforced, allowed, plan, features, limits
        case expiresAt = "expires_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        enforced = container.flexibleBool(forKey: .enforced) ?? false
        allowed = container.flexibleBool(forKey: .allowed) ?? true
        plan = container.flexibleString(forKey: .plan)
        features = container.flexibleBoolMap(forKey: .features) ?? [:]
        limits = (try? container.decodeIfPresent(RistakLicenseLimits.self, forKey: .limits)) ?? .empty
        expiresAt = container.flexibleString(forKey: .expiresAt)
    }
}

/// Body de `POST /api/auth/login`.
struct RistakLoginRequestBody: Encodable, Sendable {
    let email: String
    let password: String
}

/// Body de `POST /api/auth/verify` (token en body, sin header).
struct RistakVerifyRequestBody: Encodable, Sendable {
    let token: String
}
