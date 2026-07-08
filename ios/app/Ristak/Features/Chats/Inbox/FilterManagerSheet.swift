import SwiftUI

/// Sheet «Filtros» (chip «+», doc research/03 §3.5): biblioteca por secciones
/// (Rápidos, Números, Canal, Origen, Red social, Etapa, Actividad,
/// Condicionales) con Agregar/Quitar inmediato sobre
/// `mobile_chat_filter_chip_ids` y «Restaurar filtros base».
///
/// Los presets condicionales se crean/editan aquí mismo (paridad /movil): el
/// botón «Crear filtro condicional» abre el editor de campo+operador+valor y
/// guarda en `mobile_chat_custom_filter_presets`; también se pueden editar y
/// borrar los existentes.
struct FilterManagerSheet: View {
    let viewModel: InboxViewModel

    @Environment(\.dismiss) private var dismiss
    @State private var presetPendingDelete: ChatFilterPreset?
    @State private var editorDraft: ChatCustomFilterDraft?

    var body: some View {
        SheetScaffold(title: "Filtros", subtitle: "Elige los chips visibles de la bandeja") {
            List {
                Section {
                    Button {
                        editorDraft = viewModel.makeNewFilterDraft()
                    } label: {
                        Label("Crear filtro condicional", systemImage: "plus.circle.fill")
                            .font(.body.weight(.medium))
                            .foregroundStyle(RistakTheme.accent)
                    }
                } footer: {
                    Text("Arma tus propias combinaciones (segmento, etiquetas, canal, campos…) y guárdalas como un chip.")
                }

                ForEach(viewModel.managerSections) { section in
                    Section(section.title) {
                        ForEach(section.entries) { entry in
                            entryRow(entry)
                        }
                    }
                }

                Section {
                    Button {
                        viewModel.restoreBaseChips()
                    } label: {
                        Label("Restaurar filtros base", systemImage: "arrow.counterclockwise")
                            .foregroundStyle(RistakTheme.accent)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
        .sheet(item: $editorDraft) { draft in
            CustomFilterEditorView(viewModel: viewModel, draft: draft)
                .presentationDetents([.large])
        }
        .confirmationDialog(
            "¿Borrar este filtro condicional?",
            isPresented: deleteDialogBinding,
            titleVisibility: .visible,
            presenting: presetPendingDelete
        ) { preset in
            Button("Borrar \"\(preset.label)\"", role: .destructive) {
                viewModel.deletePreset(id: preset.id)
            }
            Button("Cancelar", role: .cancel) {}
        } message: { _ in
            Text("También se quitará de los chips visibles.")
        }
    }

    @ViewBuilder
    private func entryRow(_ entry: ChatFilterManagerEntry) -> some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(.body)
                    .foregroundStyle(RistakTheme.textPrimary)

                if !entry.subtitle.isEmpty {
                    Text(entry.subtitle)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            if entry.isLocked {
                Text("Fijo")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(RistakTheme.controlRest))
            } else {
                Button(entry.isVisible ? "Quitar" : "Agregar") {
                    viewModel.setChipVisible(entry.chipID, visible: !entry.isVisible)
                }
                .font(.subheadline.weight(.medium))
                .buttonStyle(.bordered)
                .tint(entry.isVisible ? RistakTheme.neg : RistakTheme.accent)
            }

            if entry.isDeletablePreset {
                let presetID = String(entry.chipID.dropFirst("custom:".count))

                Button {
                    if let preset = viewModel.customPresets.first(where: { $0.id == presetID }) {
                        editorDraft = viewModel.makeEditDraft(for: preset)
                    }
                } label: {
                    Image(systemName: "pencil")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Editar filtro \(entry.title)")

                Button {
                    presetPendingDelete = viewModel.customPresets.first { $0.id == presetID }
                } label: {
                    Image(systemName: "trash")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.neg)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Borrar filtro \(entry.title)")
            }
        }
    }

    private var deleteDialogBinding: Binding<Bool> {
        Binding(
            get: { presetPendingDelete != nil },
            set: { if !$0 { presetPendingDelete = nil } }
        )
    }
}
