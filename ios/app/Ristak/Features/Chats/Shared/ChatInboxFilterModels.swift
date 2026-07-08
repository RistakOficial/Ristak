import Foundation

// Catálogo de filtros de la bandeja (doc research/03 §3). Los ids de chip son
// strings persistidos en `app_config.mobile_chat_filter_chip_ids`:
// `all|unread|appointments|customers|leads|comments`, `phone:<id>`,
// `advanced:<grupo>:<valor>`, `custom:<presetId>`.

// MARK: - Rápidos

enum ChatQuickFilter: String, CaseIterable, Sendable {
    case all
    case unread
    case appointments
    case customers
    case leads
    case comments

    /// Descripción del manager de filtros (doc 03 §3.1, copy exacto).
    var managerDescription: String {
        switch self {
        case .all: return "Muestra todas las conversaciones activas."
        case .unread: return "Sólo conversaciones con mensajes pendientes."
        case .appointments: return "Contactos con cita guardada."
        case .customers: return "Contactos marcados como clientes o con compras."
        case .leads: return "Contactos interesados que todavía no son clientes ni citados."
        case .comments: return "Muestra los chats que llegaron por comentarios de Facebook o Instagram."
        }
    }
}

// MARK: - Avanzados

/// Grupos de filtros avanzados (`advanced:<grupo>:<valor>`, doc 03 §3.3).
enum ChatAdvancedFilterGroup: String, CaseIterable, Sendable {
    case channel
    case origin
    case social
    case stage
    case activity

    var title: String {
        switch self {
        case .channel: return "Canal"
        case .origin: return "Origen"
        case .social: return "Red social"
        case .stage: return "Etapa"
        case .activity: return "Actividad"
        }
    }

    /// Valores y labels exactos del catálogo.
    var options: [(value: String, label: String)] {
        switch self {
        case .channel:
            return [
                ("whatsapp", "WhatsApp"),
                ("messenger", "Messenger"),
                ("instagram", "Instagram Direct"),
                ("webchat", "Webchat / sitio"),
                ("sms", "SMS"),
                ("email", "Email"),
            ]
        case .origin:
            return [
                ("meta", "Meta / red social"),
                ("site", "Sitio o formulario"),
                ("organic", "Orgánico / directo"),
                ("trigger", "Enlace de disparo"),
                ("unknown", "Sin origen"),
            ]
        case .social:
            return [
                ("facebook", "Facebook"),
                ("instagram", "Instagram"),
                ("messenger", "Messenger"),
                ("whatsapp", "WhatsApp"),
                ("google", "Google"),
                ("unknown", "Sin red detectada"),
            ]
        case .stage:
            return [
                ("lead", "Interesados"),
                ("appointment", "Con cita"),
                ("customer", "Clientes"),
            ]
        case .activity:
            return [
                ("payments", "Con pagos"),
                ("appointments", "Con citas"),
                ("with_source", "Con origen detectado"),
                ("no_phone", "Sin teléfono"),
            ]
        }
    }

    func label(for value: String) -> String {
        options.first { $0.value == value }?.label ?? value
    }
}

// MARK: - Filtro activo

/// Filtro activo de la bandeja. Solo puede haber UNO a la vez (doc 03 §3.3/§3.5).
enum ChatInboxFilter: Hashable, Sendable {
    case quick(ChatQuickFilter)
    case phone(String)
    case advanced(group: String, value: String)
    case custom(String)

    /// Id de chip persistible.
    var chipID: String {
        switch self {
        case .quick(let quick): return quick.rawValue
        case .phone(let id): return "phone:\(id)"
        case .advanced(let group, let value): return "advanced:\(group):\(value)"
        case .custom(let id): return "custom:\(id)"
        }
    }

    init?(chipID raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let quick = ChatQuickFilter(rawValue: trimmed) {
            self = .quick(quick)
            return
        }
        if trimmed.hasPrefix("phone:") {
            let id = String(trimmed.dropFirst("phone:".count))
            guard !id.isEmpty else { return nil }
            self = .phone(id)
            return
        }
        if trimmed.hasPrefix("advanced:") {
            let parts = trimmed.split(separator: ":", maxSplits: 2).map(String.init)
            guard parts.count == 3, !parts[1].isEmpty, !parts[2].isEmpty else { return nil }
            self = .advanced(group: parts[1], value: parts[2])
            return
        }
        if trimmed.hasPrefix("custom:") {
            let id = String(trimmed.dropFirst("custom:".count))
            guard !id.isEmpty else { return nil }
            self = .custom(id)
            return
        }
        return nil
    }

    var isPhoneFilter: Bool {
        if case .phone = self { return true }
        return false
    }

    var isCommentsLens: Bool {
        self == .quick(.comments)
    }
}

/// Chips visibles por defecto (`mobile_chat_filter_chip_ids`, doc 03 §1.7).
enum ChatFilterChipDefaults {
    static let baseChipIDs = ["all", "unread", "appointments", "customers", "leads", "comments"]

    /// Normaliza la lista guardada: `all` siempre presente y al inicio.
    static func normalized(_ stored: [String]) -> [String] {
        var result = stored.filter { !$0.isEmpty }
        result.removeAll { $0 == "all" }
        result.insert("all", at: 0)
        return result
    }
}

// MARK: - Sub-filtro de la lente de comentarios

enum ChatCommentsPlatform: String, CaseIterable, Sendable {
    case all
    case facebook
    case instagram

    var title: String {
        switch self {
        case .all: return "Todas"
        case .facebook: return "Facebook"
        case .instagram: return "Instagram"
        }
    }
}

// MARK: - Presets condicionales (doc 03 §3.4)

struct ChatFilterPresetRule: Identifiable, Sendable, Equatable {
    let id: String
    let field: String
    let op: String
    /// Valor(es) normalizado(s) a strings.
    let values: [String]
    let valueTo: String?
}

struct ChatFilterPreset: Identifiable, Sendable, Equatable {
    let id: String
    let label: String
    /// `match: "all" | "any"`.
    let matchAll: Bool
    let rules: [ChatFilterPresetRule]

    /// Parsea el JSON crudo de `mobile_chat_custom_filter_presets` con
    /// tolerancia total (entradas corruptas se descartan).
    static func parseList(fromJSON raw: String?) -> [ChatFilterPreset] {
        guard let raw, !raw.isEmpty, let data = raw.data(using: .utf8) else { return [] }
        guard let array = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return [] }
        return array.compactMap { entry in
            guard let id = Self.string(entry["id"]), !id.isEmpty else { return nil }
            let label = Self.string(entry["label"]) ?? "Filtro"
            let matchAll = (Self.string(entry["match"]) ?? "all").lowercased() != "any"
            let rulesRaw = entry["rules"] as? [[String: Any]] ?? []
            let rules: [ChatFilterPresetRule] = rulesRaw.compactMap { ruleEntry in
                guard let field = Self.string(ruleEntry["field"]), !field.isEmpty else { return nil }
                let ruleID = Self.string(ruleEntry["id"]) ?? UUID().uuidString
                let op = (Self.string(ruleEntry["operator"]) ?? "is").lowercased()
                let values = Self.stringList(ruleEntry["value"])
                let valueTo = Self.string(ruleEntry["valueTo"])
                return ChatFilterPresetRule(id: ruleID, field: field, op: op, values: values, valueTo: valueTo)
            }
            return ChatFilterPreset(id: id, label: label, matchAll: matchAll, rules: rules)
        }
    }

    /// Serializa presets de vuelta al formato del config (para borrar uno).
    static func serializeList(_ presets: [ChatFilterPreset]) -> String {
        let array: [[String: Any]] = presets.map { preset in
            [
                "id": preset.id,
                "label": preset.label,
                "match": preset.matchAll ? "all" : "any",
                "rules": preset.rules.map { rule -> [String: Any] in
                    var entry: [String: Any] = [
                        "id": rule.id,
                        "field": rule.field,
                        "operator": rule.op,
                    ]
                    entry["value"] = rule.values.count == 1 ? rule.values[0] : rule.values
                    if let valueTo = rule.valueTo { entry["valueTo"] = valueTo }
                    return entry
                },
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: array),
              let json = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return json
    }

    private static func string(_ value: Any?) -> String? {
        if let string = value as? String { return string }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    private static func stringList(_ value: Any?) -> [String] {
        if let array = value as? [Any] {
            return array.compactMap { string($0) }
        }
        if let single = string(value) { return [single] }
        return []
    }
}

// MARK: - Normalización de texto (sin acentos, paridad /movil)

func ristakFoldedText(_ value: String) -> String {
    value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "es_MX"))
        .trimmingCharacters(in: .whitespacesAndNewlines)
}
