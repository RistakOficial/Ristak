import SwiftUI

/// Panel «Campos personalizados» (doc 10 §5.1 `renderCustomFields`): catálogo
/// SOLO LECTURA de `GET /api/contacts/custom-fields`, agrupado por carpeta.
struct SettingsCustomFieldsPanel: View {
    @Environment(SettingsModel.self) private var model

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
        .refreshable { await model.loadCustomFields() }
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

            Image(systemName: "checkmark.circle.fill")
                .font(.body)
                .foregroundStyle(RistakTheme.accent)
                .accessibilityHidden(true)
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
    }
}
