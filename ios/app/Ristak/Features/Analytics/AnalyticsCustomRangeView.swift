import SwiftUI

/// Selector de rango personalizado (doc 09 §7.1). En nativo se usan date
/// pickers del sistema (recomendación doc 14 §9.5) manteniendo la validación
/// «La fecha inicial no puede ser mayor que la final.». Los días se
/// interpretan en la zona horaria del NEGOCIO.
struct AnalyticsCustomRangeView: View {
    let timeZone: TimeZone
    /// Aplica el rango; devuelve el mensaje de error de validación o nil.
    let onApply: (Date, Date) -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var startDate: Date
    @State private var endDate: Date
    @State private var errorMessage: String?

    init(
        timeZone: TimeZone,
        initialRange: AnalyticsDateRange?,
        onApply: @escaping (Date, Date) -> String?
    ) {
        self.timeZone = timeZone
        self.onApply = onApply

        let fallbackEnd = Date()
        let fallbackStart = Calendar(identifier: .gregorian)
            .date(byAdding: .day, value: -29, to: fallbackEnd) ?? fallbackEnd
        _startDate = State(initialValue: Self.businessDate(fromISO: initialRange?.startDate, timeZone: timeZone) ?? fallbackStart)
        _endDate = State(initialValue: Self.businessDate(fromISO: initialRange?.endDate, timeZone: timeZone) ?? fallbackEnd)
    }

    var body: some View {
        SheetScaffold(title: "Fecha personalizada", subtitle: "Rango de analíticas") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.md) {
                DatePicker("Inicio", selection: $startDate, displayedComponents: .date)
                    .font(.body)

                DatePicker("Fin", selection: $endDate, displayedComponents: .date)
                    .font(.body)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.neg)
                }

                Button {
                    if let failure = onApply(startDate, endDate) {
                        errorMessage = failure
                    } else {
                        dismiss()
                    }
                } label: {
                    Text("Aplicar rango")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Button {
                    dismiss()
                } label: {
                    Text("Cancelar")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .padding(.horizontal, RistakTheme.Spacing.lg)
            .padding(.bottom, RistakTheme.Spacing.lg)
        }
        // Los pickers muestran el día en la zona del negocio, no la del
        // dispositivo (regla dura de fechas).
        .environment(\.timeZone, timeZone)
        .frame(minWidth: 320)
    }

    /// `YYYY-MM-DD` (día de negocio) → Date al mediodía de esa zona, para que
    /// el picker muestre el día correcto sin corrimientos.
    private static func businessDate(fromISO iso: String?, timeZone: TimeZone) -> Date? {
        guard let iso else { return nil }
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: components)
    }
}
