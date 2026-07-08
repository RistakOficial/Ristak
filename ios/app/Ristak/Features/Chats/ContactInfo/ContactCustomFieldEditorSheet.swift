import SwiftUI

/// Editor tipado de un campo personalizado (doc 06 §1.4 y §4.1.10).
/// Tipos soportados: text, textarea, number, currency, dropdown, radio,
/// checkboxes, date, datetime, time, email, phone, url, checkbox, boolean,
/// json (los alias ya llegan normalizados por `normalizeDataType`).
struct ContactCustomFieldEditorSheet: View {
    let row: ContactInfoViewModel.CustomFieldRow
    let formatters: BusinessFormatters
    /// Devuelve `nil` en éxito o el mensaje de error a pintar inline.
    let onSave: (RistakJSONValue) async -> String?

    @Environment(\.dismiss) private var dismiss

    @State private var textValue = ""
    @State private var boolValue = false
    @State private var dateValue = Date()
    @State private var selectedOption = ""
    @State private var selectedMulti: Set<String> = []

    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var didLoadInitialValue = false

    var body: some View {
        SheetScaffold(title: row.label) {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.md) {
                editorControl

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.neg)
                }

                saveButton
            }
            .padding(.horizontal, RistakTheme.Spacing.lg)
            .padding(.bottom, RistakTheme.Spacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .onAppear {
            loadInitialValue()
        }
    }

    // MARK: - Control por tipo

    @ViewBuilder
    private var editorControl: some View {
        switch row.dataType {
        case "textarea", "json":
            TextEditor(text: $textValue)
                .font(row.dataType == "json" ? .callout.monospaced() : .callout)
                .frame(minHeight: 120)
                .scrollContentBackground(.hidden)
                .padding(RistakTheme.Spacing.xs)
                .background(fieldBackground)

        case "number", "currency":
            TextField("Sin dato", text: $textValue)
                .keyboardType(.decimalPad)
                .font(.body)
                .padding(RistakTheme.Spacing.sm)
                .background(fieldBackground)

        case "date":
            DatePicker("Fecha", selection: $dateValue, displayedComponents: [.date])
                .datePickerStyle(.graphical)
                .environment(\.timeZone, formatters.timeZone)
                .environment(\.locale, BusinessFormatters.locale)

        case "datetime":
            DatePicker("Fecha y hora", selection: $dateValue, displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.compact)
                .environment(\.timeZone, formatters.timeZone)
                .environment(\.locale, BusinessFormatters.locale)

        case "time":
            DatePicker("Hora", selection: $dateValue, displayedComponents: [.hourAndMinute])
                .datePickerStyle(.wheel)
                .labelsHidden()
                .environment(\.timeZone, formatters.timeZone)
                .environment(\.locale, BusinessFormatters.locale)
                .frame(maxWidth: .infinity)

        case "dropdown", "radio":
            optionList(multi: false)

        case "checkboxes":
            optionList(multi: true)

        case "checkbox", "boolean":
            Toggle(isOn: $boolValue) {
                Text(row.label)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textPrimary)
            }

        case "email":
            TextField("correo@ejemplo.com", text: $textValue)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body)
                .padding(RistakTheme.Spacing.sm)
                .background(fieldBackground)

        case "phone":
            TextField("+52...", text: $textValue)
                .keyboardType(.phonePad)
                .font(.body)
                .padding(RistakTheme.Spacing.sm)
                .background(fieldBackground)

        case "url":
            TextField("https://", text: $textValue)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body)
                .padding(RistakTheme.Spacing.sm)
                .background(fieldBackground)

        default:
            // text y tipos no editables en móvil (file...): campo de texto plano.
            TextField("Sin dato", text: $textValue)
                .font(.body)
                .padding(RistakTheme.Spacing.sm)
                .background(fieldBackground)
        }
    }

    private var fieldBackground: some View {
        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
            .fill(RistakTheme.controlBackground)
    }

    private func optionList(multi: Bool) -> some View {
        VStack(spacing: 0) {
            if !multi {
                optionRow(label: "Sin selección", isSelected: selectedOption.isEmpty) {
                    selectedOption = ""
                }
                Divider().overlay(RistakTheme.border.opacity(0.5))
            }

            ForEach(Array(row.options.enumerated()), id: \.offset) { index, option in
                optionRow(
                    label: option.label.isEmpty ? option.value : option.label,
                    isSelected: multi ? selectedMulti.contains(option.value) : selectedOption == option.value
                ) {
                    if multi {
                        if selectedMulti.contains(option.value) {
                            selectedMulti.remove(option.value)
                        } else {
                            selectedMulti.insert(option.value)
                        }
                    } else {
                        selectedOption = option.value
                    }
                }

                if index < row.options.count - 1 {
                    Divider().overlay(RistakTheme.border.opacity(0.5))
                }
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .background(fieldBackground)
    }

    private func optionRow(label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textPrimary)

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.accent)
                }
            }
            .padding(.vertical, RistakTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            if isSaving {
                ProgressView()
                    .frame(maxWidth: .infinity)
            } else {
                Text("Guardar")
                    .frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(isSaving)
    }

    // MARK: - Carga inicial

    private func loadInitialValue() {
        guard !didLoadInitialValue else { return }
        didLoadInitialValue = true

        let value = row.value?.value

        switch row.dataType {
        case "checkbox", "boolean":
            boolValue = value?.boolValue ?? false

        case "dropdown", "radio":
            selectedOption = value?.configStringValue ?? ""

        case "checkboxes":
            selectedMulti = Set(ContactInfoCustomFieldValueFormat.selectedValues(value))

        case "date", "datetime":
            dateValue = Self.parseDate(value?.configStringValue, timeZone: formatters.timeZone) ?? Date()

        case "time":
            dateValue = Self.parseTime(value?.configStringValue, timeZone: formatters.timeZone) ?? Date()

        default:
            textValue = value?.configStringValue ?? ""
        }
    }

    /// `yyyy-MM-dd` se interpreta a las 12:00 en la TZ del negocio (evita el
    /// corrimiento de día al mostrar); strings con hora se parsean normal.
    private static func parseDate(_ raw: String?, timeZone: TimeZone) -> Date? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if raw.count == 10, !raw.contains("T"), !raw.contains(" ") {
            let parts = raw.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return RistakDateParsing.date(fromISO: raw) }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
        }
        return RistakDateParsing.date(fromISO: raw)
    }

    /// `HH:mm` → hoy a esa hora en la TZ del negocio.
    private static func parseTime(_ raw: String?, timeZone: TimeZone) -> Date? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let parts = raw.split(separator: ":").compactMap { Int($0) }
        guard parts.count >= 2 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = calendar.dateComponents([.year, .month, .day], from: Date())
        components.hour = parts[0]
        components.minute = parts[1]
        return calendar.date(from: components)
    }

    // MARK: - Guardado

    private func save() async {
        errorMessage = nil

        guard let newValue = buildValue() else { return }

        isSaving = true
        let error = await onSave(newValue)
        isSaving = false

        if let error {
            errorMessage = error
        } else {
            dismiss()
        }
    }

    /// Serializa el estado del editor al valor canónico. `nil` = validación
    /// fallida (el mensaje ya quedó en `errorMessage`).
    private func buildValue() -> RistakJSONValue? {
        switch row.dataType {
        case "number", "currency":
            let trimmed = textValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return .string("") }
            let normalized = trimmed.replacingOccurrences(of: ",", with: ".")
            guard let number = Double(normalized), number.isFinite else {
                errorMessage = "Ese campo espera un número válido."
                return nil
            }
            return .number(number)

        case "json":
            let trimmed = textValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return .string("") }
            guard let data = trimmed.data(using: .utf8),
                  let parsed = try? JSONDecoder().decode(RistakJSONValue.self, from: data) else {
                errorMessage = "Ese campo espera JSON válido."
                return nil
            }
            return parsed

        case "checkbox", "boolean":
            return .bool(boolValue)

        case "dropdown", "radio":
            return .string(selectedOption)

        case "checkboxes":
            // Conserva el orden del catálogo de opciones.
            let ordered = row.options.map(\.value).filter { selectedMulti.contains($0) }
            return .array(ordered.map { .string($0) })

        case "date":
            return .string(RistakDateParsing.businessDateString(from: dateValue, timeZone: formatters.timeZone))

        case "datetime":
            return .string(RistakDateParsing.isoString(from: dateValue))

        case "time":
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = formatters.timeZone
            let parts = calendar.dateComponents([.hour, .minute], from: dateValue)
            return .string(String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0))

        default:
            return .string(textValue.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}
