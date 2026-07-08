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

    // MARK: Dependencias (Core)

    private let contacts = ContactsService()
    private let tags = TagsService()
    private let agent = AgentStateService()

    init(contactID: String) {
        self.contactID = contactID
    }

    // MARK: - Carga

    func loadIfNeeded() async {
        guard contact == nil else { return }
        await load()
    }

    func load() async {
        phase = .loading
        do {
            let detail = try await contacts.fetchContact(
                id: contactID,
                warmProfilePictures: false,
                refreshExternalAppointments: false
            )
            contact = detail
            phase = .loaded
        } catch {
            applyLoadFailure(error)
            return
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
            contact = try await contacts.fetchContact(
                id: contactID,
                warmProfilePictures: true,
                refreshExternalAppointments: false
            )
            phase = .loaded
        } catch {
            // Silencioso: se conserva lo ya pintado. Si no había nada, cae al
            // estado de error normal.
            if contact == nil {
                applyLoadFailure(error)
            }
        }
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

        return rows
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
        if let fresh = try? await contacts.fetchContact(id: contactID, warmProfilePictures: false) {
            contact = fresh
        }
    }

    // MARK: - Agente conversacional (copy doc 03 §4.4)

    var agentPanelVisible: Bool {
        guard let agentState else { return false }
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
