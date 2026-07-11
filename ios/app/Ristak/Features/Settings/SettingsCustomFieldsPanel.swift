import SwiftUI

/// Panel «Campos personalizados» (doc 10 §5.1 `renderCustomFields`): catálogo
/// SOLO LECTURA de `GET /api/contacts/custom-fields`, agrupado por carpeta.
struct SettingsCustomFieldsPanel: View {
    @Environment(SettingsModel.self) private var model
    @State private var showCreate = false
    @State private var draftName = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var pendingDelete: ContactCustomFieldDefinition?

    var body: some View {
        SettingsLoadStateView(
            state: model.customFields,
            loadingMessage: "Cargando campos...",
            retry: { Task { await model.loadCustomFields() } }
        ) { fields in
            content(fields: fields)
        }
        .navigationTitle("Campos personalizados")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button { showCreate = true } label: { Label("Crear campo", systemImage: "plus") } }
        .refreshable { await model.loadCustomFields() }
        .alert("Nuevo campo personalizado", isPresented: $showCreate) {
            TextField("Nombre del campo", text: $draftName)
            Button("Crear") { Task { await createField() } }.disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            Button("Cancelar", role: .cancel) { draftName = "" }
        } message: { Text("Este campo aparecerá en la info de todos los contactos.") }
        .alert("No se guardó", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("Entendido", role: .cancel) {}
        } message: { Text(errorMessage ?? "") }
        .confirmationDialog("Eliminar campo", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Eliminar", role: .destructive) { if let field = pendingDelete { Task { await deleteField(field) } } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("Se borrará el campo y sus datos guardados en todos los contactos.") }
    }

    @ViewBuilder
    private func content(fields: [ContactCustomFieldDefinition]) -> some View {
        if fields.isEmpty {
            RistakEmptyState(
                icon: "checklist",
                title: "Campos personalizados",
                message: "Todavía no hay campos personalizados guardados."
            )
        } else {
            SettingsPanelScroll {
                Text("Elige qué datos quieres ver en la info de cada contacto.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, RistakTheme.Spacing.xxs)

                SectionCard {
                    VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
                        Text("Todos aparecen en la info del contacto")
                            .font(.headline)
                            .foregroundStyle(RistakTheme.textPrimary)
                        Text("El chat móvil muestra el catálogo completo, agrupado por carpeta, y cada campo se edita desde la ficha del contacto.")
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                ForEach(groupedFolders(fields), id: \.name) { folder in
                    SectionCard(title: folder.name) {
                        VStack(spacing: 0) {
                            ForEach(Array(folder.fields.enumerated()), id: \.element.id) { index, field in
                                fieldRow(field)
                                if index < folder.fields.count - 1 {
                                    Divider().padding(.vertical, RistakTheme.Spacing.xs)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private struct FolderGroup {
        let name: String
        let fields: [ContactCustomFieldDefinition]
    }

    /// Agrupa por `folderName` conservando el orden del backend; carpeta vacía
    /// → «Campos personalizados» (doc 10 §5.1).
    private func groupedFolders(_ fields: [ContactCustomFieldDefinition]) -> [FolderGroup] {
        var order: [String] = []
        var buckets: [String: [ContactCustomFieldDefinition]] = [:]
        for field in fields {
            let name = field.folderName.isEmpty ? "Campos personalizados" : field.folderName
            if buckets[name] == nil { order.append(name) }
            buckets[name, default: []].append(field)
        }
        return order.map { FolderGroup(name: $0, fields: buckets[$0] ?? []) }
    }

    /// `<tipo> · <key>` (tipo con fallback `text`).
    private func fieldDetail(_ field: ContactCustomFieldDefinition) -> String {
        let type = field.dataType.isEmpty ? "text" : field.dataType
        let key = field.fieldKey.isEmpty ? field.key : field.fieldKey
        guard !key.isEmpty else { return type }
        return "\(type) · \(key)"
    }

    private func fieldRow(_ field: ContactCustomFieldDefinition) -> some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(field.label.isEmpty ? field.name : field.label)
                    .font(.body)
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(2)

                Text(fieldDetail(field))
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            if field.deletable {
                Button(role: .destructive) { pendingDelete = field } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Eliminar \(field.label)")
            }
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
    }

    private func createField() async {
        busy = true
        defer { busy = false }
        do {
            try await model.createCustomField(label: draftName)
            draftName = ""
        } catch {
            errorMessage = (error as? RistakAPIError)?.message ?? "No se pudo crear el campo."
        }
    }

    private func deleteField(_ field: ContactCustomFieldDefinition) async {
        do { try await model.deleteCustomField(field) }
        catch { errorMessage = (error as? RistakAPIError)?.message ?? "No se pudo eliminar el campo." }
    }
}

struct SettingsTagsPanel: View {
    @Environment(SettingsModel.self) private var model
    @State private var showCreate = false
    @State private var draftName = ""
    @State private var errorMessage: String?
    @State private var pendingDelete: ContactTag?

    var body: some View {
        SettingsLoadStateView(state: model.tags, loadingMessage: "Cargando etiquetas...", retry: { Task { await model.loadTags() } }) { tags in
            SettingsPanelScroll {
                if tags.isEmpty {
                    RistakEmptyState(icon: "tag", title: "Etiquetas", message: "Todavía no hay etiquetas creadas.")
                } else {
                    SectionCard(title: "Etiquetas") {
                        VStack(spacing: 0) {
                            ForEach(tags) { tag in
                                HStack {
                                    Text(tag.name).frame(maxWidth: .infinity, alignment: .leading)
                                    Button(role: .destructive) { pendingDelete = tag } label: { Image(systemName: "trash") }
                                        .buttonStyle(.plain)
                                        .accessibilityLabel("Eliminar \(tag.name)")
                                }
                                .padding(.vertical, RistakTheme.Spacing.xs)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Etiquetas")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button { showCreate = true } label: { Label("Crear etiqueta", systemImage: "plus") } }
        .refreshable { await model.loadTags() }
        .alert("Nueva etiqueta", isPresented: $showCreate) {
            TextField("Nombre de la etiqueta", text: $draftName)
            Button("Crear") { Task { await createTag() } }.disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancelar", role: .cancel) { draftName = "" }
        }
        .alert("No se guardó", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("Entendido", role: .cancel) {}
        } message: { Text(errorMessage ?? "") }
        .confirmationDialog("Eliminar etiqueta", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Eliminar", role: .destructive) { if let tag = pendingDelete { Task { await deleteTag(tag) } } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("Se quitará la etiqueta de todos los contactos.") }
    }

    private func createTag() async {
        do { try await model.createTag(name: draftName); draftName = "" }
        catch { errorMessage = (error as? RistakAPIError)?.message ?? "No se pudo crear la etiqueta." }
    }

    private func deleteTag(_ tag: ContactTag) async {
        do { try await model.deleteTag(tag) }
        catch { errorMessage = (error as? RistakAPIError)?.message ?? "No se pudo eliminar la etiqueta." }
    }
}
