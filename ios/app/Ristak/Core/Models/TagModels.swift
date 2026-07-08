import Foundation

// Contrato exacto: docs/research/03-chats-inbox.md §1.5 y
// docs/research/06-contact-info.md §1.5/§2.3.

/// Etiqueta de contacto. Las internas (`client`/`booked`/`lead`) llegan con
/// `isSystem:true`, NO se guardan en `contacts.tags` y no se pueden
/// crear/editar/borrar (400 del backend).
struct ContactTag: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let folderId: String?
    let isSystem: Bool
    let createdAt: String?
    let updatedAt: String?
    /// Solo con `includeUsage=true` o en el catálogo.
    let usageCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, folderId, isSystem, createdAt, updatedAt, usageCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        name = container.flexibleString(forKey: .name) ?? ""
        folderId = container.flexibleString(forKey: .folderId)
        isSystem = container.flexibleBool(forKey: .isSystem) ?? false
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        usageCount = container.flexibleInt(forKey: .usageCount)
    }
}

/// Carpeta de etiquetas.
struct ContactTagFolder: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let description: String
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        name = container.flexibleString(forKey: .name) ?? ""
        description = container.flexibleString(forKey: .description) ?? ""
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
    }
}

/// `GET /api/contact-tags/catalog` → `data: { tags, folders }`.
struct ContactTagCatalog: Decodable, Sendable {
    let tags: [ContactTag]
    let folders: [ContactTagFolder]

    enum CodingKeys: String, CodingKey {
        case tags, folders
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tags = (try? container.decodeIfPresent([ContactTag].self, forKey: .tags)) ?? []
        folders = (try? container.decodeIfPresent([ContactTagFolder].self, forKey: .folders)) ?? []
    }
}

/// `POST /api/contacts/bulk/tags` → `data: { updated, total }`.
struct BulkTagUpdateResult: Decodable, Sendable {
    let updated: Int
    let total: Int

    enum CodingKeys: String, CodingKey {
        case updated, total
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        updated = container.flexibleInt(forKey: .updated) ?? 0
        total = container.flexibleInt(forKey: .total) ?? 0
    }
}
