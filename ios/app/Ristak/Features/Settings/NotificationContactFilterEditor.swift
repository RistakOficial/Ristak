import SwiftUI

struct NotificationFilterOption: Codable, Identifiable {
    var value: String
    var label: String
    var id: String { value }
}
struct NotificationFilterField: Decodable, Identifiable {
    var key: String
    var field: String
    var label: String
    var type: String
    var customKey: String?
    var options: [NotificationFilterOption]
    var operators: [NotificationFilterOption]
    var id: String { key }
}
struct NotificationFilterCatalog: Decodable {
    struct Group: Decodable, Identifiable {
        var label: String
        var fields: [NotificationFilterField]
        var id: String { label }
    }
    var groups: [Group]
}
// Values accept the same strings, numbers, booleans and tag arrays as the contact engine.
enum NotificationFilterValue: Codable {
    case text(String), list([String])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .text("") }
        else if let v = try? c.decode([String].self) { self = .list(v) }
        else if let v = try? c.decode(String.self) { self = .text(v) }
        else if let v = try? c.decode(Bool.self) { self = .text(v ? "true" : "false") }
        else { self = .text(String(try c.decode(Double.self))) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .text(let v): try c.encode(v); case .list(let v): try c.encode(v) }
    }
    var text: String { switch self { case .text(let v): return v; case .list(let v): return v.joined(separator: ", ") } }
    var values: [String] { switch self { case .text(let v): return v.isEmpty ? [] : [v]; case .list(let v): return v } }
}
struct NotificationContactFilter: Codable {
    struct Rule: Codable, Identifiable {
        var id = UUID().uuidString
        var field: String
        var `operator`: String
        var value: NotificationFilterValue?
        var valueTo: NotificationFilterValue?
        var customKey: String?
        var valueType: String?
        init(field: NotificationFilterField) {
            self.field = field.field
            self.operator = field.operators.first?.value ?? "contains"
            customKey = field.customKey
            valueType = field.customKey == nil ? nil : field.type
            value = .text("")
        }
    }
    struct Group: Codable, Identifiable {
        var id = UUID().uuidString
        var mode = "all"
        var negate = false
        var rules: [Rule] = []
    }
    var version = 1
    var groupMode = "all"
    var groups: [Group] = []
    static let targets: [(key: String, title: String)] = [
        ("contact_push_notification_filter", "Todos los avisos de contactos"),
        ("chat_push_contact_filter", "Mensajes del chat"),
        ("calendar_push_contact_filter", "Citas y recordatorios"),
        ("appointment_confirmation_push_contact_filter", "Citas confirmadas"),
        ("payment_push_contact_filter", "Pagos")
    ]
}

struct NotificationContactFilterEditor: View {
    let configKey: String
    let title: String
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.dismiss) private var dismiss
    @State private var draft = NotificationContactFilter()
    @State private var catalog: NotificationFilterCatalog?
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Text("Solo recibirás avisos de contactos que cumplan estas condiciones. Se combinan con tus interruptores y calendarios elegidos.")
                if configKey != "contact_push_notification_filter" {
                    Text("También se aplica el filtro de Todos los avisos de contactos.")
                }
            }
            if loading { ProgressView("Cargando filtros…") }
            if let error {
                Section {
                    Text(error).foregroundStyle(RistakTheme.neg)
                    if catalog == nil { Button("Reintentar") { Task { await load() } } }
                }
            }
            if catalog != nil && !loading {
                if draft.groups.isEmpty {
                    Text("Sin condiciones: este filtro permite todos los contactos.")
                } else {
                    Picker("Coincidencia de bloques", selection: $draft.groupMode) {
                        Text("Todos los bloques").tag("all")
                        Text("Cualquier bloque").tag("any")
                    }
                }
                ForEach($draft.groups) { $group in
                    Section {
                        Picker("Condiciones del bloque", selection: $group.mode) {
                            Text("Todas").tag("all")
                            Text("Cualquiera").tag("any")
                        }
                        Toggle("Excluir si coincide este bloque", isOn: $group.negate)
                        ForEach($group.rules) { $rule in
                            ruleRow($rule)
                            Button("Quitar condición", role: .destructive) { group.rules.removeAll { $0.id == rule.id } }
                        }
                        NavigationLink("Agregar condición") {
                            NotificationFilterFieldPicker(catalog: catalog!) { field in
                                group.rules.append(.init(field: field))
                            }
                        }
                        Button("Eliminar bloque", role: .destructive) { draft.groups.removeAll { $0.id == group.id } }
                    }
                }
                Section {
                    NavigationLink("Agregar bloque") {
                        NotificationFilterFieldPicker(catalog: catalog!) { field in
                            var group = NotificationContactFilter.Group()
                            group.rules = [.init(field: field)]
                            draft.groups.append(group)
                        }
                    }.disabled(draft.groups.count >= 10)
                    Button("Quitar todos los filtros", role: .destructive) { draft = .init() }
                }
            }
        }
        .disabled(saving)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Guardando…" : "Guardar") { Task { await save() } }
                    .disabled(loading || saving || catalog == nil)
            }
        }
        .task { await load() }
    }

    @ViewBuilder private func ruleRow(_ rule: Binding<NotificationContactFilter.Rule>) -> some View {
        let field = catalog?.groups.flatMap(\.fields).first { $0.field == rule.wrappedValue.field && $0.customKey == rule.wrappedValue.customKey }
        if let field {
            Text(field.label).font(.headline)
            Picker("Condición", selection: rule.operator) {
                ForEach(field.operators) { option in Text(option.label).tag(option.value) }
            }
            if !["empty", "not_empty", "yes", "no"].contains(rule.wrappedValue.operator) {
                if field.type == "tags" {
                    NavigationLink("Etiquetas: \(rule.wrappedValue.value?.values.count ?? 0)") {
                        List(field.options) { option in
                            Button {
                                var values = rule.wrappedValue.value?.values ?? []
                                if values.contains(option.value) { values.removeAll { $0 == option.value } } else { values.append(option.value) }
                                rule.wrappedValue.value = .list(values)
                            } label: {
                                HStack { Text(option.label); Spacer(); if rule.wrappedValue.value?.values.contains(option.value) == true { Image(systemName: "checkmark") } }
                            }
                        }.navigationTitle("Etiquetas")
                    }
                } else if !field.options.isEmpty {
                    Picker("Valor", selection: Binding(get: { rule.wrappedValue.value?.text ?? "" }, set: { rule.wrappedValue.value = .text($0) })) {
                        Text("Selecciona").tag("")
                        ForEach(field.options) { option in Text(option.label).tag(option.value) }
                    }
                } else {
                    TextField(field.type == "date" && !["last_days", "older_days"].contains(rule.wrappedValue.operator) ? "AAAA-MM-DD" : "Valor", text: Binding(get: { rule.wrappedValue.value?.text ?? "" }, set: { rule.wrappedValue.value = .text($0) }))
                        .keyboardType(field.type == "number" ? .numbersAndPunctuation : .default)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                if rule.wrappedValue.operator == "between" {
                    TextField(field.type == "date" ? "Hasta AAAA-MM-DD" : "Hasta", text: Binding(get: { rule.wrappedValue.valueTo?.text ?? "" }, set: { rule.wrappedValue.valueTo = .text($0) }))
                        .keyboardType(field.type == "number" ? .numbersAndPunctuation : .default)
                }
            }
        } else { Text("Campo no disponible. Quita esta condición o vuelve a cargar.").foregroundStyle(RistakTheme.neg) }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            async let fields: NotificationFilterCatalog = APIClient.shared.get("/api/user-config/notification-filters/catalog")
            async let values: RistakKeyedConfigPayload = APIClient.shared.get("/api/user-config", query: ["keys": configKey])
            let (loaded, config) = try await (fields, values)
            let raw = config.config[configKey] ?? nil
            let parsed = try raw.map { try JSONDecoder().decode(NotificationContactFilter.self, from: Data($0.utf8)) } ?? .init()
            guard !Task.isCancelled else { return }
            draft = parsed
            catalog = loaded
        } catch { self.error = error.localizedDescription }
        loading = false
    }
    private func save() async {
        saving = true
        error = nil
        do {
            let raw = String(decoding: try JSONEncoder().encode(draft), as: UTF8.self)
            try await appConfig.setUserConfigValue(raw, forKey: configKey)
            dismiss()
        } catch { self.error = error.localizedDescription }
        saving = false
    }
}

private struct NotificationFilterFieldPicker: View {
    let catalog: NotificationFilterCatalog
    let onSelect: (NotificationFilterField) -> Void
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            ForEach(catalog.groups.filter { group in search.isEmpty || group.fields.contains { $0.label.localizedStandardContains(search) } }) { group in
                Section(group.label) {
                    ForEach(group.fields.filter { search.isEmpty || $0.label.localizedStandardContains(search) }) { field in
                        Button(field.label) { onSelect(field); dismiss() }
                    }
                }
            }
        }.navigationTitle("Elegir campo").searchable(text: $search, prompt: "Buscar campo")
    }
}
