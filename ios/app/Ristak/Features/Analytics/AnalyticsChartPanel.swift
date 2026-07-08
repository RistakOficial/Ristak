import SwiftUI
import Charts

// MARK: - Colores por vista (doc 09 §7.3, mapeados a tokens/colores de sistema)

extension AnalyticsChartKind {
    /// Serie 1. Semántica /movil: accent = ingresos/labels, azul = visitantes,
    /// ámbar = citas. Mapeo nativo: accent → `RistakTheme.accent`,
    /// azul → `.indigo` (distinguible del accent), ámbar → `RistakTheme.warn`.
    var color1: Color {
        switch self {
        case .revenueSpend: return RistakTheme.accent
        case .visitorsLeads: return .indigo
        case .leadsAppointments: return RistakTheme.accent
        case .appointmentsAttendances: return RistakTheme.warn
        case .attendancesSales: return .indigo
        }
    }

    /// Serie 2. El «contraste» (#101010 de /movil) se mapea a `textPrimary`
    /// (negro en claro / blanco en oscuro).
    var color2: Color {
        switch self {
        case .revenueSpend: return RistakTheme.textPrimary
        case .visitorsLeads: return RistakTheme.accent
        case .leadsAppointments: return RistakTheme.warn
        case .appointmentsAttendances: return .indigo
        case .attendancesSales: return RistakTheme.accent
        }
    }
}

// MARK: - Panel "Gráfica"

/// Panel de la gráfica principal: H2 con la vista activa, chips de las 5
/// vistas, segmented de scope (solo Ingresos vs gastos), leyenda y la gráfica
/// de doble línea (doc 09 §7.3).
struct AnalyticsChartPanel: View {
    let model: AnalyticsViewModel
    let formatters: BusinessFormatters

    var body: some View {
        SectionCard(title: "Gráfica") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                Text(model.chartKind.title(labels: model.labels))
                    .font(.title3.bold())
                    .foregroundStyle(RistakTheme.textPrimary)

                viewChips

                if model.chartKind.showsScope {
                    scopeChips
                }

                legend

                chartContent
            }
        }
    }

    // MARK: Chips de vistas (selección = relleno sólido de acento)

    private var viewChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(AnalyticsChartKind.allCases) { kind in
                    RistakFilterChip(
                        title: kind.title(labels: model.labels),
                        isSelected: model.chartKind == kind
                    ) {
                        model.selectChartKind(kind)
                    }
                }
            }
        }
    }

    private var scopeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(DashboardScope.allCases, id: \.rawValue) { scope in
                    RistakFilterChip(
                        title: scope.displayLabel,
                        isSelected: model.financialScope == scope
                    ) {
                        model.selectFinancialScope(scope)
                    }
                }
            }
        }
    }

    // MARK: Leyenda + escala superior

    private var legend: some View {
        let labels = model.chartKind.legendLabels(labels: model.labels)
        return HStack(spacing: RistakTheme.Spacing.md) {
            legendItem(color: model.chartKind.color1, label: labels.0)
            legendItem(color: model.chartKind.color2, label: labels.1)

            Spacer(minLength: RistakTheme.Spacing.xs)

            if !model.chart.isLoading, !model.chartIsEmpty {
                Text(maxScaleLabel)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textMute)
            }
        }
    }

    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.caption)
                .foregroundStyle(RistakTheme.textDim)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    /// Valor máximo en formato compacto (`$152.3 k` / `4.2 k`).
    private var maxScaleLabel: String {
        model.chartKind.isCurrency
            ? formatters.compactCurrency(model.chartMaxValue)
            : formatters.compactNumber(model.chartMaxValue)
    }

    // MARK: Contenido

    @ViewBuilder
    private var chartContent: some View {
        if model.chart.isLoading {
            ProgressView()
                .controlSize(.regular)
                .frame(maxWidth: .infinity, minHeight: 190)
                .accessibilityLabel("Cargando gráfica")
        } else if let message = model.chart.errorMessage {
            AnalyticsPanelErrorView(message: message) {
                Task { await model.retryChart() }
            }
        } else if model.chartIsEmpty {
            Text("Sin datos para este periodo.")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
                .frame(maxWidth: .infinity, minHeight: 190)
        } else {
            AnalyticsDualLineChart(
                points: model.chartPoints,
                color1: model.chartKind.color1,
                color2: model.chartKind.color2
            )
        }
    }
}

// MARK: - Gráfica de doble línea (Swift Charts)

/// Dos polylines con punto en cada muestra, 3 gridlines horizontales
/// (25/50/75 %), eje X con 3 etiquetas (primera, central, última) y escala Y
/// desde 0 hasta el máximo de ambas series (paridad del SVG de /movil).
struct AnalyticsDualLineChart: View {
    let points: [AnalyticsChartPoint]
    let color1: Color
    let color2: Color

    private var maxY: Double {
        max(1, points.flatMap { [$0.value1, $0.value2] }.max() ?? 1)
    }

    /// Índices del eje X: primera, central y última muestra (sin duplicados).
    private var axisIndices: [Double] {
        guard !points.isEmpty else { return [] }
        let last = points.count - 1
        return Set([0, last / 2, last]).sorted().map(Double.init)
    }

    var body: some View {
        Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                LineMark(
                    x: .value("Fecha", Double(index)),
                    y: .value("Valor", point.value1),
                    series: .value("Serie", "serie-1")
                )
                .foregroundStyle(color1)
                .lineStyle(StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.linear)

                PointMark(
                    x: .value("Fecha", Double(index)),
                    y: .value("Valor", point.value1)
                )
                .foregroundStyle(color1)
                .symbolSize(24)

                LineMark(
                    x: .value("Fecha", Double(index)),
                    y: .value("Valor", point.value2),
                    series: .value("Serie", "serie-2")
                )
                .foregroundStyle(color2)
                .lineStyle(StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.linear)

                PointMark(
                    x: .value("Fecha", Double(index)),
                    y: .value("Valor", point.value2)
                )
                .foregroundStyle(color2)
                .symbolSize(24)
            }
        }
        .chartLegend(.hidden)
        .chartYScale(domain: 0...maxY)
        // Con 1 solo punto el dominio -0.5…0.5 lo deja centrado (paridad /movil).
        .chartXScale(domain: -0.5...(Double(max(points.count, 1)) - 0.5))
        .chartYAxis {
            AxisMarks(values: [maxY * 0.25, maxY * 0.5, maxY * 0.75]) { _ in
                AxisGridLine()
                    .foregroundStyle(RistakTheme.border.opacity(0.6))
            }
        }
        .chartXAxis {
            AxisMarks(values: axisIndices) { value in
                AxisValueLabel {
                    if let raw = value.as(Double.self) {
                        Text(axisLabel(at: Int(raw.rounded())))
                            .font(.caption2)
                            .foregroundStyle(RistakTheme.textMute)
                    }
                }
            }
        }
        .frame(height: 190)
        .accessibilityLabel("Gráfica de doble línea")
    }

    private func axisLabel(at index: Int) -> String {
        guard points.indices.contains(index) else { return "" }
        return AnalyticsViewModel.chartAxisLabel(points[index].label)
    }
}
