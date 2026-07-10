import Foundation
import Observation

/// Secciones del shell móvil (orden del tab bar: Chats, Calendarios, Pagos,
/// Analíticas, Ajustes).
enum PhoneSection: String, CaseIterable, Identifiable, Sendable {
    case chat
    case calendar
    case payments
    case analytics
    case settings

    var id: String { rawValue }
}

/// Módulos alcanzables desde el shell móvil (subset de las 25 claves de
/// `accessConfig` — `mobile/src/access.ts`).
enum RistakModuleKey: String, CaseIterable, Sendable {
    case chat
    case appointments
    case payments
    case analytics
    case contacts
    case automations
    case aiAgent = "ai_agent"
    case settingsMobile = "settings_mobile"
    case dashboard
}

/// Port 1:1 de `mobile/src/access.ts` (doc research/13 §8): reglas puras de
/// visibilidad. El backend siempre re-valida por request; esto solo decide UI.
enum RistakAccessRules {
    struct LicenseFeatureRule: Sendable {
        let primary: String
        let legacy: [String]
    }

    /// Features de licencia por módulo, con claves legacy de fallback.
    static let licenseFeaturesByModule: [RistakModuleKey: LicenseFeatureRule] = [
        .chat: LicenseFeatureRule(primary: "chat", legacy: ["whatsapp"]),
        .appointments: LicenseFeatureRule(primary: "appointments", legacy: ["google_calendar"]),
        .payments: LicenseFeatureRule(primary: "payments", legacy: []),
        .analytics: LicenseFeatureRule(primary: "analytics", legacy: []),
        .contacts: LicenseFeatureRule(primary: "contacts", legacy: []),
        .automations: LicenseFeatureRule(primary: "automations", legacy: []),
        .aiAgent: LicenseFeatureRule(primary: "ai_agent", legacy: ["app_assistant_ai", "conversational_ai", "ai"]),
        .settingsMobile: LicenseFeatureRule(primary: "mobile_app", legacy: ["settings_mobile"]),
        .dashboard: LicenseFeatureRule(primary: "dashboard", legacy: []),
    ]

    /// Mapa sección del shell → módulo que la gatea (idéntico al gating de
    /// rutas de /movil).
    static let sectionModule: [PhoneSection: RistakModuleKey] = [
        .chat: .chat,
        .calendar: .appointments,
        .payments: .payments,
        .analytics: .analytics,
        .settings: .settingsMobile,
    ]

    static func isAdmin(_ user: RistakUser?) -> Bool {
        user?.role == .admin
    }

    /// Capa de licencia: fail-open cuando no está enforced o no hay regla/claves.
    static func hasLicenseFeatureAccess(user: RistakUser?, module: RistakModuleKey) -> Bool {
        guard user?.licenseEnforced == true else { return true }
        guard let rule = licenseFeaturesByModule[module] else { return true }

        let features = user?.licenseFeatures ?? [:]
        if let value = features[module.rawValue] { return value }
        if let value = features[rule.primary] { return value }
        if !rule.legacy.isEmpty {
            return rule.legacy.contains { features[$0] == true }
        }
        return false
    }

    /// Licencia + rol + `accessConfig` (con herencia legada chat→contacts).
    /// Nota: con `user == nil` esta función devuelve `false` (igual que el TS);
    /// el fail-open de usuario-cargando vive en `hasPhoneSectionAccess`.
    static func hasModuleAccess(
        user: RistakUser?,
        module: RistakModuleKey,
        requiredLevel: RistakAccessLevel = .read
    ) -> Bool {
        guard hasLicenseFeatureAccess(user: user, module: module) else { return false }
        if isAdmin(user) { return true }

        let config = user?.accessConfig ?? [:]
        var level = config[module.rawValue]
        // Compat: el módulo Chat hereda el permiso de Contactos cuando la
        // config guardada es anterior a la clave `chat`.
        if module == .chat, level == nil {
            level = config[RistakModuleKey.contacts.rawValue]
        }

        let resolved = level ?? RistakAccessLevel.none
        if requiredLevel == .write {
            return resolved == .write
        }
        return resolved == .read || resolved == .write
    }

    /// Gate de sección del shell. Con el usuario aún cargando (verify pendiente
    /// o timeout) NO se oculta nada; el backend rechaza por request y el dock
    /// se re-filtra al resolver el usuario.
    static func hasPhoneSectionAccess(user: RistakUser?, section: PhoneSection) -> Bool {
        guard let user else { return true }
        guard let module = sectionModule[section] else { return true }
        return hasModuleAccess(user: user, module: module, requiredLevel: .read)
    }
}

/// Store observable de permisos para las vistas. Lee el usuario de
/// `SessionStore` y aplica `RistakAccessRules`.
@MainActor
@Observable
final class AccessStore {
    private let session: SessionStore

    init(session: SessionStore) {
        self.session = session
    }

    var user: RistakUser? { session.user }

    /// Última instantánea CONOCIDA de capacidades del usuario (rol, `accessConfig`
    /// y `licenseFeatures`). En el arranque en frío proviene del usuario cacheado
    /// en Keychain (lo carga `SessionStore.bootstrap` ANTES de pintar el shell),
    /// así los tabs/secciones/botones gateados se pintan con su último estado
    /// conocido sin esperar al `verify`. Se revalida en cuanto llega el verify.
    ///
    /// Señales de capacidad ADICIONALES que no viven en el usuario (gateways de
    /// pago, integraciones, features de plan) se cachean por los VMs de features
    /// vía `RistakSnapshotCache.shared` con las llaves de `RistakCacheKey`
    /// (`paymentsGateways`, `integrations`, …): guárdalas al cargar y léelas con
    /// `value(_:for:)` al aparecer para no ocultar la función mientras carga.
    var lastKnownCapabilitiesUser: RistakUser? { session.user }

    /// Lee una señal de capacidad cacheada (p. ej. gateways de pago habilitados)
    /// para pintar la función con su último estado conocido antes de revalidar.
    func cachedCapability<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        RistakSnapshotCache.shared.value(type, for: key)
    }

    /// ¿Puede leer el módulo? Con usuario aún no resuelto (nil) → permitir
    /// (fail-open de carga; el backend manda por request).
    func canRead(module: RistakModuleKey) -> Bool {
        guard let user else { return true }
        return RistakAccessRules.hasModuleAccess(user: user, module: module, requiredLevel: .read)
    }

    /// ¿Puede escribir en el módulo? Con usuario nil → permitir (misma regla).
    func canWrite(module: RistakModuleKey) -> Bool {
        guard let user else { return true }
        return RistakAccessRules.hasModuleAccess(user: user, module: module, requiredLevel: .write)
    }

    func hasSectionAccess(_ section: PhoneSection) -> Bool {
        RistakAccessRules.hasPhoneSectionAccess(user: user, section: section)
    }

    /// Secciones visibles del shell en su orden canonico. Mientras el usuario
    /// aun no se resuelve se mantiene fail-open; con un usuario conocido que no
    /// tiene modulos, solo Ajustes queda visible para explicar/cerrar sesion.
    func visibleSections() -> [PhoneSection] {
        guard user != nil else { return PhoneSection.allCases }
        let allowed = PhoneSection.allCases.filter { hasSectionAccess($0) }
        return allowed.isEmpty ? [.settings] : allowed
    }
}
