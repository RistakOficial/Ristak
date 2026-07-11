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

    /// Directorio mínimo para selectores de Nuevo chat / Citas / Pagos.
    ///
    /// A diferencia de `searchContacts`, el backend NO calcula LTV, compras,
    /// citas ni consulta proveedores para refrescar fotos. Con query vacío
    /// devuelve los contactos recientes, por lo que reemplaza el costoso
    /// `fetchChats()` que antes corría cada vez que se abría un selector.
    /// La respuesta se guarda cruda en el snapshot namespaceado por cuenta;
    /// `cachedPickerContacts` la pinta al instante en aperturas posteriores.
    @MainActor
    func fetchPickerContacts(query: String = "", limit: Int = 60) async throws -> [ChatContact] {
        let trimmed = Self.trimmedPickerQuery(query)
        let cappedLimit = min(max(limit, 1), 100)
        let span = RistakObservability.begin(.contactDirectory)
        do {
            let responseData = try await client.rawData(
                "/contacts/search",
                query: [
                    "q": trimmed.isEmpty ? nil : trimmed,
                    "picker": "true",
                    "limit": String(cappedLimit),
                ]
            )
            guard var contacts = Self.decodePickerContacts(responseData) else {
                throw RistakAPIError.invalidResponse
            }

            var cacheData = responseData
            if trimmed.isEmpty, contacts.isEmpty,
               let legacyRecents = try? await ChatsService(client: client).fetchChats(
                   limit: cappedLimit,
                   warmProfilePictures: false
               ),
               !legacyRecents.isEmpty {
                // Backends anteriores ignoran `picker=true` y contestan `[]`
                // cuando `q` está vacío. Recuperamos recientes con el contrato
                // anterior; un directorio realmente vacío solo paga un GET extra.
                contacts = legacyRecents
                cacheData = Self.encodePickerContacts(legacyRecents) ?? responseData
            }

            let cacheKey = Self.pickerCacheKey(trimmed)
            if trimmed.isEmpty {
                // Solo el directorio reciente cruza lanzamientos.
                RistakSnapshotCache.shared.storeRaw(cacheData, for: cacheKey)
            } else {
                // Las consultas exactas contienen PII y pueden ser infinitas:
                // LRU/TTL en RAM, nunca un archivo por cada tecla.
                RistakSnapshotCache.shared.storeVolatileRaw(
                    cacheData,
                    for: cacheKey,
                    ttl: Self.pickerQueryCacheTTL,
                    maxEntries: Self.pickerQueryCacheLimit
                )
            }
            span.finish(outcome: .success, itemCount: contacts.count)
            return contacts
        } catch {
            span.finish(outcome: Task.isCancelled ? .cancelled : .failed)
            throw error
        }
    }

    /// Resuelve una sola identidad ligera para un evento realtime cuyo chat no
    /// está dentro de las páginas cargadas. Evita bajar la ficha pesada
    /// (pagos/citas/atribución) o recargar toda la bandeja para poder promover
    /// esa fila. No persiste el resultado: el refresh normal sigue siendo la
    /// fuente autoritativa y lo incorporará a la primera página.
    func fetchPickerContact(id: String) async throws -> ChatContact? {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let contacts: [ChatContact] = try await client.get(
            "/contacts/search",
            query: [
                "picker": "true",
                "contactId": trimmed,
                "limit": "1",
            ]
        )
        return contacts.first { $0.id.caseInsensitiveCompare(trimmed) == .orderedSame }
    }

    /// Lectura síncrona desde memoria del último directorio exitoso. Para una
    /// consulta que todavía no tenga snapshot exacto, filtra el directorio
    /// reciente local: escribir empieza a dar resultados sin esperar red.
    @MainActor
    func cachedPickerContacts(query: String = "") -> [ChatContact] {
        let trimmed = Self.trimmedPickerQuery(query)
        if let exact = Self.decodeCachedPickerContacts(
            for: Self.pickerCacheKey(trimmed),
            volatile: !trimmed.isEmpty
        ) {
            return exact
        }

        guard !trimmed.isEmpty,
              let recent = Self.decodeCachedPickerContacts(
                  for: Self.pickerCacheKey(""),
                  volatile: false
              ) else {
            return []
        }
        return ContactPickerDirectory.filter(recent, query: trimmed)
    }

    @MainActor
    private static func decodeCachedPickerContacts(
        for key: String,
        volatile: Bool
    ) -> [ChatContact]? {
        let data = volatile
            ? RistakSnapshotCache.shared.volatileRawData(for: key)
            : RistakSnapshotCache.shared.rawData(for: key)
        guard let data else { return nil }
        return decodePickerContacts(data)
    }

    private static func decodePickerContacts(_ data: Data) -> [ChatContact]? {
        try? RistakEnvelopeDecoder.unwrap(data, decoder: JSONDecoder())
    }

    private static func trimmedPickerQuery(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Snapshot mínimo para el fallback contra instalaciones anteriores. La
    /// forma usa las mismas claves tolerantes de `ChatContact`.
    private static func encodePickerContacts(_ contacts: [ChatContact]) -> Data? {
        let rows: [[String: Any]] = contacts.map { contact in
            var row: [String: Any] = [
                "id": contact.id,
                "name": contact.name,
                "email": contact.email,
                "phone": contact.phone,
                "preferredWhatsAppPhoneNumberId": contact.preferredWhatsAppPhoneNumberId,
                "lastBusinessPhone": contact.lastBusinessPhone,
                "lastBusinessPhoneNumberId": contact.lastBusinessPhoneNumberId,
                "lastMessageChannel": contact.lastMessageChannel,
                "lastMessageTransport": contact.lastMessageTransport,
            ]
            if let createdAt = contact.createdAt { row["createdAt"] = createdAt }
            if let photo = contact.profilePhotoUrl { row["profilePhotoUrl"] = photo }
            return row
        }
        guard JSONSerialization.isValidJSONObject(rows) else { return nil }
        return try? JSONSerialization.data(withJSONObject: rows)
    }

    private static let pickerQueryCacheTTL: TimeInterval = 5 * 60
    private static let pickerQueryCacheLimit = 24

    private static func pickerCacheKey(_ query: String) -> String {
        let folded = query
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "es_MX"))
            .lowercased()
        guard !folded.isEmpty else { return "contacts:picker:recent" }

        // FNV-1a estable: el término puede contener nombre/teléfono/correo y no
        // debe aparecer en el nombre del archivo de caché. No es criptografía
        // ni telemetría; solo una llave local namespaceada por cuenta.
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in folded.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return "contacts:picker:query:\(String(hash, radix: 16))"
    }

}

/// Lógica pura del directorio compartida por los tres selectores y cubierta por
/// unit tests. No conoce caché, red ni actores; solo normaliza texto/teléfonos.
enum ContactPickerDirectory {
    static func filter(_ contacts: [ChatContact], query: String) -> [ChatContact] {
        let folded = query.folding(
            options: [.caseInsensitive, .diacriticInsensitive],
            locale: Locale(identifier: "es_MX")
        ).lowercased()
        let digits = query.filter(\.isNumber)
        return contacts.filter { contact in
            let searchable = [contact.name, contact.email]
                .joined(separator: " ")
                .folding(
                    options: [.caseInsensitive, .diacriticInsensitive],
                    locale: Locale(identifier: "es_MX")
                )
                .lowercased()
            if searchable.contains(folded) { return true }
            guard !digits.isEmpty else { return false }
            let phones = ([contact.phone, contact.matchedPhone ?? ""] + contact.phones.map(\.phone))
                .map { $0.filter(\.isNumber) }
            return phones.contains { $0.contains(digits) }
        }
    }
}

extension ContactsService {
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
