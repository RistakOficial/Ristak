import Foundation

/// Error tipado de actualización de contacto (doc 06 §2.1 y audit):
/// - `mergeConfirmationRequired`: 409 `merge_confirmation_required` — el
///   teléfono/correo ya pertenece a otro contacto. SOLO teléfono fusiona de
///   verdad al reintentar con `confirmMerge:true`; email NO tiene fusión real
///   (terminará en `duplicate_email`) — ofrecer "usar otro correo".
/// - `duplicateEmail`: 409 `duplicate_email`.
enum ContactUpdateConflict: LocalizedError, Sendable {
    case mergeConfirmationRequired(message: String)
    case duplicateEmail(message: String)

    var errorDescription: String? {
        switch self {
        case .mergeConfirmationRequired(let message), .duplicateEmail(let message):
            return message
        }
    }
}

/// Contactos (`/api/contacts/*`, doc 06). NOTA de ocultos: un contacto bajo
/// filtro de hidden-contacts responde 404 en el detalle aunque estuviera en
/// caché — tratar 404 como "contacto no disponible", no como bug.
struct ContactsService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    // MARK: Detalle

    /// `GET /api/contacts/:id` (forma mapeada, doc 06 §1.1). Para primera
    /// pintura rápida usar `refreshExternalAppointments=false` +
    /// `warmProfilePictures=false` y refrescar después (patrón /movil).
    func fetchContact(
        id: String,
        warmProfilePictures: Bool = true,
        refreshExternalAppointments: Bool = false
    ) async throws -> ContactDetail {
        try await client.get(
            "/contacts/\(id)",
            query: [
                "warmProfilePictures": warmProfilePictures ? nil : "false",
                "refreshExternalAppointments": refreshExternalAppointments ? nil : "false",
            ]
        )
    }

    // MARK: Actualización

    /// `PUT /api/contacts/:id`. ⚠️ El PUT devuelve la fila CRUDA snake_case
    /// (≠ GET); por contrato del doc se ignora el body y se RE-FETCHEA el
    /// contacto mapeado. Lanza `ContactUpdateConflict` en los 409 tipados.
    @discardableResult
    func updateContact(id: String, with request: ContactUpdateRequest) async throws -> ContactDetail {
        do {
            let _: RistakJSONValue = try await client.put("/contacts/\(id)", body: request)
        } catch let error as RistakAPIError {
            switch error.code {
            case "merge_confirmation_required":
                throw ContactUpdateConflict.mergeConfirmationRequired(message: error.message)
            case "duplicate_email":
                throw ContactUpdateConflict.duplicateEmail(message: error.message)
            default:
                throw error
            }
        }
        return try await fetchContact(id: id, warmProfilePictures: false)
    }

    /// Reintento de cambio de teléfono con fusión confirmada
    /// (`confirmMerge:true`). SOLO para conflictos de TELÉFONO (audit doc 06:
    /// no existe fusión por email).
    @discardableResult
    func confirmMergePhone(
        id: String,
        phone: String,
        routingSource: String? = nil,
        routingReason: String? = nil
    ) async throws -> ContactDetail {
        try await updateContact(
            id: id,
            with: ContactUpdateRequest(
                phone: phone,
                routingSource: routingSource,
                routingReason: routingReason,
                confirmMerge: true
            )
        )
    }

    /// Fija el número de negocio "Contactando desde" para este chat
    /// (`""` limpia el número fijado).
    @discardableResult
    func setPreferredWhatsAppPhoneNumber(
        contactId: String,
        phoneNumberId: String,
        routingReason: String? = nil
    ) async throws -> ContactDetail {
        try await updateContact(
            id: contactId,
            with: ContactUpdateRequest(
                preferredWhatsAppPhoneNumberId: phoneNumberId,
                routingSource: "manual",
                routingReason: routingReason
            )
        )
    }

    // MARK: Crear / buscar

    /// `POST /api/contacts` — 409 con mensaje español listo si hay duplicado.
    func createContact(_ request: ContactCreateRequest) async throws -> ChatContact {
        try await client.post("/contacts", body: request)
    }

    /// `GET /api/contacts/search?q=` — máx 20, rankeados; sin `q` el backend
    /// regresa `[]`. Misma forma que `ChatContact` sin campos `lastMessage*`.
    func searchContacts(query: String) async throws -> [ChatContact] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        return try await client.get("/contacts/search", query: ["q": trimmed])
    }

    // MARK: Custom fields

    /// `GET /api/contacts/custom-fields` — definiciones para editores y el
    /// builder de filtros condicionales (excluir `archived`).
    func fetchCustomFieldDefinitions(includeArchived: Bool = false) async throws -> [ContactCustomFieldDefinition] {
        try await client.get(
            "/contacts/custom-fields",
            query: ["includeArchived": includeArchived ? "true" : nil]
        )
    }

    /// `PUT /contacts/:id { customFields }` (merge server-side por identidad).
    @discardableResult
    func updateCustomFields(contactId: String, fields: [ContactCustomFieldWrite]) async throws -> ContactDetail {
        try await updateContact(id: contactId, with: ContactUpdateRequest(customFields: fields))
    }

    // MARK: Perfil social vinculado

    /// `GET /api/contacts/:id/linked-social` — gate `contacts` + `chat`.
    /// Respuesta SIN clave `data` (`{ success, profiles, linked }`).
    func fetchLinkedSocialProfiles(contactId: String) async throws -> ContactLinkedSocialResult {
        try await client.get("/contacts/\(contactId)/linked-social")
    }

    // MARK: Contactos ocultos (referencia)

    /// `GET /api/hidden-contacts` (solo lectura; POST/DELETE son admin-only y
    /// viven en Configuración de escritorio). La bandeja NO gestiona esto: el
    /// server ya excluye ocultos de chats/búsqueda/detalle.
    func fetchHiddenContactFilters() async throws -> [HiddenContactFilter] {
        try await client.get("/hidden-contacts")
    }
}
