import SwiftUI

/// Contenedor de sección sobre fondo agrupado: superficie opaca, radio de
/// card Aurora y encabezado eyebrow opcional. Capa de CONTENIDO (sin glass).
struct SectionCard<Content: View>: View {
    /// Encabezado eyebrow (se muestra en mayúsculas, estilo iOS).
    var title: String? = nil
    @ViewBuilder var content: Content

    init(title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            if let title, !title.isEmpty {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
                    .textCase(.uppercase)
            }

            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(RistakTheme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                .fill(RistakTheme.surface)
        )
    }
}
