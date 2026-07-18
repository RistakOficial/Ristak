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
    /// Relleno pastel del canal para globos salientes. Los entrantes lo ignoran.
    var channelColor: Color? = nil
    /// Borde punteado + fondo de mensaje programado.
    var dashed: Bool = false
    /// Media visual usa cero inset para que la foto/video SEA el globo.
    var contentInsets = EdgeInsets(top: 7, leading: 9, bottom: 5, trailing: 9)
    /// Recorta el contenido contra la silueta principal. Se activa para media
    /// full-bleed; el tail se pinta aparte para que siga sobresaliendo.
    var clipsContent = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .modifier(RistakChatBubbleStyle(
                side: side,
                fill: fill,
                channelColor: channelColor,
                dashed: dashed,
                contentInsets: contentInsets,
                clipsContent: clipsContent
            ))
    }
}

/// Modificador reutilizable con el estilo de burbuja (por si el contenido ya
/// vive en su propia jerarquía y solo necesita el "vestido").
struct RistakChatBubbleStyle: ViewModifier {
    let side: RistakBubbleSide
    var fill: Color? = nil
    var channelColor: Color? = nil
    var dashed: Bool = false
    var contentInsets = EdgeInsets(top: 7, leading: 9, bottom: 5, trailing: 9)
    var clipsContent = false

    func body(content: Content) -> some View {
        let shape = UnevenRoundedRectangle(
            cornerRadii: side.cornerRadii(),
            style: .continuous
        )

        Group {
            if clipsContent {
                content
                    .padding(contentInsets)
                    .clipShape(shape)
            } else {
                content
                    .padding(contentInsets)
            }
        }
            .background {
                ZStack(alignment: side == .inbound ? .bottomLeading : .bottomTrailing) {
                    RistakChatBubbleTail(side: side)
                        .fill(backgroundFill)
                        .frame(width: 9, height: 12)
                        .offset(x: side == .inbound ? -4 : 4, y: -1)
                    shape.fill(backgroundFill)
                }
            }
            .overlay {
                if dashed {
                    shape.strokeBorder(
                        RistakTheme.bubbleScheduledBorder,
                        style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])
                    )
                }
            }
            .shadow(color: RistakTheme.bubbleShadow, radius: 1, x: 0, y: 1)
    }

    private var backgroundFill: Color {
        if let fill { return fill }
        if side == .outbound, let channelColor { return channelColor }
        if dashed { return RistakTheme.bubbleScheduled }
        return side == .inbound ? RistakTheme.bubbleInbound : RistakTheme.bubbleOutbound
    }
}

/// Puntita visible del globo. Vive fuera de la silueta redondeada para que siga
/// siendo legible incluso cuando foto/video recortan su contenido full-bleed.
private struct RistakChatBubbleTail: Shape {
    let side: RistakBubbleSide

    func path(in rect: CGRect) -> Path {
        var path = Path()
        if side == .inbound {
            path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addCurve(
                to: CGPoint(x: rect.minX, y: rect.maxY),
                control1: CGPoint(x: rect.minX + rect.width * 0.65, y: rect.maxY),
                control2: CGPoint(x: rect.minX, y: rect.maxY)
            )
            path.addCurve(
                to: CGPoint(x: rect.maxX, y: rect.minY),
                control1: CGPoint(x: rect.minX + rect.width * 0.55, y: rect.minY + rect.height * 0.72),
                control2: CGPoint(x: rect.minX + rect.width * 0.82, y: rect.minY + rect.height * 0.25)
            )
        } else {
            path.move(to: CGPoint(x: rect.minX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.addCurve(
                to: CGPoint(x: rect.maxX, y: rect.maxY),
                control1: CGPoint(x: rect.width * 0.35, y: rect.maxY),
                control2: CGPoint(x: rect.maxX, y: rect.maxY)
            )
            path.addCurve(
                to: CGPoint(x: rect.minX, y: rect.minY),
                control1: CGPoint(x: rect.minX + rect.width * 0.45, y: rect.minY + rect.height * 0.72),
                control2: CGPoint(x: rect.minX + rect.width * 0.18, y: rect.minY + rect.height * 0.25)
            )
        }
        path.closeSubpath()
        return path
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
