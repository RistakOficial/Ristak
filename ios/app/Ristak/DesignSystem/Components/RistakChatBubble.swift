import SwiftUI

/// Lado de la burbuja dentro del hilo.
enum RistakBubbleSide {
    /// Entrante (contacto): alineada a la izquierda, colita abajo-izquierda.
    case inbound
    /// Saliente (nosotros): alineada a la derecha, colita abajo-derecha.
    case outbound

    /// Radios de esquina de la burbuja (paridad mobile/: `borderRadius: 11`
    /// con la esquina de la colita reducida a `4`).
    func cornerRadii(radius: CGFloat = 11, tail: CGFloat = 4) -> RectangleCornerRadii {
        RectangleCornerRadii(
            topLeading: radius,
            bottomLeading: self == .inbound ? tail : radius,
            bottomTrailing: self == .outbound ? tail : radius,
            topTrailing: radius
        )
    }
}

/// Contenedor de burbuja de chat con la geometría exacta de mobile/
/// (`messageBubble` + `inboundBubble`/`outboundBubble`):
///
/// - Radio 11 con la esquina de la colita a 4 (`UnevenRoundedRectangle`).
/// - Padding: top 7 / horizontal 9 / bottom 5.
/// - Sombra sutil (claro 0.12 / oscuro 0.24, radio 1, y 1) vía `bubbleShadow`.
/// - Colores desde la paleta mobile/ (`bubbleInbound`/`bubbleOutbound`).
/// - La burbuja ABRAZA su contenido; el ancho máximo lo impone `RistakMessageRow`.
///
/// Variante punteada (`dashed`) para mensajes programados.
struct RistakChatBubble<Content: View>: View {
    let side: RistakBubbleSide
    /// Relleno explícito (fallido = rojo, imagen, etc.). Si es `nil`, se deriva
    /// del lado (o de `bubbleScheduled` cuando `dashed`).
    var fill: Color? = nil
    /// Tinte de marca del canal. Correo/SMS lo omiten y conservan base neutra.
    var channelColor: Color? = nil
    /// Borde punteado + fondo de mensaje programado.
    var dashed: Bool = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .modifier(RistakChatBubbleStyle(side: side, fill: fill, channelColor: channelColor, dashed: dashed))
    }
}

/// Modificador reutilizable con el estilo de burbuja (por si el contenido ya
/// vive en su propia jerarquía y solo necesita el "vestido").
struct RistakChatBubbleStyle: ViewModifier {
    let side: RistakBubbleSide
    var fill: Color? = nil
    var channelColor: Color? = nil
    var dashed: Bool = false

    func body(content: Content) -> some View {
        let shape = UnevenRoundedRectangle(
            cornerRadii: side.cornerRadii(),
            style: .continuous
        )

        content
            .padding(.top, 7)
            .padding(.horizontal, 9)
            .padding(.bottom, 5)
            .background {
                shape
                    .fill(backgroundFill)
                    .overlay {
                        if fill == nil, let channelColor {
                            shape.fill(channelColor.opacity(channelOpacity))
                        }
                    }
            }
            .overlay {
                if dashed {
                    shape.strokeBorder(
                        channelColor?.opacity(0.72) ?? RistakTheme.bubbleScheduledBorder,
                        style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])
                    )
                }
            }
            .shadow(color: RistakTheme.bubbleShadow, radius: 1, x: 0, y: 1)
    }

    private var backgroundFill: Color {
        if let fill { return fill }
        if dashed { return RistakTheme.bubbleScheduled }
        return side == .inbound ? RistakTheme.bubbleInbound : RistakTheme.bubbleOutbound
    }

    private var channelOpacity: Double {
        if dashed { return 0.24 }
        return side == .outbound ? 0.30 : 0.18
    }
}

/// Coloca una burbuja en su fila: alinea entrante→izquierda / saliente→derecha
/// y la limita a `maxWidthFraction` (~78%) del ancho disponible.
///
/// Preferible pasar `availableWidth` (medido por el hilo) para el tope exacto;
/// si es `nil`, se aplica un gutter mínimo para que la burbuja nunca toque el
/// borde opuesto.
struct RistakMessageRow<Content: View>: View {
    let side: RistakBubbleSide
    var maxWidthFraction: CGFloat = 0.78
    var availableWidth: CGFloat? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(spacing: 0) {
            if side == .outbound { Spacer(minLength: fallbackGutter) }
            content()
                .frame(maxWidth: cappedWidth, alignment: alignment)
            if side == .inbound { Spacer(minLength: fallbackGutter) }
        }
        .frame(maxWidth: .infinity, alignment: alignment)
    }

    private var alignment: Alignment {
        side == .inbound ? .leading : .trailing
    }

    private var cappedWidth: CGFloat? {
        guard let availableWidth else { return nil }
        return max(0, availableWidth * maxWidthFraction)
    }

    private var fallbackGutter: CGFloat {
        availableWidth == nil ? 48 : 0
    }
}
