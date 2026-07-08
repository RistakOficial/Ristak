import SwiftUI

/// Inset por defecto del separador de fila, alineado al texto tras el avatar
/// (footprint de avatar 48pt + gap 12pt = 60pt). Un solo valor para toda la
/// bandeja y todas las listas de contactos (paridad de longitud/inset).
enum RistakSeparatorMetrics {
    static let textLeadingInset: CGFloat = 60

    /// Tinte del separador: partimos del token `rowSeparator` y le bajamos aún
    /// más el alpha para dejar un hairline apenas perceptible (el usuario
    /// reportó líneas demasiado opacas). El token vive en `Theme.swift`; aquí
    /// afinamos la opacidad sin tocarlo para no alterar otros usos.
    static let rowSeparatorTint = RistakTheme.rowSeparator.opacity(0.55)
}

/// Separador de fila uniforme (paridad de fidelidad: el usuario reportó
/// separadores de anchos inconsistentes y demasiado opacos en la bandeja).
///
/// UN solo separador: sub-hairline casi transparente (`rowSeparatorTint`), con
/// inset izquierdo alineado al texto y borde derecho a ras. Para listas
/// manuales (`LazyVStack`/`VStack`). En un `List` nativo usa
/// `.ristakRowSeparator()`.
struct RistakListSeparator: View {
    @Environment(\.displayScale) private var displayScale
    var leadingInset: CGFloat = RistakSeparatorMetrics.textLeadingInset

    var body: some View {
        Rectangle()
            .fill(RistakSeparatorMetrics.rowSeparatorTint)
            // Sub-hairline: medio píxel físico (más fino que el hairline 1px).
            .frame(height: 0.5 / max(displayScale, 1))
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, leadingInset)
            .accessibilityHidden(true)
    }
}

extension View {
    /// Aplica el separador uniforme a una fila dentro de un `List` nativo:
    /// mismo tinte sutil (`rowSeparatorTint`) y mismo inset izquierdo en toda la
    /// lista, de modo que todas las filas queden idénticas en longitud.
    func ristakRowSeparator(
        leadingInset: CGFloat = RistakSeparatorMetrics.textLeadingInset
    ) -> some View {
        self
            .listRowSeparatorTint(RistakSeparatorMetrics.rowSeparatorTint)
            .alignmentGuide(.listRowSeparatorLeading) { _ in leadingInset }
    }
}
