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
        .ristakContainedEdgeToEdgeChips()
        .padding(.horizontal, -RistakTheme.Spacing.md)
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
        .ristakContainedEdgeToEdgeChips()
        .padding(.horizontal, -RistakTheme.Spacing.md)
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

    /// Techo visible en formato compacto (`$152.3 k` / `4.2 k`).
    private var maxScaleLabel: String {
        let upperBound = AnalyticsChartScale.upperBound(for: model.chartPoints)
        return model.chartKind.isCurrency
            ? formatters.compactCurrency(upperBound)
            : formatters.compactNumber(upperBound)
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
                color2: model.chartKind.color2,
                legendLabels: model.chartKind.legendLabels(labels: model.labels),
                isCurrency: model.chartKind.isCurrency,
                formatters: formatters
            )
        }
    }
}

// MARK: - Gráfica de doble línea (Swift Charts, estilo Stocks)

/// Dos polylines con relleno degradado (sin puntos visibles), 3 gridlines
/// horizontales (25/50/75 %), eje X con 3 etiquetas (primera, central, última)
/// y 20 % de aire sobre el dato máximo.
///
/// Interacción tipo app Stocks de Apple: al mantener presionado y arrastrar
/// sobre la gráfica aparece una regla vertical + un punto circular sobre cada
/// línea que SIGUEN al dedo, y un callout flotante con la fecha y los valores
/// del punto más cercano. Al soltar, el indicador desaparece.
struct AnalyticsDualLineChart: View {
    let points: [AnalyticsChartPoint]
    let color1: Color
    let color2: Color
    let legendLabels: (String, String)
    let isCurrency: Bool
    let formatters: BusinessFormatters

    /// Índice del punto que el dedo está tocando (nil = sin scrubbing).
    @State private var scrubIndex: Int?

    private var maxY: Double { AnalyticsChartScale.upperBound(for: points) }

    /// Índices del eje X: primera, central y última muestra (sin duplicados).
    private var axisIndices: [Double] {
        guard !points.isEmpty else { return [] }
        let last = points.count - 1
        return Set([0, last / 2, last]).sorted().map(Double.init)
    }

    var body: some View {
        Chart {
            ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                AreaMark(
                    x: .value("Fecha", Double(index)),
                    yStart: .value("Base", 0),
                    yEnd: .value("Valor", point.value1),
                    series: .value("Serie", "serie-1-area")
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [color1.opacity(0.22), color1.opacity(0.02)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.linear)
            }

            ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                AreaMark(
                    x: .value("Fecha", Double(index)),
                    yStart: .value("Base", 0),
                    yEnd: .value("Valor", point.value2),
                    series: .value("Serie", "serie-2-area")
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [color2.opacity(0.16), color2.opacity(0.015)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.linear)
            }

            ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                LineMark(
                    x: .value("Fecha", Double(index)),
                    y: .value("Valor", point.value1),
                    series: .value("Serie", "serie-1")
                )
                .foregroundStyle(color1)
                .lineStyle(StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.linear)

                LineMark(
                    x: .value("Fecha", Double(index)),
                    y: .value("Valor", point.value2),
                    series: .value("Serie", "serie-2")
                )
                .foregroundStyle(color2)
                .lineStyle(StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.linear)
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
        .chartOverlay { proxy in
            GeometryReader { geo in
                if let plotAnchor = proxy.plotFrame {
                    let plotRect = geo[plotAnchor]
                    ZStack(alignment: .topLeading) {
                        // Capa transparente que captura el gesto de scrubbing.
                        Rectangle()
                            .fill(Color.clear)
                            .contentShape(Rectangle())
                            .gesture(scrubGesture(proxy: proxy, plotRect: plotRect))

                        if let index = scrubIndex, points.indices.contains(index) {
                            scrubIndicator(index: index, proxy: proxy, plotRect: plotRect)
                        }
                    }
                }
            }
        }
        // Tick háptico al cruzar a un nuevo punto (y al agarrar/soltar), como Stocks.
        .sensoryFeedback(.selection, trigger: scrubIndex)
        .frame(height: 190)
        .accessibilityLabel("Gráfica de doble línea")
        .accessibilityHint("Mantén presionado y arrastra para ver los valores por fecha.")
    }

    // MARK: Gesto de scrubbing (long-press + arrastre)

    /// Long-press corto encadenado a un arrastre horizontal: no secuestra el
    /// scroll vertical del contenedor; una vez fijado, sigue al dedo en X.
    private func scrubGesture(proxy: ChartProxy, plotRect: CGRect) -> some Gesture {
        LongPressGesture(minimumDuration: 0.18)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
            .onChanged { value in
                guard case .second(true, let drag?) = value else { return }
                if let index = index(forX: drag.location.x, proxy: proxy, plotRect: plotRect) {
                    if index != scrubIndex { scrubIndex = index }
                }
            }
            .onEnded { _ in
                scrubIndex = nil
            }
    }

    /// Convierte la X del dedo (espacio del overlay) al índice del punto más
    /// cercano, acotado a `0...count-1`.
    private func index(forX x: CGFloat, proxy: ChartProxy, plotRect: CGRect) -> Int? {
        guard !points.isEmpty else { return nil }
        let relativeX = x - plotRect.minX
        guard let raw: Double = proxy.value(atX: relativeX) else { return nil }
        let rounded = Int(raw.rounded())
        return min(max(rounded, 0), points.count - 1)
    }

    // MARK: Indicador de scrubbing (regla + puntos + callout)

    @ViewBuilder
    private func scrubIndicator(index: Int, proxy: ChartProxy, plotRect: CGRect) -> some View {
        let point = points[index]
        let pointX = plotRect.minX + (proxy.position(forX: Double(index)) ?? 0)
        let y1 = plotRect.minY + (proxy.position(forY: point.value1) ?? 0)
        let y2 = plotRect.minY + (proxy.position(forY: point.value2) ?? 0)

        // Regla vertical a lo alto del área de la gráfica.
        Rectangle()
            .fill(RistakTheme.textMute)
            .frame(width: 1, height: plotRect.height)
            .position(x: pointX, y: plotRect.midY)

        // Punto circular sobre cada línea (relleno de la serie + anillo de superficie).
        indicatorDot(color: color2, x: pointX, y: y2)
        indicatorDot(color: color1, x: pointX, y: y1)

        // Callout flotante con fecha + valores; sigue al dedo, acotado al área.
        callout(point: point)
            .fixedSize()
            .modifier(CalloutPositioner(pointX: pointX, plotRect: plotRect))
    }

    private func indicatorDot(color: Color, x: CGFloat, y: CGFloat) -> some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
            .overlay(
                Circle().stroke(RistakTheme.surface, lineWidth: 2)
            )
            .position(x: x, y: y)
    }

    private func callout(point: AnalyticsChartPoint) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(AnalyticsViewModel.chartAxisLabel(point.label))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(RistakTheme.textDim)

            calloutRow(color: color1, label: legendLabels.0, value: point.value1)
            calloutRow(color: color2, label: legendLabels.1, value: point.value2)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                .fill(RistakTheme.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                        .stroke(RistakTheme.border, lineWidth: 1)
                )
        )
        .shadow(color: .black.opacity(0.14), radius: 8, x: 0, y: 3)
    }

    private func calloutRow(color: Color, label: String, value: Double) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption2)
                .foregroundStyle(RistakTheme.textDim)
                .lineLimit(1)
            Spacer(minLength: RistakTheme.Spacing.xs)
            Text(valueLabel(value))
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(RistakTheme.textPrimary)
        }
    }

    /// Valor preciso del callout: moneda de la cuenta o entero con separadores.
    private func valueLabel(_ value: Double) -> String {
        isCurrency ? formatters.currency(value) : formatters.wholeNumber(value)
    }

    private func axisLabel(at index: Int) -> String {
        guard points.indices.contains(index) else { return "" }
        return AnalyticsViewModel.chartAxisLabel(points[index].label)
    }
}

/// Escala compartida y comprobable: el punto más alto ocupa como máximo 80 %
/// del plot, dejando un techo visual constante sin alterar los datos.
enum AnalyticsChartScale {
    static let maximumDataFillRatio = 0.8

    static func upperBound(for points: [AnalyticsChartPoint]) -> Double {
        let dataMaximum = max(1, points.flatMap { [$0.value1, $0.value2] }.max() ?? 1)
        return dataMaximum / maximumDataFillRatio
    }
}

// MARK: - Posicionador del callout

/// Centra el callout en X sobre el dedo, acotándolo dentro del área de la
/// gráfica (midiendo su tamaño real para que nunca se salga por los lados),
/// y lo fija cerca del borde superior del plot.
private struct CalloutPositioner: ViewModifier {
    let pointX: CGFloat
    let plotRect: CGRect

    @State private var size: CGSize = .zero

    func body(content: Content) -> some View {
        let halfWidth = size.width / 2
        let minX = plotRect.minX + halfWidth
        let maxX = plotRect.maxX - halfWidth
        // Si el callout es más ancho que el plot, se centra sin más.
        let clampedX = minX <= maxX ? min(max(pointX, minX), maxX) : plotRect.midX
        let y = plotRect.minY + size.height / 2 + 2

        content
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .position(x: clampedX, y: y)
            // Oculto hasta medir para evitar un salto en el primer frame.
            .opacity(size == .zero ? 0 : 1)
    }
}
