import SwiftUI

/// Card de KPI (icono tonal + título + valor + delta opcional).
/// Los deltas usan SIEMPRE `RistakTheme.pos`/`RistakTheme.neg` (regla dura del
/// design system: nunca verde/rojo a mano).
struct KPICardView: View {
    enum Trend: Sendable {
        case positive
        case negative
        case neutral

        var color: Color {
            switch self {
            case .positive: return RistakTheme.pos
            case .negative: return RistakTheme.neg
            case .neutral: return RistakTheme.textDim
            }
        }
    }

    /// SF Symbol del icono tonal.
    let icon: String
    let title: String
    let value: String
    /// Texto del delta, p. ej. "+12% vs antes".
    var delta: String? = nil
    var trend: Trend = .neutral

    var body: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            Image(systemName: icon)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(RistakTheme.accent)
                .frame(width: 30, height: 30)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                        .fill(RistakTheme.accentSoft)
                )

            Text(title)
                .font(.footnote)
                .foregroundStyle(RistakTheme.textDim)
                .lineLimit(1)

            Text(value)
                .font(.title3.bold())
                .monospacedDigit()
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            if let delta {
                Text(delta)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(trend.color)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(RistakTheme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                .fill(RistakTheme.surface)
        )
        .accessibilityElement(children: .combine)
    }
}
