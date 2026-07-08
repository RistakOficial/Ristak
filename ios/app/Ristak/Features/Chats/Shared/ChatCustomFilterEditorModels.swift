import Foundation

// Modelo del editor de filtros condicionales (paridad mobile/ App.tsx:
// `PhoneChatConditionField`, `buildPhoneChatConditionFieldGroups` línea 17520,
// operadores línea 1073+, `createPhoneChatCustomFilter*`). El usuario arma sus
// propias combinaciones (campo + operador + valor) y las guarda en
// `mobile_chat_custom_filter_presets`, en el mismo formato que
// `ChatFilterPreset.parseList`/`serializeList` y que consume
// `ChatFilterPresetEvaluator`.

// MARK: - Tipos de campo / opciones

/// Tipo de dato del campo: decide operadores y editor de valor (paridad
/// `ContactAdvancedFieldType`).
enum ChatConditionFieldType: Sendable, Equatable {
    case text
    case number
    case boolean
    case tags
    case select
}

/// Operador con etiqueta en español (paridad `PHONE_CHAT_*_OPERATORS`).
struct ChatConditionOperator: Identifiable, Sendable, Equatable {
    let value: String
    let label: String
    var id: String { value }
}

/// Opción de valor (para `select`/`tags`): `value` es lo que se guarda,
/// `label` lo que se muestra.
struct ChatConditionOption: Identifiable, Sendable, Equatable {
    let value: String
    let label: String
    var id: String { value }
}

/// Campo seleccionable. `key` es el `rule.field` que consume el evaluador.
struct ChatConditionField: Identifiable, Sendable, Equatable {
    let key: String
    let label: String
    let section: String
    let type: ChatConditionFieldType
    var options: [ChatConditionOption] = []

    var id: String { key }
}

/// Grupo de campos (sección) para pintar el catálogo.
struct ChatConditionFieldGroup: Identifiable, Sendable, Equatable {
    let label: String
    let fields: [ChatConditionField]

    var id: String { label }
}

// MARK: - Operadores por tipo

enum ChatConditionOperators {
    static let text: [ChatConditionOperator] = [
        ChatConditionOperator(value: "contains", label: "contiene"),
        ChatConditionOperator(value: "not_contains", label: "no contiene"),
        ChatConditionOperator(value: "is", label: "es igual a"),
        ChatConditionOperator(value: "is_not", label: "no es igual a"),
        ChatConditionOperator(value: "starts_with", label: "empieza con"),
        ChatConditionOperator(value: "ends_with", label: "termina con"),
        ChatConditionOperator(value: "empty", label: "está vacío"),
        ChatConditionOperator(value: "not_empty", label: "no está vacío"),
    ]

    static let number: [ChatConditionOperator] = [
        ChatConditionOperator(value: "eq", label: "es igual a"),
        ChatConditionOperator(value: "neq", label: "no es igual a"),
        ChatConditionOperator(value: "gt", label: "mayor que"),
        ChatConditionOperator(value: "gte", label: "mayor o igual que"),
        ChatConditionOperator(value: "lt", label: "menor que"),
        ChatConditionOperator(value: "lte", label: "menor o igual que"),
        ChatConditionOperator(value: "between", label: "está entre"),
        ChatConditionOperator(value: "empty", label: "está en cero"),
        ChatConditionOperator(value: "not_empty", label: "no está en cero"),
    ]

    static let boolean: [ChatConditionOperator] = [
        ChatConditionOperator(value: "yes", label: "sí lo tiene"),
        ChatConditionOperator(value: "no", label: "no lo tiene"),
    ]

    static let select: [ChatConditionOperator] = [
        ChatConditionOperator(value: "is", label: "es igual a"),
        ChatConditionOperator(value: "is_not", label: "no es igual a"),
        ChatConditionOperator(value: "empty", label: "está vacío"),
        ChatConditionOperator(value: "not_empty", label: "no está vacío"),
    ]

    static let tags: [ChatConditionOperator] = [
        ChatConditionOperator(value: "any", label: "tiene cualquiera de"),
        ChatConditionOperator(value: "all", label: "tiene todas"),
        ChatConditionOperator(value: "none", label: "no tiene"),
        ChatConditionOperator(value: "empty", label: "sin etiquetas"),
        ChatConditionOperator(value: "not_empty", label: "con etiquetas"),
    ]

    static func forField(_ field: ChatConditionField?) -> [ChatConditionOperator] {
        guard let field else { return text }
        switch field.type {
        case .number: return number
        case .boolean: return boolean
        case .tags: return tags
        case .select: return select
        case .text: return text
        }
    }

    static func defaultOperator(for field: ChatConditionField?) -> String {
        forField(field).first?.value ?? "contains"
    }

    /// Operadores que NO piden valor (paridad `operatorNeedsContactAdvancedValue`).
    static func needsValue(_ op: String) -> Bool {
        !["empty", "not_empty", "yes", "no"].contains(op)
    }

    static func usesRange(_ op: String) -> Bool { op == "between" }
}

// MARK: - Catálogo de campos

enum ChatConditionFieldCatalog {
    static let defaultFieldKey = "chat_segment"

    /// Grupos de campos base (paridad `buildPhoneChatConditionFieldGroups`, sin
    /// los campos personalizados que requieren catálogo aparte). Las opciones de
    /// canal/origen/red/actividad se reutilizan de `ChatAdvancedFilterGroup`.
    static func groups(
        phoneNumbers: [WhatsAppPhoneNumber],
        tags: [ContactTag]
    ) -> [ChatConditionFieldGroup] {
        let phoneOptions = phoneNumbers.enumerated().map { index, number in
            ChatConditionOption(
                value: number.id,
                label: number.displayTitle.isEmpty ? "Número \(index + 1)" : number.displayTitle
            )
        }
        let tagOptions = tags
            .filter { !$0.name.isEmpty }
            .map { ChatConditionOption(value: $0.id, label: $0.name) }

        return [
            ChatConditionFieldGroup(
                label: "Chat",
                fields: [
                    ChatConditionField(
                        key: "chat_segment",
                        label: "Segmento del chat",
                        section: "Chat",
                        type: .select,
                        options: [
                            ChatConditionOption(value: "customers", label: "Clientes"),
                            ChatConditionOption(value: "leads", label: "Leads"),
                            ChatConditionOption(value: "appointments", label: "Agendados"),
                            ChatConditionOption(value: "unread", label: "No leídos"),
                            ChatConditionOption(value: "comments", label: "Comentarios"),
                        ]
                    ),
                    ChatConditionField(
                        key: "business_phone",
                        label: "Número de WhatsApp",
                        section: "Chat",
                        type: .select,
                        options: phoneOptions
                    ),
                    ChatConditionField(
                        key: "channel",
                        label: "Canal",
                        section: "Chat",
                        type: .select,
                        options: options(for: .channel)
                    ),
                    ChatConditionField(
                        key: "origin",
                        label: "Origen",
                        section: "Chat",
                        type: .select,
                        options: options(for: .origin)
                    ),
                    ChatConditionField(
                        key: "social",
                        label: "Red social",
                        section: "Chat",
                        type: .select,
                        options: options(for: .social)
                    ),
                    ChatConditionField(
                        key: "activity",
                        label: "Actividad",
                        section: "Chat",
                        type: .select,
                        options: options(for: .activity)
                    ),
                ]
            ),
            ChatConditionFieldGroup(
                label: "Contacto",
                fields: [
                    ChatConditionField(key: "full_name", label: "Nombre", section: "Contacto", type: .text),
                    ChatConditionField(key: "phone", label: "Teléfono", section: "Contacto", type: .text),
                    ChatConditionField(key: "email", label: "Email", section: "Contacto", type: .text),
                    ChatConditionField(
                        key: "status",
                        label: "Etapa comercial",
                        section: "Contacto",
                        type: .select,
                        options: [
                            ChatConditionOption(value: "lead", label: "Lead"),
                            ChatConditionOption(value: "appointment", label: "Con cita"),
                            ChatConditionOption(value: "customer", label: "Cliente"),
                        ]
                    ),
                    ChatConditionField(key: "source", label: "Fuente", section: "Contacto", type: .text),
                    ChatConditionField(
                        key: "unread",
                        label: "Tiene mensajes no leídos",
                        section: "Contacto",
                        type: .boolean
                    ),
                ]
            ),
            ChatConditionFieldGroup(
                label: "Etiquetas",
                fields: [
                    ChatConditionField(key: "tags", label: "Etiquetas", section: "Etiquetas", type: .tags, options: tagOptions),
                ]
            ),
        ]
    }

    private static func options(for group: ChatAdvancedFilterGroup) -> [ChatConditionOption] {
        group.options.map { ChatConditionOption(value: $0.value, label: $0.label) }
    }
}

// MARK: - Draft del editor

/// Regla en edición. `value`/`valueTo` viven como texto mientras se edita.
struct ChatCustomFilterDraftRule: Identifiable, Sendable, Equatable {
    let id: String
    var field: String
    var op: String
    var value: String
    var valueTo: String

    init(
        id: String = "rule_\(UUID().uuidString.prefix(8))",
        field: String,
        op: String,
        value: String = "",
        valueTo: String = ""
    ) {
        self.id = id
        self.field = field
        self.op = op
        self.value = value
        self.valueTo = valueTo
    }
}

/// Borrador del filtro condicional. `token` identifica la PRESENTACIÓN del
/// editor (para `.sheet(item:)`); `id` es el id persistido ("" = nuevo).
struct ChatCustomFilterDraft: Identifiable, Sendable, Equatable {
    let token: UUID
    var id: String
    var label: String
    var matchAll: Bool
    var rules: [ChatCustomFilterDraftRule]

    init(
        token: UUID = UUID(),
        id: String = "",
        label: String = "",
        matchAll: Bool = true,
        rules: [ChatCustomFilterDraftRule]
    ) {
        self.token = token
        self.id = id
        self.label = label
        self.matchAll = matchAll
        self.rules = rules
    }

    var isEditing: Bool { !id.isEmpty }
}
