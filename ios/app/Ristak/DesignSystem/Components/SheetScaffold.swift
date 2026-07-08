import SwiftUI

/// Cabecera estándar de sheet: título (+ subtítulo opcional, normalmente el
/// nombre del contacto) y botón X de cierre. El fondo de la sheet lo pone el
/// sistema (iOS 26): NO agregar fondos custom aquí.
struct SheetScaffold<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    /// Acción de cierre custom; por defecto usa `dismiss` del entorno.
    var onClose: (() -> Void)? = nil
    @ViewBuilder var content: Content

    @Environment(\.dismiss) private var dismiss

    init(
        title: String,
        subtitle: String? = nil,
        onClose: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.onClose = onClose
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.top, RistakTheme.Spacing.lg)
                .padding(.bottom, RistakTheme.Spacing.sm)

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: RistakTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(RistakTheme.textPrimary)

                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            Button {
                if let onClose {
                    onClose()
                } else {
                    dismiss()
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(RistakTheme.controlRest))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cerrar")
        }
    }
}
