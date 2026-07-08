import SwiftUI

/// Chip de filtro en cápsula. Regla de selección de Ristak (ARCHITECTURE.md):
/// seleccionado = relleno SÓLIDO de acento + texto blanco (plano, sin glass,
/// sin contorno, sin sombra); en reposo = pista neutra (`controlRest`).
/// El glass queda reservado a overlays flotantes (FABs, barras).
struct RistakFilterChip: View {
    let title: String
    var systemImage: String? = nil
    /// Contador opcional (se muestra "99+" arriba de 99).
    var count: Int? = nil
    var isSelected: Bool = false
    var action: () -> Void = {}

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption.weight(.semibold))
                }

                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)

                if let count, count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .foregroundStyle(isSelected ? RistakTheme.accent : RistakTheme.onAccent)
                        .background(
                            Capsule().fill(isSelected ? AnyShapeStyle(RistakTheme.onAccent) : AnyShapeStyle(RistakTheme.accent))
                        )
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textPrimary)
            .background(
                Capsule().fill(isSelected ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
