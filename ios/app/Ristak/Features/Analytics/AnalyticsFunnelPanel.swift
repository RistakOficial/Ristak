import SwiftUI

/// Panel «Embudo» (doc 09 §7.4): 5 etapas con icono, valor, barra de progreso
/// y conversión desde el paso anterior; pill con la conversión total y
/// segmented de scope Todos / Al registro / Anuncios.
struct AnalyticsFunnelPanel: View {
    let model: AnalyticsViewModel
    let formatters: BusinessFormatters

    /// Iconos en orden fijo (lucide Users/Target/CalendarDays/CheckCircle2/
    /// DollarSign → SF Symbols).
    private static let stageIcons = [
        "person.2",
        "target",
        "calendar",
        "checkmark.circle",
        "dollarsign.circle",
    ]

    var body: some View {
        SectionCard(title: "Embudo") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Conversiones")
                        .font(.title3.bold())
                        .foregroundStyle(RistakTheme.textPrimary)

                    Spacer(minLength: RistakTheme.Spacing.xs)

                    AnalyticsHeaderPill(text: model.funnelConversionLabel)
                }

                scopeChips

                content
            }
        }
    }

    private var scopeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(DashboardScope.allCases, id: \.rawValue) { scope in
                    RistakFilterChip(
                        title: scope.displayLabel,
                        isSelected: model.funnelScope == scope
                    ) {
                        model.selectFunnelScope(scope)
                    }
                }
            }
        }
        .ristakEdgeToEdgeChips(horizontalInset: RistakTheme.Spacing.md)
        .padding(.horizontal, -RistakTheme.Spacing.md)
    }

    @ViewBuilder
    private var content: some View {
        if model.funnel.isLoading {
            AnalyticsPanelLoadingView(accessibilityLabel: "Cargando embudo")
        } else if let message = model.funnel.errorMessage {
            AnalyticsPanelErrorView(message: message) {
                Task { await model.retryFunnel() }
            }
        } else {
            let rows = model.funnelDisplayRows
            let maxValue = max(1, rows.map(\.value).max() ?? 1)
            VStack(spacing: RistakTheme.Spacing.md) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    stageRow(
                        index: index,
                        row: row,
                        previousValue: index > 0 ? rows[index - 1].value : nil,
                        maxValue: maxValue
                    )
                }
            }
            .padding(.top, RistakTheme.Spacing.xxs)
        }
    }

    private func stageRow(
        index: Int,
        row: DashboardFunnelRow,
        previousValue: Double?,
        maxValue: Double
    ) -> some View {
        HStack(alignment: .top, spacing: RistakTheme.Spacing.sm) {
            Image(systemName: Self.stageIcons[min(index, Self.stageIcons.count - 1)])
                .font(.footnote.weight(.semibold))
                .foregroundStyle(RistakTheme.accent)
                .frame(width: 30, height: 30)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                        .fill(RistakTheme.accentSoft)
                )

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.stage)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)

                    Spacer(minLength: RistakTheme.Spacing.xs)

                    Text(formatters.wholeNumber(row.value))
                        .font(.subheadline.bold())
                        .monospacedDigit()
                        .foregroundStyle(RistakTheme.textPrimary)
                }

                AnalyticsBar(fraction: row.value / maxValue)

                // Desde la fila 2: «X.X% desde el paso anterior» (omitido si
                // la etapa previa es 0).
                if let previousValue, previousValue > 0 {
                    Text("\(String(format: "%.1f", row.value / previousValue * 100))% desde el paso anterior")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textMute)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
