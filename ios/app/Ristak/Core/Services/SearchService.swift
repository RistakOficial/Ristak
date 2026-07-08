import Foundation

/// Búsqueda global (`GET /api/search/global`, doc 03 §1.4). Solo requiere
/// sesión (sin gate de módulo). Hasta 6 filas por categoría (contactos,
/// citas, pagos, planes, automatizaciones, calendarios, usuarios, campañas…).
/// La bandeja móvil usa `/contacts/search`; esta es para búsqueda global
/// (p. ej. iPad).
struct SearchService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// `q` obligatorio; vacío → resultado vacío sin pegarle al backend.
    func globalSearch(query: String) async throws -> GlobalSearchResult {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return GlobalSearchResult.empty }
        return try await client.get("/search/global", query: ["q": trimmed])
    }
}

/// `data: { categories, total }`.
struct GlobalSearchResult: Decodable, Sendable {
    let categories: [GlobalSearchCategory]
    let total: Int

    enum CodingKeys: String, CodingKey {
        case categories, total
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        categories = (try? container.decodeIfPresent([GlobalSearchCategory].self, forKey: .categories)) ?? []
        total = container.flexibleInt(forKey: .total) ?? 0
    }

    private init(categories: [GlobalSearchCategory], total: Int) {
        self.categories = categories
        self.total = total
    }

    static let empty = GlobalSearchResult(categories: [], total: 0)
}

/// Categoría de resultados (`{ id, label, items }`), p. ej.
/// `contacts`/`Contactos`, `appointments`/`Citas`, `payments`/`Pagos`.
struct GlobalSearchCategory: Decodable, Identifiable, Sendable {
    let id: String
    let label: String
    let items: [GlobalSearchItem]

    enum CodingKeys: String, CodingKey {
        case id, label, items
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        label = container.flexibleString(forKey: .label) ?? ""
        items = (try? container.decodeIfPresent([GlobalSearchItem].self, forKey: .items)) ?? []
    }
}

/// Fila de resultado: `{ type, id, title, subtitle, meta, metadata? }`.
/// `metadata` trae ids de navegación (`contactId`, `calendarId`, `startTime`…).
struct GlobalSearchItem: Decodable, Identifiable, Sendable {
    let type: String
    let id: String
    let title: String
    let subtitle: String?
    let meta: String?
    let metadata: [String: RistakJSONValue]

    enum CodingKeys: String, CodingKey {
        case type, id, title, subtitle, meta, metadata
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = container.flexibleString(forKey: .type) ?? ""
        id = container.flexibleString(forKey: .id) ?? ""
        title = container.flexibleString(forKey: .title) ?? ""
        subtitle = container.flexibleString(forKey: .subtitle)
        meta = container.flexibleString(forKey: .meta)
        metadata = (try? container.decodeIfPresent([String: RistakJSONValue].self, forKey: .metadata)) ?? [:]
    }

    /// `metadata.contactId` si viene (citas/pagos → abrir el chat/contacto).
    var contactId: String? {
        if case .string(let value)? = metadata["contactId"], !value.isEmpty { return value }
        return nil
    }
}
