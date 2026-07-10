import Foundation
import Observation

/// ViewModel de la ficha "Info del contacto" (doc 06).
/// - Carga rápida: `GET /contacts/:id` con `warmProfilePictures=false` +
///   `refreshExternalAppointments=false`, y refresco silencioso después
///   (patrón /movil, doc 06 §6.10).
/// - Toda mutación hace PUT y RE-FETCH (el PUT devuelve fila cruda snake_case
///   que NUNCA se decodifica — doc 06 §6.1).
/// - 409 `merge_confirmation_required`: solo TELÉFONO ofrece fusión
///   (`confirmMerge:true`); email muestra error plano (audit doc 06).
@MainActor
@Observable
final class ContactInfoViewModel {
    // MARK: Tipos

    enum Phase {
        case loading
        case loaded
        /// Error de carga inicial con reintento.
        case failed(message: String)
        /// 403 de módulo → estado "sin acceso" (no logout).
        case accessDenied(message: String)
        /// 404: contacto en papelera u oculto por filtros (doc 06 §6.13).
        case notFound
    }

    struct InfoAlert: Identifiable, Sendable {
        let id = UUID()
        let title: String
        let message: String
    }

    /// Confirmación previa al PUT de teléfono (copy /movil, doc 06 §4.1.6).
    struct PhoneChangeConfirmation: Identifiable, Sendable {
        let id = UUID()
        let newPhone: String
        let currentPhone: String
    }

    /// Diálogo de fusión tras 409 `merge_confirmation_required` (solo teléfono).
    struct MergePrompt: Identifiable, Sendable {
        let id = UUID()
        let newPhone: String
        let message: String
        /// Resumen del contacto en conflicto (nombre + teléfono si vinieron).
        let conflictSummary: String?
    }

    /// Fila combinada definición+valor para la sección de campos personalizados.
    struct CustomFieldRow: Identifiable, Sendable {
        let id: String
        let label: String
        let dataType: String
        let options: [ContactFieldOption]
        let definition: ContactCustomFieldDefinition?
        let value: ContactCustomFieldValue?
        let isEditable: Bool
    }

    // MARK: Estado observable

    let contactID: String

    private(set) var phase: Phase = .loading
    private(set) var contact: ContactDetail?
    /// Refresco silencioso en curso (pill "Actualizando datos").
    private(set) var isRefreshing = false

    private(set) var fieldDefinitions: [ContactCustomFieldDefinition] = []
    private(set) var definitionsLoadFailed = false
    private(set) var tagCatalog: [ContactTag] = []
    private(set) var tagCatalogLoaded = false
    private(set) var agentState: ConversationAgentState?
    private(set) var isAgentActionRunning = false

    private(set) var isSavingName = false
    private(set) var isSavingPhone = false
    private(set) var isSavingEmail = false
    private(set) var savingFieldID: String?
    private(set) var busyTagIDs: Set<String> = []

    var alert: InfoAlert?
    var phoneConfirmation: PhoneChangeConfirmation?
    var mergePrompt: MergePrompt?

    /// Trigger de háptico de éxito (`.sensoryFeedback`).
    private(set) var successFeedbackCount = 0

    // MARK: Viaje de cliente (journey COMPLETO, doc 04 §10 + doc 06 §4.1.7)

    private(set) var journeyEvents: [JourneyEvent] = []
    private(set) var journeyItems: [ContactJourneyItem] = []
    /// Multimedia/archivos compartidos derivados del journey completo
    /// (paridad `getContactArchiveItems`). Se construyen una sola vez al cargar.
    private(set) var archiveItems: [ContactArchiveItem] = []
    private(set) var journeyPhase: JourneyLoadPhase = .idle

    // MARK: Dependencias (Core)

    private let contacts = ContactsService()
    private let tags = TagsService()
    private let agent = AgentStateService()

    // MARK: Caché instantánea (Round 6 #4)

    /// Tope de eventos del journey que se guardan en caché (los más recientes).
    private static let maxJourneyCacheEvents = 200
    private var contactCacheHydrated = false
    private var journeyCacheHydrated = false
    /// La carga (revalidación) inicial corre una sola vez por pantalla.
    private var didStartLoad = false

    init(contactID: String) {
        self.contactID = contactID
        // Caché instantánea: hidrata el detalle ANTES del primer render para
        // abrir la ficha con el último dato sin flash de spinner. (El journey
        // se hidrata en `loadJourneyIfNeeded`, que ya trae los formatters.)
        hydrateContactFromCache()
    }

    // MARK: - Carga

    func loadIfNeeded() async {
        // Se revalida SIEMPRE una vez por pantalla, aunque la caché instantánea
        // ya haya pintado el detalle en `init` (si no, se quedaría en el dato
        // cacheado sin refrescar contra la red).
        guard !didStartLoad else { return }
        didStartLoad = true
        await load()
    }

    func load() async {
        // Caché instantánea (Round 6 #4): abre la ficha con el último detalle
        // guardado SIN spinner; el spinner solo aparece si no hay nada cacheado.
        hydrateContactFromCache()
        if contact == nil { phase = .loading }
        do {
            contact = try await fetchContactCaching(warmProfilePictures: false)
            phase = .loaded
        } catch {
            // Con caché presente conservamos lo pintado (SWR); sin caché, error.
            if contact == nil {
                applyLoadFailure(error)
                return
            }
            phase = .loaded
        }

        // Datos satélite en paralelo (silenciosos en carga, doc 13 §6).
        async let definitionsTask: Void = loadFieldDefinitions()
        async let catalogTask: Void = loadTagCatalog()
        async let agentTask: Void = loadAgentState()
        _ = await (definitionsTask, catalogTask, agentTask)

        // Refresco silencioso con fotos calientes (patrón /movil).
        await refreshSilently()
    }

    /// Pull-to-refresh y reintentos manuales.
    func refresh() async {
        if contact == nil {
            await load()
            return
        }
        await refreshSilently()
        await loadAgentState()
        if tagCatalog.isEmpty { await loadTagCatalog() }
        if fieldDefinitions.isEmpty { await loadFieldDefinitions() }
    }

    private func refreshSilently() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            contact = try await fetchContactCaching(warmProfilePictures: true)
            phase = .loaded
        } catch {
            // Silencioso: se conserva lo ya pintado. Si no había nada, cae al
            // estado de error normal.
            if contact == nil {
                applyLoadFailure(error)
            }
        }
    }

    /// `GET /contacts/:id` crudo: decodifica el detalle con la misma regla de
    /// envelope que la tubería viva y GUARDA el `Data` crudo en la caché
    /// instantánea (para abrir la ficha al instante la próxima vez). Evita
    /// conformar `Encodable` en el modelo de Core.
    private func fetchContactCaching(warmProfilePictures: Bool) async throws -> ContactDetail {
        let data = try await APIClient.shared.rawData(
            "/contacts/\(contactID)",
            query: [
                "warmProfilePictures": warmProfilePictures ? nil : "false",
                "refreshExternalAppointments": "false",
            ]
        )
        guard let detail = ChatSnapshotDecoding.decode(ContactDetail.self, from: data) else {
            throw RistakAPIError.invalidResponse
        }
        RistakSnapshotCache.shared.storeRaw(data, for: ChatSnapshotKey.contactDetail(contactID))
        return detail
    }

    /// Hidrata el detalle desde la caché instantánea (una sola vez).
    private func hydrateContactFromCache() {
        guard !contactCacheHydrated else { return }
        contactCacheHydrated = true
        guard contact == nil,
              let data = RistakSnapshotCache.shared.rawData(for: ChatSnapshotKey.contactDetail(contactID)),
              let cached = ChatSnapshotDecoding.decode(ContactDetail.self, from: data) else { return }
        contact = cached
        phase = .loaded
    }

    private func applyLoadFailure(_ error: Error) {
        guard let apiError = error as? RistakAPIError else {
            phase = .failed(message: "No se pudo cargar el contacto.")
            return
        }
        switch apiError.kind {
        case .notFound:
            phase = .notFound
        case .accessDenied, .featureUnavailable:
            phase = .accessDenied(message: apiError.message)
        default:
            phase = .failed(message: apiError.message)
        }
    }

    private func loadFieldDefinitions() async {
        do {
            let all = try await contacts.fetchCustomFieldDefinitions(includeArchived: false)
            fieldDefinitions = all.filter { !$0.system && !$0.systemManaged && !$0.archived }
            definitionsLoadFailed = false
        } catch {
            definitionsLoadFailed = fieldDefinitions.isEmpty
        }
    }

    private func loadTagCatalog() async {
        do {
            tagCatalog = try await tags.fetchTags()
            tagCatalogLoaded = true
        } catch {
            tagCatalogLoaded = tagCatalogLoaded || !tagCatalog.isEmpty
        }
    }

    private func loadAgentState() async {
        // 403 de feature/módulo es silencioso en cargas: sin agente no hay panel.
        agentState = try? await agent.fetchPrimaryState(contactId: contactID)
    }

    // MARK: - Viaje de cliente (journey completo)

    /// Carga el journey COMPLETO (sin filtrar) una sola vez y construye los
    /// hitos con la zona/moneda del negocio. Si el task se cancela (cambio de
    /// tab/pantalla) queda en `.idle` para reintentar al reaparecer, nunca en
    /// un estado "vacío falso".
    func loadJourneyIfNeeded(formatters: BusinessFormatters) async {
        guard journeyPhase == .idle || journeyPhase == .failed else {
            // Ya cargado: solo re-formatea por si cambió la zona horaria.
            if journeyPhase == .loaded { rebuildJourney(formatters: formatters) }
            return
        }
        // Caché instantánea (Round 6 #4): construye los hitos con los últimos
        // eventos guardados antes de revalidar (sin quedarse en spinner si ya
        // hay algo que pintar).
        hydrateJourneyFromCache(formatters: formatters)
        if journeyPhase != .loaded { journeyPhase = .loading }
        do {
            let data = try await APIClient.shared.rawData(
                "/contacts/\(contactID)/journey",
                query: [
                    "includeBusinessMessages": "true",
                    "refreshExternalStatuses": "false",
                ]
            )
            guard let events = ChatSnapshotDecoding.decode([JourneyEvent].self, from: data) else {
                throw RistakAPIError.invalidResponse
            }
            persistJourneyCache(from: data)
            // La construcción de los hitos (merge por día/canal) y del archivo
            // (reconstruir mensajes + parsear adjuntos/enlaces) es CPU-intensiva
            // y corría en el main actor: eso bloqueaba el primer render de la
            // ficha y causaba el "tirón" al abrir. La movemos a una tarea
            // detached; solo el assign de resultados vuelve al main. (doc 06 §6.10)
            let contactID = self.contactID
            let built = await Task.detached(priority: .userInitiated) {
                () -> (items: [ContactJourneyItem], archive: [ContactArchiveItem]) in
                let items = ContactJourneyBuilder(formatters: formatters).items(from: events)
                let archive = ContactArchiveBuilder.items(contactID: contactID, events: events)
                return (items, archive)
            }.value
            journeyEvents = events
            journeyItems = built.items
            archiveItems = built.archive
            journeyPhase = .loaded
        } catch {
            // SWR: con eventos ya pintados (caché o carga previa) nunca lo
            // dejamos en blanco/falla; solo caemos a .failed/.idle sin datos.
            if Self.isCancellation(error) {
                journeyPhase = journeyEvents.isEmpty ? .idle : .loaded
            } else {
                journeyPhase = journeyEvents.isEmpty ? .failed : .loaded
            }
        }
    }

    /// Hidrata el journey desde la caché instantánea (una sola vez). Construye
    /// los hitos síncronos desde ≤`maxJourneyCacheEvents` eventos (barato).
    private func hydrateJourneyFromCache(formatters: BusinessFormatters) {
        guard !journeyCacheHydrated else { return }
        journeyCacheHydrated = true
        guard journeyEvents.isEmpty,
              let data = RistakSnapshotCache.shared.rawData(for: ChatSnapshotKey.contactJourney(contactID)),
              let events = ChatSnapshotDecoding.decode([JourneyEvent].self, from: data),
              !events.isEmpty else { return }
        journeyEvents = events
        journeyItems = ContactJourneyBuilder(formatters: formatters).items(from: events)
        archiveItems = ContactArchiveBuilder.items(contactID: contactID, events: events)
        journeyPhase = .loaded
    }

    /// Guarda los últimos N eventos del journey (recorta el array crudo como
    /// `[RistakJSONValue]` para no inflar el disco). Se re-decodifica idéntico
    /// a `[JourneyEvent]` al hidratar.
    private func persistJourneyCache(from data: Data) {
        guard let jsonArray = ChatSnapshotDecoding.decode([RistakJSONValue].self, from: data) else { return }
        let capped = Array(jsonArray.suffix(Self.maxJourneyCacheEvents))
        guard let cappedData = try? JSONEncoder().encode(capped) else { return }
        RistakSnapshotCache.shared.storeRaw(cappedData, for: ChatSnapshotKey.contactJourney(contactID))
    }

    /// Reintento manual del journey (botón del panel).
    func retryJourney(formatters: BusinessFormatters) async {
        journeyPhase = .idle
        await loadJourneyIfNeeded(formatters: formatters)
    }

    /// Reconstruye los hitos ya cargados con nuevos formateadores (cambio de
    /// zona horaria del negocio) sin volver a pegarle al backend.
    func rebuildJourney(formatters: BusinessFormatters) {
        guard !journeyEvents.isEmpty else { return }
        journeyItems = ContactJourneyBuilder(formatters: formatters).items(from: journeyEvents)
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let api = error as? RistakAPIError,
           api.kind == .network,
           let urlError = api.underlying as? URLError,
           urlError.code == .cancelled {
            return true
        }
        return false
    }

    // MARK: - Nombre (PUT {full_name}, doc 06 §4.1.2)

    @discardableResult
    func saveName(_ rawName: String) async -> Bool {
        let newName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !newName.isEmpty, newName != contact?.name else { return false }
        isSavingName = true
        defer { isSavingName = false }
        do {
            contact = try await contacts.updateContact(
                id: contactID,
                with: ContactUpdateRequest(fullName: newName)
            )
            registerSuccess()
            return true
        } catch {
            alert = InfoAlert(title: "No se guardó el nombre", message: friendlyMessage(error))
            return false
        }
    }

    // MARK: - Teléfono (validación + confirmación + fusión, doc 06 §4.1.6 y §6.3)

    /// Paso 1: valida y pide confirmación. Devuelve `true` si avanzó al diálogo.
    func requestPhoneChange(_ rawPhone: String) -> Bool {
        guard let normalized = ContactInfoPhoneValidation.normalized(rawPhone) else {
            alert = InfoAlert(
                title: ContactInfoPhoneValidation.invalidTitle,
                message: ContactInfoPhoneValidation.invalidMessage
            )
            return false
        }
        guard normalized != contact?.phone else { return false }
        phoneConfirmation = PhoneChangeConfirmation(
            newPhone: normalized,
            currentPhone: contact?.phone ?? ""
        )
        return true
    }

    /// Paso 2: PUT sin `confirmMerge`. Un 409 de fusión abre `mergePrompt`.
    func confirmPhoneChange(_ confirmation: PhoneChangeConfirmation) async {
        await performPhoneUpdate(phone: confirmation.newPhone, confirmMerge: false)
    }

    /// Paso 3 (opcional): reintento con `confirmMerge:true` — SOLO teléfono
    /// fusiona de verdad (audit doc 06).
    func confirmMerge(_ prompt: MergePrompt) async {
        await performPhoneUpdate(phone: prompt.newPhone, confirmMerge: true)
    }

    private func performPhoneUpdate(phone: String, confirmMerge: Bool) async {
        isSavingPhone = true
        defer { isSavingPhone = false }
        do {
            // PUT directo vía APIClient para conservar el `rawBody` del 409
            // (ContactsService tipa el conflicto pero pierde el objeto
            // `conflict`; aquí lo necesitamos para pintar el contacto en
            // choque — doc 06 §6.3). El body de respuesta se ignora SIEMPRE.
            let _: RistakJSONValue = try await APIClient.shared.put(
                "/contacts/\(contactID)",
                body: ContactUpdateRequest(phone: phone, confirmMerge: confirmMerge ? true : nil)
            )
            contact = try await contacts.fetchContact(id: contactID, warmProfilePictures: false)
            registerSuccess()
        } catch let apiError as RistakAPIError {
            handlePhoneUpdateError(apiError, phone: phone)
        } catch {
            alert = InfoAlert(title: "No se guardó el número", message: friendlyMessage(error))
        }
    }

    private func handlePhoneUpdateError(_ error: RistakAPIError, phone: String) {
        guard error.status == 409 else {
            alert = InfoAlert(title: "No se guardó el número", message: error.message)
            return
        }

        let payload = error.decodeRawBody(ContactInfoConflictPayload.self)
        let field = payload?.conflict?.field?.lowercased() ?? "phone"

        if error.code == "merge_confirmation_required", field == "phone" {
            mergePrompt = MergePrompt(
                newPhone: phone,
                message: error.message,
                conflictSummary: Self.conflictSummary(payload?.conflict?.contact)
            )
            return
        }

        // `duplicate_email` o conflicto de email: sin fusión real (audit doc 06).
        alert = InfoAlert(title: "No se guardó el número", message: error.message)
    }

    private static func conflictSummary(_ contact: ContactInfoConflictPayload.ConflictContact?) -> String? {
        guard let contact else { return nil }
        var parts: [String] = []
        if let name = contact.fullName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            parts.append(name)
        }
        if let phone = contact.phone?.trimmingCharacters(in: .whitespacesAndNewlines), !phone.isEmpty {
            parts.append(phone)
        }
        if parts.isEmpty, let email = contact.email?.trimmingCharacters(in: .whitespacesAndNewlines), !email.isEmpty {
            parts.append(email)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: - Correo (PUT {email}; conflictos SIN oferta de fusión)

    @discardableResult
    func saveEmail(_ rawEmail: String) async -> Bool {
        let newEmail = rawEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard newEmail != (contact?.email ?? "").lowercased() else { return false }
        if !newEmail.isEmpty, !Self.isValidEmail(newEmail) {
            alert = InfoAlert(title: "Correo inválido", message: "Revisa que el correo esté bien escrito.")
            return false
        }
        isSavingEmail = true
        defer { isSavingEmail = false }
        do {
            contact = try await contacts.updateContact(
                id: contactID,
                with: ContactUpdateRequest(email: newEmail)
            )
            registerSuccess()
            return true
        } catch let conflict as ContactUpdateConflict {
            // Email NO fusiona: mostrar el mensaje del backend y sugerir otro
            // correo (audit doc 06 §5.5).
            alert = InfoAlert(title: "No se guardó el correo", message: conflict.errorDescription ?? "El correo ya pertenece a otro contacto. Usa uno distinto.")
            return false
        } catch {
            alert = InfoAlert(title: "No se guardó el correo", message: friendlyMessage(error))
            return false
        }
    }

    static func isValidEmail(_ value: String) -> Bool {
        let pattern = #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#
        return value.range(of: pattern, options: .regularExpression) != nil
    }

    // MARK: - Campos personalizados (doc 06 §4.1.10)

    var customFieldRows: [CustomFieldRow] {
        let values = contact?.customFields ?? []
        var consumed = Set<Int>()

        func matchValue(for definition: ContactCustomFieldDefinition) -> ContactCustomFieldValue? {
            for (index, value) in values.enumerated() where !consumed.contains(index) {
                if Self.matches(definition: definition, value: value) {
                    consumed.insert(index)
                    return value
                }
            }
            return nil
        }

        var rows: [CustomFieldRow] = fieldDefinitions.map { definition in
            let value = matchValue(for: definition)
            return CustomFieldRow(
                id: definition.id,
                label: definition.label.isEmpty ? definition.key : definition.label,
                dataType: definition.dataType,
                options: definition.options.isEmpty ? (value?.options ?? []) : definition.options,
                definition: definition,
                value: value,
                isEditable: true
            )
        }

        // Valores huérfanos (sin definición visible): solo lectura.
        for (index, value) in values.enumerated() where !consumed.contains(index) {
            let label = value.label.isEmpty ? (value.name.isEmpty ? value.key : value.name) : value.label
            guard !label.isEmpty else { continue }
            rows.append(
                CustomFieldRow(
                    id: value.definitionId.isEmpty ? "orphan-\(value.key.isEmpty ? String(index) : value.key)" : value.definitionId,
                    label: label,
                    dataType: ContactCustomFieldDefinition.normalizeDataType(value.dataType),
                    options: value.options,
                    definition: nil,
                    value: value,
                    isEditable: false
                )
            )
        }

        // El "Nombre del negocio" (business_name) es un dato del sistema; nunca
        // se muestra como campo personalizado del contacto.
        return rows.filter { !Self.isHiddenSystemField($0) }
    }

    /// Oculta el campo `business_name` / "Nombre del negocio" de la lista de
    /// campos personalizados (dato del negocio, no del contacto).
    ///
    /// El campo puede llegar de formas distintas según su origen: con clave
    /// `business_name`/`business.name`, con label "Nombre del negocio", o como
    /// valor huérfano cuya única señal es el `name`/`label` crudo (`business_name`
    /// sin clave). Por eso normalizamos TODAS las señales (clave, fieldKey, label
    /// y name — tanto de la definición como del valor) quitando mayúsculas,
    /// espacios, guiones bajos y cualquier símbolo, y las comparamos contra las
    /// variantes conocidas. Así se cubre cualquier combinación sin depender de
    /// una coincidencia exacta con espacios.
    private static func isHiddenSystemField(_ row: CustomFieldRow) -> Bool {
        // Variantes normalizadas que identifican al "Nombre del negocio".
        let hiddenTokens: Set<String> = ["businessname", "nombredelnegocio", "nombredenegocio"]
        let tokens = [
            row.definition?.key,
            row.definition?.fieldKey,
            row.definition?.label,
            row.definition?.name,
            row.value?.key,
            row.value?.fieldKey,
            row.value?.label,
            row.value?.name,
            row.label,
        ]
        .compactMap { normalizedFieldToken($0) }
        return tokens.contains { hiddenTokens.contains($0) }
    }

    /// Normaliza una señal de campo (clave/label/name) a minúsculas sin espacios,
    /// guiones bajos ni ningún carácter no alfanumérico. `nil` si queda vacío.
    private static func normalizedFieldToken(_ value: String?) -> String? {
        guard let value else { return nil }
        let token = value
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]", with: "", options: .regularExpression)
        return token.isEmpty ? nil : token
    }

    private static func matches(definition: ContactCustomFieldDefinition, value: ContactCustomFieldValue) -> Bool {
        if !definition.definitionId.isEmpty, definition.definitionId == value.definitionId { return true }
        let defKeys = [definition.key, definition.fieldKey].map { $0.lowercased() }.filter { !$0.isEmpty }
        let valueKeys = [value.key, value.fieldKey].map { $0.lowercased() }.filter { !$0.isEmpty }
        if !defKeys.isEmpty, !valueKeys.isEmpty, defKeys.contains(where: valueKeys.contains) { return true }
        if valueKeys.isEmpty, defKeys.isEmpty {
            let defLabel = definition.label.lowercased()
            let valueLabel = value.label.lowercased()
            return !defLabel.isEmpty && defLabel == valueLabel
        }
        return false
    }

    /// Guarda un valor de campo personalizado (`PUT {customFields:[...]}`).
    /// Devuelve `nil` en éxito o el mensaje de error (el editor lo pinta
    /// inline — un alert de la pantalla no se ve bajo la sheet).
    func saveCustomField(row: CustomFieldRow, newValue: RistakJSONValue) async -> String? {
        guard let definition = row.definition else { return "Este campo es de solo lectura." }
        savingFieldID = row.id
        defer { savingFieldID = nil }
        do {
            contact = try await contacts.updateCustomFields(
                contactId: contactID,
                fields: [
                    ContactCustomFieldWrite(
                        definitionId: definition.definitionId.isEmpty ? nil : definition.definitionId,
                        key: definition.key,
                        fieldKey: definition.fieldKey,
                        label: definition.label,
                        dataType: definition.dataType,
                        value: newValue
                    ),
                ]
            )
            registerSuccess()
            return nil
        } catch {
            return friendlyMessage(error)
        }
    }

    // MARK: - Etiquetas (doc 06 §4.1 etiquetas + §2.3)

    /// Etiquetas de usuario del contacto resueltas contra el catálogo.
    var contactTags: [ContactTag] {
        let ids = contact?.tags ?? []
        var byID: [String: ContactTag] = [:]
        for tag in tagCatalog {
            byID[tag.id] = tag
        }
        return ids.compactMap { id in
            if let tag = byID[id] { return tag }
            // Id sin catálogo cargado aún: no inventar nombre.
            return nil
        }
    }

    func contactHasTag(_ tag: ContactTag) -> Bool {
        contact?.tags.contains(tag.id) ?? false
    }

    /// Resultado de acciones de etiqueta lanzadas desde la sheet (los mensajes
    /// se pintan inline en la sheet, no como alert de la pantalla).
    enum TagActionResult: Sendable {
        case added
        case alreadyAdded
        case failed(String)
    }

    /// Agrega una etiqueta existente (bulk con UN contacto, doc 06 §2.3).
    func addTag(_ tag: ContactTag) async -> TagActionResult {
        if contactHasTag(tag) { return .alreadyAdded }
        busyTagIDs.insert(tag.id)
        defer { busyTagIDs.remove(tag.id) }
        do {
            try await tags.addTag(tag.id, toContact: contactID)
            await reloadContactQuietly()
            registerSuccess()
            return .added
        } catch {
            return .failed(friendlyMessage(error))
        }
    }

    /// Crea la etiqueta y la agrega al chat (`POST /contact-tags` + bulk add).
    func createAndAddTag(named rawName: String) async -> TagActionResult {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return .failed("Escribe un nombre para la etiqueta.") }
        do {
            let created = try await tags.createTag(name: name)
            if !tagCatalog.contains(where: { $0.id == created.id }) {
                tagCatalog.append(created)
                tagCatalog.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            }
            return await addTag(created)
        } catch {
            return .failed(friendlyMessage(error))
        }
    }

    /// Quita la etiqueta del contacto (bulk `removeTagIds`; el catálogo no se toca).
    func removeTag(_ tag: ContactTag) async {
        busyTagIDs.insert(tag.id)
        defer { busyTagIDs.remove(tag.id) }
        do {
            try await tags.bulkUpdateTags(contactIds: [contactID], removeTagIds: [tag.id])
            await reloadContactQuietly()
            registerSuccess()
        } catch {
            alert = InfoAlert(title: "No se quitó la etiqueta", message: friendlyMessage(error))
        }
    }

    private func reloadContactQuietly() async {
        if let fresh = try? await fetchContactCaching(warmProfilePictures: false) {
            contact = fresh
        }
    }

    // MARK: - Agente conversacional (copy doc 03 §4.4)

    var agentPanelVisible: Bool {
        // Solo si el estado corresponde a un agente asignado que aún existe: un
        // estado legado (agentId nulo) o de un agente borrado es historial, no
        // un agente controlable — no debe abrir el panel de acciones.
        guard let agentState, agentState.isAssignedExistingAgent else { return false }
        return !agentState.status.isEmpty
    }

    func agentPause() async {
        // "Detiene el agente durante 24 horas."
        let until = RistakDateParsing.isoString(from: Date().addingTimeInterval(24 * 3600))
        await runAgentAction(.pause, pausedUntilAt: until)
    }

    func agentResume() async {
        await runAgentAction(.resume)
    }

    func agentTakeOver() async {
        await runAgentAction(.takeOver)
    }

    func agentSkip() async {
        await runAgentAction(.skip)
    }

    private func runAgentAction(_ action: ConversationAgentAction, pausedUntilAt: String? = nil) async {
        guard !isAgentActionRunning else { return }
        isAgentActionRunning = true
        defer { isAgentActionRunning = false }
        do {
            agentState = try await agent.updateState(
                contactId: contactID,
                action: action,
                agentId: agentState?.agentId,
                pausedUntilAt: pausedUntilAt
            )
            registerSuccess()
        } catch {
            alert = InfoAlert(title: "Agente conversacional", message: friendlyMessage(error))
            await loadAgentState()
        }
    }

    // MARK: - Métricas derivadas

    var activeAppointmentsCount: Int {
        (contact?.appointments ?? []).filter { ContactInfoAppointmentStatus.isActive($0.status) }.count
    }

    var receivedPayments: [ContactEmbeddedPayment] {
        (contact?.payments ?? []).filter {
            ContactInfoPaymentStatus.receivedStatuses.contains(ContactInfoPaymentStatus.normalized($0.status))
        }
    }

    /// Próxima cita futura no cancelada (usa `nextAppointmentDate` del backend).
    var nextAppointment: ContactEmbeddedAppointment? {
        guard let next = contact?.nextAppointmentDate,
              let nextDate = RistakDateParsing.date(fromISO: next) else { return nil }
        return (contact?.appointments ?? []).first {
            guard ContactInfoAppointmentStatus.isActive($0.status),
                  let start = RistakDateParsing.date(fromISO: $0.startTime) else { return false }
            return abs(start.timeIntervalSince(nextDate)) < 60
        } ?? nil
    }

    // MARK: - Utilidades

    private func registerSuccess() {
        successFeedbackCount += 1
    }

    private func friendlyMessage(_ error: Error) -> String {
        if let apiError = error as? RistakAPIError { return apiError.message }
        if let conflict = error as? ContactUpdateConflict { return conflict.errorDescription ?? "Conflicto al guardar." }
        return "No se pudo completar la operación. Intenta de nuevo."
    }
}
