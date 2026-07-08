import SwiftUI

/// Pill de etiqueta (tags de contacto, estados suaves). Punto de color
/// opcional; el relleno siempre es la pista neutra del tema.
struct TagPillView: View {
    let text: String
    /// Color del punto indicador (nil = sin punto).
    var dotColor: Color? = nil

    var body: some View {
        HStack(spacing: 5) {
            if let dotColor {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)
            }

            Text(text)
                .font(.caption.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(RistakTheme.controlRest))
        .accessibilityElement(children: .combine)
    }
}
