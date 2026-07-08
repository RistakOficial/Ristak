import Foundation

/// Etiquetas de contacto (`/api/contact-tags*` + bulk, docs 03 §1.5 / 06 §2.3).
/// Las etiquetas internas (`client`/`booked`/`lead`) no se crean/editan/borran
/// (400 del backend) y no se guardan en `contacts.tags`.
struct TagsService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// `GET /api/contact-tags`.
    func fetchTags(includeSystem: Bool = false, includeUsage: Bool = false) async throws -> [ContactTag] {
        try await client.get(
            "/contact-tags",
            query: [
                "includeSystem": includeSystem ? "true" : nil,
                "includeUsage": includeUsage ? "true" : nil,
            ]
        )
    }

    /// `GET /api/contact-tags/system` — solo internas.
    func fetchSystemTags() async throws -> [ContactTag] {
        try await client.get("/contact-tags/system")
    }

    /// `GET /api/contact-tags/catalog` — etiquetas con `usageCount` + carpetas.
    func fetchCatalog(includeSystem: Bool = false) async throws -> ContactTagCatalog {
        try await client.get(
            "/contact-tags/catalog",
            query: ["includeSystem": includeSystem ? "true" : nil]
        )
    }

    /// `POST /api/contact-tags` — 201 con la etiqueta creada; si ya existe
    /// una con el mismo nombre normalizado devuelve la existente. Nombre máx
    /// 60 chars; nombres reservados de internas → 400.
    func createTag(name: String, folderId: String? = nil) async throws -> ContactTag {
        try await client.post("/contact-tags", body: ContactTagWriteBody(name: name, folderId: folderId))
    }

    /// `PUT /api/contact-tags/:id` — 400 internas / 404 / 409 nombre duplicado.
    func updateTag(id: String, name: String? = nil, folderId: String? = nil) async throws -> ContactTag {
        try await client.put("/contact-tags/\(id)", body: ContactTagWriteBody(name: name, folderId: folderId))
    }

    /// `DELETE /api/contact-tags/:id` — la quita del catálogo Y de todos los
    /// contactos.
    func deleteTag(id: String) async throws {
        try await client.delete("/contact-tags/\(id)")
    }

    /// `POST /api/contact-tags/folders`.
    func createFolder(name: String, description: String? = nil) async throws -> ContactTagFolder {
        try await client.post("/contact-tags/folders", body: ContactTagFolderWriteBody(name: name, description: description))
    }

    /// `DELETE /api/contact-tags/folders/:id` — las etiquetas quedan sin carpeta.
    func deleteFolder(id: String) async throws {
        try await client.delete("/contact-tags/folders/\(id)")
    }

    /// `POST /api/contacts/bulk/tags` (1..1000 contactos). `addTagIds` acepta
    /// ids O nombres (crea las que no existan); internas se ignoran. El sheet
    /// móvil "Agregar etiqueta" usa este endpoint con UN solo contactId.
    @discardableResult
    func bulkUpdateTags(
        contactIds: [String],
        addTagIds: [String] = [],
        removeTagIds: [String] = []
    ) async throws -> BulkTagUpdateResult {
        try await client.post(
            "/contacts/bulk/tags",
            body: ContactBulkTagsBody(contactIds: contactIds, addTagIds: addTagIds, removeTagIds: removeTagIds)
        )
    }

    /// Azúcar para el sheet móvil: agrega UNA etiqueta a UN contacto.
    @discardableResult
    func addTag(_ tagIdOrName: String, toContact contactId: String) async throws -> BulkTagUpdateResult {
        try await bulkUpdateTags(contactIds: [contactId], addTagIds: [tagIdOrName])
    }
}

/// Body de crear/editar etiqueta.
struct ContactTagWriteBody: Encodable, Sendable {
    var name: String?
    var folderId: String?
}

/// Body de crear carpeta de etiquetas.
struct ContactTagFolderWriteBody: Encodable, Sendable {
    var name: String
    var description: String?
}

/// Body del bulk de etiquetas.
struct ContactBulkTagsBody: Encodable, Sendable {
    var contactIds: [String]
    var addTagIds: [String]
    var removeTagIds: [String]
}
