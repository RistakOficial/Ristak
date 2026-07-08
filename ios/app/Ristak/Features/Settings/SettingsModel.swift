import Foundation
import Observation

// MARK: - Estado de carga por sección

/// Estado de carga de cada bloque de datos de Ajustes (paridad `SectionState`
/// de la app RN): spinner / error con reintento / contenido. Los 403 de
/// módulo (`accessDenied`) y de licencia (`featureUnavailable`) se muestran
/// como estados dedicados, nunca como alerta en cargas (doc 13 §8).
enum SettingsLoadState<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case accessDenied(message: String)
    case featureBlocked(message: String)
    case failed(message: String)

    var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }

    var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }
}

// MARK: - Paneles

/// Paneles de Ajustes (orden exacto de la lista RN, doc 10 §5.1).
enum SettingsPanel: String, CaseIterable, Identifiable, Hashable, Sendable {
    case numbers
    case templates
    case agent
    case chats
    case customFields = "custom-fields"
    case appearance
    case privacy
    case notifications

    var id: String { rawValue }

    var title: String {
        switch self {
        case .numbers: return "Números de WhatsApp"
        case .templates: return "Plantillas"
        case .agent: return "Asistente Personal AI"
        case .chats: return "Lista de chat"
        case .customFields: return "Campos personalizados"
        case .appearance: return "Apariencia"
        case .privacy: return "Privacidad"
        case .notifications: return "Notificaciones"
        }
    }

    var subtitle: String {
        switch self {
        case .numbers: return "Principal y bandejas por remitente."
        case .templates: return "Crear y revisar estados de Meta."
        case .agent: return "Chat fijo y sugerencias."
        case .chats: return "Orden, archivados y vista previa."
        case .customFields: return "Datos visibles en cada contacto."
        case .appearance: return "Claro, noche, sistema u horario."
        case .privacy: return "Controla vistos de WhatsApp, Messenger e Instagram."
        case .notifications: return "Mensajes, citas, sonido y vibración."
        }
    }

    var systemImage: String {
        switch self {
        case .numbers: return "iphone"
        case .templates: return "doc.text"
        case .agent: return "sparkles"
        case .chats: return "bubble.left"
        case .customFields: return "checklist"
        case .appearance: return "sun.max"
        case .privacy: return "checkmark.bubble"
        case .notifications: return "bell.fill"
        }
    }
}

// MARK: - Modelo compartido del módulo

/// Modelo del módulo Ajustes: carga en paralelo el estado de WhatsApp,
/// plantillas, agente AI, calendarios y campos personalizados (paridad con la
/// carga inicial de la pestaña Ajustes RN, doc 10 §5.1). Las preferencias
/// (`app_config` / `user_config`) viven en `AppConfigStore` (Environment).
@MainActor
@Observable
final class SettingsModel {
    // MARK: Secciones

    private(set) var whatsapp: SettingsLoadState<WhatsAppAPIStatus> = .idle
    private(set) var templates: SettingsLoadState<WhatsAppTemplatesSummary> = .idle
    private(set) var agent: SettingsLoadState<AIAgentConfigStatus> = .idle
    private(set) var calendars: SettingsLoadState<[RistakCalendar]> = .idle
    private(set) var customFields: SettingsLoadState<[ContactCustomFieldDefinition]> = .idle

    /// Hay un `POST /whatsapp-api/refresh` en curso.
    private(set) var isRefreshingWhatsApp = false
    /// Id del número con «Hacer principal» en curso.
    private(set) var settingDefaultPhoneID: String?

    private var didLoadOnce = false
    private let contactsService = ContactsService()
    private let templatesService = TemplatesService()

    init() {}

    // MARK: - Carga

    /// Carga inicial (una sola vez); el pull-to-refresh usa `reloadAll()`.
    func loadIfNeeded() async {
        guard !didLoadOnce else { return }
        didLoadOnce = true
        await reloadAll()
    }

    /// Recarga todas las secciones en paralelo.
    func reloadAll() async {
        async let whatsappTask: Void = loadWhatsApp()
        async let templatesTask: Void = loadTemplates()
        async let agentTask: Void = loadAgent()
        async let calendarsTask: Void = loadCalendars()
        async let fieldsTask: Void = loadCustomFields()
        _ = await (whatsappTask, templatesTask, agentTask, calendarsTask, fieldsTask)
    }

    func loadWhatsApp() async {
        if whatsapp.value == nil { whatsapp = .loading }
        do {
            whatsapp = .loaded(try await WhatsAppNumbersService.status())
        } catch {
            whatsapp = Self.failureState(from: error, keeping: whatsapp)
        }
    }

    func loadTemplates() async {
        if templates.value == nil { templates = .loading }
        do {
            // Sin `status` (todas) — paridad RN; el servicio ya trae el
            // fallback al snapshot de `/status` (doc 10 §4.10).
            templates = .loaded(try await templatesService.fetchTemplates())
        } catch {
            templates = Self.failureState(from: error, keeping: templates)
        }
    }

    func loadAgent() async {
        if agent.value == nil { agent = .loading }
        do {
            agent = .loaded(try await AIAgentService.config())
        } catch {
            agent = Self.failureState(from: error, keeping: agent)
        }
    }

    func loadCalendars() async {
        if calendars.value == nil { calendars = .loading }
        do {
            let all = try await CalendarsService.calendars()
            calendars = .loaded(all.filter { $0.isActive })
        } catch {
            calendars = Self.failureState(from: error, keeping: calendars)
        }
    }

    func loadCustomFields() async {
        if customFields.value == nil { customFields = .loading }
        do {
            let all = try await contactsService.fetchCustomFieldDefinitions(includeArchived: true)
            customFields = .loaded(all.filter { !$0.archived })
        } catch {
            customFields = Self.failureState(from: error, keeping: customFields)
        }
    }

    // MARK: - Acciones WhatsApp

    /// `POST /whatsapp-api/refresh`. Si falla, conserva el status previo
    /// (doc 10 gap 9) y devuelve el mensaje de error para la alerta.
    func refreshWhatsApp() async -> String? {
        guard !isRefreshingWhatsApp else { return nil }
        isRefreshingWhatsApp = true
        defer { isRefreshingWhatsApp = false }
        do {
            whatsapp = .loaded(try await WhatsAppNumbersService.refresh())
            return nil
        } catch let error as RistakAPIError {
            return error.message
        } catch {
            return "No se pudo actualizar el estado de WhatsApp."
        }
    }

    /// «Hacer principal»: el backend responde el status completo → reemplaza.
    func setDefaultPhoneNumber(id: String) async -> String? {
        guard settingDefaultPhoneID == nil else { return nil }
        settingDefaultPhoneID = id
        defer { settingDefaultPhoneID = nil }
        do {
            whatsapp = .loaded(try await WhatsAppNumbersService.setDefaultPhoneNumber(id: id))
            return nil
        } catch let error as RistakAPIError {
            return error.message
        } catch {
            return "No se pudo cambiar el número principal."
        }
    }

    // MARK: - Agente AI

    /// Reemplaza el estado del agente (tras conectar OpenAI o guardar contexto).
    func applyAgentStatus(_ status: AIAgentConfigStatus) {
        agent = .loaded(status)
    }

    // MARK: - Metas de la lista principal (doc 10 §5.1)

    var numbersMeta: String {
        guard let status = whatsapp.value else { return "Revisar" }
        let count = status.phoneNumbers.count
        return count > 0 ? "\(count)" : "Revisar"
    }

    var templatesMeta: String {
        guard let summary = templates.value, summary.total > 0 else { return "Revisar" }
        return "\(summary.total) guardadas"
    }

    /// Meta del agente: «Activo» / «Apagado» / «Sin OpenAI».
    func agentMeta(chatEnabled: Bool) -> String {
        guard let status = agent.value else { return "Sin OpenAI" }
        guard status.isReady else { return "Sin OpenAI" }
        return chatEnabled ? "Activo" : "Apagado"
    }

    var customFieldsMeta: String {
        guard let fields = customFields.value, !fields.isEmpty else { return "Todos" }
        return "\(fields.count)"
    }

    // MARK: - Helpers

    private static func failureState<Value>(
        from error: any Error,
        keeping current: SettingsLoadState<Value>
    ) -> SettingsLoadState<Value> {
        // Con datos previos, un fallo de recarga no borra el contenido.
        if let value = current.value { return .loaded(value) }

        guard let apiError = error as? RistakAPIError else {
            return .failed(message: "Algo salió mal. Intenta otra vez.")
        }
        switch apiError.kind {
        case .accessDenied, .adminRequired:
            return .accessDenied(message: apiError.message)
        case .featureUnavailable:
            // Silencioso en cargas: estado dedicado, sin alerta (doc 13 §6.2).
            return .featureBlocked(message: apiError.message)
        default:
            return .failed(message: apiError.message)
        }
    }
}
