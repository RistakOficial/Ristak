import SwiftUI

// MARK: - Fila de chips de borde a borde (#7)

enum RistakContainedChipLayout {
    /// Alinea el primer y último chip con el contenido de una `SectionCard`
    /// cuando el carrusel está en reposo.
    static let restingInset = RistakTheme.Spacing.md
}

extension View {
    /// Hace que una fila horizontal de chips/pills (un `ScrollView(.horizontal)`)
    /// se desplace de **borde a borde**, como en las apps nativas de Apple:
    ///
    /// - `.scrollClipDisabled()` evita que el primer/último chip se vea recortado
    ///   en los extremos del área visible.
    /// - `.contentMargins(.horizontal, inset, for: .scrollContent)` da aire al
    ///   primer/último chip **sin** encoger el área de scroll: el gesto y el
    ///   contenido pueden alcanzar el borde real de la pantalla (o de la card).
    ///
    /// Regla de uso:
    /// - En filas a nivel de pantalla: elimina cualquier `.padding(.horizontal)`
    ///   exterior del `ScrollView` y usa este modificador con el mismo valor de
    ///   gutter como `horizontalInset` (típicamente `RistakTheme.Spacing.md`).
    /// - En filas dentro de una `SectionCard`: neutraliza el padding horizontal
    ///   de la card con `.padding(.horizontal, -RistakTheme.Spacing.md)` para que
    ///   el scroll ocupe el ancho completo de la card y deja `horizontalInset` en
    ///   `RistakTheme.Spacing.md` para restaurar el aire de reposo.
    ///
    /// Aplícalo **directamente** sobre el `ScrollView(.horizontal)`.
    func ristakEdgeToEdgeChips(horizontalInset: CGFloat = RistakTheme.Spacing.md) -> some View {
        self
            .scrollClipDisabled()
            .contentMargins(.horizontal, horizontalInset, for: .scrollContent)
    }

    /// Variante para carruseles que ocupan todo el ancho de una card y jamás
    /// dibujan fuera de ella. En reposo, el primer/último chip conserva el aire
    /// interior de la card; al desplazarse, el contenido puede desaparecer en
    /// el borde real del viewport.
    func ristakContainedEdgeToEdgeChips(
        horizontalInset: CGFloat = RistakContainedChipLayout.restingInset
    ) -> some View {
        self
            .scrollClipDisabled(false)
            .contentMargins(.horizontal, horizontalInset, for: .scrollContent)
            .clipped()
    }
}
