import SwiftUI

// MARK: - Panel "Origen"

/// Panel «Origen» (doc 09 §7.5): tabs Tráfico / {leads} / Citas / {clientes}
/// (cambio local, sin re-fetch), top 8 filas con barra de acento y pill con
/// el total de la tab activa.
struct AnalyticsOriginPanel: View {
    let model: AnalyticsViewModel
    let formatters: BusinessFormatters

    var body: some View {
        SectionCard(title: "Origen") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Fuentes")
                        .font(.title3.bold())
                        .foregroundStyle(RistakTheme.textPrimary)

                    Spacer(minLength: RistakTheme.Spacing.xs)

                    if !model.origin.isLoading, model.origin.errorMessage == nil {
                        AnalyticsHeaderPill(text: formatters.wholeNumber(model.originTotal))
                    }
                }

                tabChips

                content
            }
        }
    }

    private var tabChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(AnalyticsOriginTab.allCases) { tab in
                    RistakFilterChip(
                        title: tab.title(labels: model.labels),
                        isSelected: model.originTab == tab
                    ) {
                        model.originTab = tab
                    }
                }
            }
        }
        .ristakContainedEdgeToEdgeChips()
        .padding(.horizontal, -RistakTheme.Spacing.md)
    }

    @ViewBuilder
    private var content: some View {
        if model.origin.isLoading {
            AnalyticsPanelLoadingView(accessibilityLabel: "Cargando origen")
        } else if let message = model.origin.errorMessage {
            AnalyticsPanelErrorView(message: message) {
                Task { await model.retryOrigin() }
            }
        } else {
            let items = model.originDisplayItems
            if items.isEmpty {
                Text("Sin origen detectado en este periodo.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, RistakTheme.Spacing.lg)
            } else {
                let maxValue = max(1, items.map(\.value).max() ?? 1)
                VStack(spacing: RistakTheme.Spacing.md) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        sourceRow(item, maxValue: maxValue)
                    }
                }
                .padding(.top, RistakTheme.Spacing.xxs)
            }
        }
    }

    private func sourceRow(_ item: SourceBreakdownItem, maxValue: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)

                Spacer(minLength: RistakTheme.Spacing.xs)

                Text(formatters.wholeNumber(item.value))
                    .font(.subheadline.bold())
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textPrimary)
            }

            // El backend no manda `color` en origin-distribution: se pinta
            // con el acento (paridad /movil, doc 09 §4.6).
            AnalyticsBar(fraction: item.value / maxValue)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Panel "Origen por número" (WhatsApp)

/// Panel condicional (≥ 2 números detectados, doc 09 §7.6): filas por número
/// de WhatsApp con «N personas», barra de contraste y estado del número.
struct AnalyticsWhatsAppPanel: View {
    let model: AnalyticsViewModel
    let formatters: BusinessFormatters

    var body: some View {
        SectionCard(title: "WhatsApp") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                Text("Origen por número")
                    .font(.title3.bold())
                    .foregroundStyle(RistakTheme.textPrimary)

                let rows = model.whatsappRows
                let maxValue = max(1, rows.map(\.value).max() ?? 1)
                VStack(spacing: RistakTheme.Spacing.md) {
                    ForEach(rows) { row in
                        numberRow(row, maxValue: maxValue)
                    }
                }
                .padding(.top, RistakTheme.Spacing.xxs)
            }
        }
    }

    private func numberRow(_ row: AnalyticsWhatsAppRow, maxValue: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    // Debajo va el número; si no se conoce, el estado.
                    Text(row.number ?? row.statusLabel)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                Text("\(formatters.wholeNumber(row.value)) personas")
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textPrimary)
            }

            // Barra en color de contraste (no acento), paridad /movil.
            AnalyticsBar(fraction: row.value / maxValue, color: RistakTheme.textPrimary)

            Text(row.statusLabel)
                .font(.caption2)
                .foregroundStyle(RistakTheme.textMute)
        }
        .accessibilityElement(children: .combine)
    }
}
