import SwiftUI

/// Botón flotante circular con Liquid Glass (`glassEffect` interactivo).
/// Pertenece a la capa funcional FLOTANTE (doc 16 §2.1) — no usarlo dentro
/// del contenido. Con "Reducir transparencia" cae a superficie opaca.
struct GlassFAB: View {
    /// SF Symbol del botón.
    let systemImage: String
    /// Etiqueta para VoiceOver (obligatoria: el botón es solo icono).
    let accessibilityLabel: String
    var size: CGFloat = 56
    var action: () -> Void = {}

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(RistakTheme.textPrimary)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(reduceTransparency ? .identity : .regular.interactive(), in: Circle())
        .background {
            if reduceTransparency {
                Circle().fill(RistakTheme.surface)
            }
        }
        .accessibilityLabel(accessibilityLabel)
    }
}
