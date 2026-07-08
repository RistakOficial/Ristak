import SwiftUI

/// Editor de filtros condicionales (paridad /movil, App.tsx filterEditor
/// líneas 13527-13623): el usuario arma sus propias combinaciones —campo +
/// operador + valor(es)— les pone nombre y las guarda en
/// `mobile_chat_custom_filter_presets`. Sirve para crear o editar.
struct CustomFilterEditorView: View {
    let viewModel: InboxViewModel
    @State var draft: ChatCustomFilterDraft

    @Environment(\.dismiss) private var dismiss
    @State private var errorMessage: String? = nil

    var body: some View {
        SheetScaffold(
            title: draft.isEditing ? "Editar filtro" : "Nuevo filtro",
            subtitle: "Arma tus condiciones y ponle nombre"
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                    nameBlock
                    matchBlock

                    ForEach(Array(draft.rules.enumerated()), id: \.element.id) { index, rule in
                        ruleBlock(rule, index: index)
                    }

                    addRuleButton
                    footer
                }
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.top, RistakTheme.Spacing.xs)
                .padding(.bottom, RistakTheme.Spacing.xxl)
            }
        }
        .task { await viewModel.ensureTagsLoaded() }
        .alert("Filtro", isPresented: errorBinding) {
            Button("Entendido", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    // MARK: - Nombre

    private var nameBlock: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            fieldLabel("Nombre")
            TextField("Ej. Clientes de mi WhatsApp", text: $draft.label)
                .font(.body)
                .textInputAutocapitalization(.sentences)
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, 11)
                .background(inputBackground)
        }
    }

    // MARK: - Coincidencia (todas / cualquiera)

    private var matchBlock: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            fieldLabel("Coincidir")
            HStack(spacing: RistakTheme.Spacing.xs) {
                RistakFilterChip(title: "Todas", isSelected: draft.matchAll) {
                    draft.matchAll = true
                }
                RistakFilterChip(title: "Cualquiera", isSelected: !draft.matchAll) {
                    draft.matchAll = false
                }
            }
        }
    }

    // MARK: - Regla

    @ViewBuilder
    private func ruleBlock(_ rule: ChatCustomFilterDraftRule, index: Int) -> some View {
        let field = viewModel.conditionField(forKey: rule.field)
        let operators = ChatConditionOperators.forField(field)

        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            HStack {
                Text("Condición \(index + 1)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                Spacer()
                if draft.rules.count > 1 {
                    Button {
                        viewModel.removeRule(from: &draft, ruleID: rule.id)
                    } label: {
                        Image(systemName: "trash")
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.neg)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Quitar condición \(index + 1)")
                }
            }

            fieldLabel("Campo")
            optionChips(
                options: viewModel.conditionFields.map { ChatConditionOption(value: $0.key, label: $0.label) },
                selected: rule.field
            ) { key in
                viewModel.changeRuleField(in: &draft, ruleID: rule.id, fieldKey: key)
            }

            fieldLabel("Condición")
            optionChips(
                options: operators.map { ChatConditionOption(value: $0.value, label: $0.label) },
                selected: rule.op
            ) { op in
                viewModel.changeRuleOperator(in: &draft, ruleID: rule.id, op: op)
            }

            fieldLabel("Valor")
            valueEditor(rule: rule, field: field)
        }
        .padding(RistakTheme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                .fill(RistakTheme.surface)
        )
    }

    // MARK: - Editor de valor

    @ViewBuilder
    private func valueEditor(rule: ChatCustomFilterDraftRule, field: ChatConditionField?) -> some View {
        if field == nil || !ChatConditionOperators.needsValue(rule.op) {
            Text("Sin valor adicional")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textMute)
        } else if let field, !field.options.isEmpty {
            optionChips(options: field.options, selected: rule.value) { value in
                setValue(value, for: rule.id)
            }
        } else if field?.type == .tags {
            Text("No hay etiquetas disponibles todavía.")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textMute)
        } else if ChatConditionOperators.usesRange(rule.op) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                valueTextField(placeholder: "Desde", binding: valueBinding(for: rule.id), numeric: field?.type == .number)
                valueTextField(placeholder: "Hasta", binding: valueToBinding(for: rule.id), numeric: field?.type == .number)
            }
        } else {
            valueTextField(
                placeholder: field?.type == .number ? "0" : "Valor",
                binding: valueBinding(for: rule.id),
                numeric: field?.type == .number
            )
        }
    }

    private func valueTextField(placeholder: String, binding: Binding<String>, numeric: Bool) -> some View {
        TextField(placeholder, text: binding)
            .font(.body)
            .keyboardType(numeric ? .decimalPad : .default)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .padding(.vertical, 10)
            .background(inputBackground)
    }

    // MARK: - Chips de opciones (selección única)

    private func optionChips(
        options: [ChatConditionOption],
        selected: String,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(options) { option in
                    RistakFilterChip(title: option.label, isSelected: option.value == selected) {
                        onSelect(option.value)
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    // MARK: - Acciones

    private var addRuleButton: some View {
        Button {
            viewModel.addRule(to: &draft)
        } label: {
            Label("Agregar condición", systemImage: "plus")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.controlRest)
                )
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Button {
                dismiss()
            } label: {
                Text("Cancelar")
                    .font(.body.weight(.medium))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                            .fill(RistakTheme.controlRest)
                    )
            }
            .buttonStyle(.plain)

            Button {
                save()
            } label: {
                Text("Guardar filtro")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                            .fill(RistakTheme.accent)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(.top, RistakTheme.Spacing.xs)
    }

    private func save() {
        if let message = viewModel.saveCustomPreset(draft) {
            errorMessage = message
        } else {
            dismiss()
        }
    }

    // MARK: - Helpers

    private func setValue(_ value: String, for ruleID: String) {
        guard let index = draft.rules.firstIndex(where: { $0.id == ruleID }) else { return }
        draft.rules[index].value = value
    }

    private func valueBinding(for ruleID: String) -> Binding<String> {
        Binding(
            get: { draft.rules.first { $0.id == ruleID }?.value ?? "" },
            set: { newValue in
                if let index = draft.rules.firstIndex(where: { $0.id == ruleID }) {
                    draft.rules[index].value = newValue
                }
            }
        )
    }

    private func valueToBinding(for ruleID: String) -> Binding<String> {
        Binding(
            get: { draft.rules.first { $0.id == ruleID }?.valueTo ?? "" },
            set: { newValue in
                if let index = draft.rules.firstIndex(where: { $0.id == ruleID }) {
                    draft.rules[index].valueTo = newValue
                }
            }
        )
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(RistakTheme.textDim)
    }

    private var inputBackground: some View {
        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
            .fill(RistakTheme.controlBackground)
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )
    }
}
