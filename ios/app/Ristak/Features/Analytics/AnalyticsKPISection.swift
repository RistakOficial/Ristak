import SwiftUI

/// Grid de las 8 tarjetas KPI de `GET /api/dashboard/metrics` (doc 09 §7.2).
/// iPhone: 2 columnas; iPad: 4 (lo decide la vista raíz por size class).
/// Deltas `±X.X% vs antes` con `RistakTheme.pos`/`neg` vía `KPICardView.Trend`.
struct AnalyticsKPISection: View {
    let model: AnalyticsViewModel
    let formatters: BusinessFormatters
    let columns: Int

    private struct KPIItem: Identifiable {
        let id: String
        let title: String
        /// SF Symbol equivalente al icono lucide de RN.
        let icon: String
        /// ROAS se formatea `X.XXx`; el resto es moneda de la cuenta.
        let isRoas: Bool
        let keyPath: KeyPath<DashboardMetricsSnapshot, DashboardKPIValue?>
    }

    /// Config exacta de doc 09 §7.2 (títulos y orden).
    private static let items: [KPIItem] = [
        KPIItem(id: "ingresosNetos", title: "Ingresos netos", icon: "dollarsign", isRoas: false, keyPath: \.ingresosNetos),
        KPIItem(id: "gastosPublicidad", title: "Gastos publicidad", icon: "creditcard", isRoas: false, keyPath: \.gastosPublicidad),
        KPIItem(id: "gananciaBruta", title: "Ganancia bruta", icon: "chart.line.uptrend.xyaxis", isRoas: false, keyPath: \.gananciaBruta),
        KPIItem(id: "roas", title: "ROAS", icon: "waveform.path.ecg", isRoas: true, keyPath: \.roas),
        KPIItem(id: "totalCostos", title: "Gastos negocio", icon: "wallet.pass", isRoas: false, keyPath: \.totalCostos),
        KPIItem(id: "gananciaNeta", title: "Ganancia neta", icon: "dollarsign.circle", isRoas: false, keyPath: \.gananciaNeta),
        KPIItem(id: "reembolsos", title: "Reembolsos", icon: "chart.line.downtrend.xyaxis", isRoas: false, keyPath: \.reembolsos),
        KPIItem(id: "ltvPromedio", title: "Pago promedio", icon: "person.2", isRoas: false, keyPath: \.ltvPromedio),
    ]

    var body: some View {
        if let message = model.metrics.errorMessage {
            SectionCard {
                AnalyticsPanelErrorView(message: message) {
                    Task { await model.retryMetrics() }
                }
            }
        } else {
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: RistakTheme.Spacing.sm),
                    count: max(1, columns)
                ),
                spacing: RistakTheme.Spacing.sm
            ) {
                ForEach(Self.items) { item in
                    card(for: item)
                }
            }
        }
    }

    private func card(for item: KPIItem) -> KPICardView {
        // Estado cargando: valor «…» y delta vacío (paridad /movil, sin skeleton).
        if model.metrics.isLoading {
            return KPICardView(
                icon: item.icon,
                title: item.title,
                value: "…",
                delta: nil,
                trend: .neutral
            )
        }

        // Cada campo puede faltar en el payload: tratar como 0 (paridad Expo).
        let kpi = model.metrics.value?[keyPath: item.keyPath] ?? DashboardKPIValue()
        let value = item.isRoas ? formatters.roas(kpi.value) : formatters.currency(kpi.value)
        return KPICardView(
            icon: item.icon,
            title: item.title,
            value: value,
            delta: kpi.variationLabel,
            // Positivo si variation >= 0, negativo si < 0 (doc 09 §7.2).
            trend: kpi.variation >= 0 ? .positive : .negative
        )
    }
}
