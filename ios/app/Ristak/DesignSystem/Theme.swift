import SwiftUI
import UIKit

/// Tokens semánticos del design system Ristak para iOS.
///
/// Mapea la marca (azul `#3278ff` = asset `AccentColor`; semánticos de
/// docs research/14 §2 y research/15 §2) sobre colores dinámicos claro/oscuro.
/// REGLA: las vistas de features NUNCA usan hex directos — todo pasa por aquí
/// o por los colores del sistema.
enum RistakTheme {
    // MARK: - Acento de marca

    /// Azul Ristak `#3278ff` (asset `AccentColor`, variante única).
    static let accent = Color.accentColor

    /// Fondo suave del acento (chips tonales, iconos tonales).
    static let accentSoft = dynamic(
        light: rgba(50, 120, 255, 0.14),
        dark: rgba(50, 120, 255, 0.24)
    )

    /// Texto/íconos sobre relleno sólido de acento (chips seleccionados, CTA).
    static let onAccent = Color.white

    // MARK: - Semánticos (pos/neg/warn/info)

    /// Positivo (deltas ↑, pagos confirmados). Base `#18b66f` (doc 14),
    /// oscurecido en claro para contraste.
    static let pos = dynamic(
        light: rgb(0x0F, 0x9B, 0x5F),
        dark: rgb(0x18, 0xB6, 0x6F)
    )

    static let posSoft = dynamic(
        light: rgba(24, 182, 111, 0.14),
        dark: rgba(24, 182, 111, 0.22)
    )

    /// Negativo (errores, deltas ↓). `#e5485d` claro / `#ff5d6c` oscuro (doc 14).
    static let neg = dynamic(
        light: rgb(0xE5, 0x48, 0x5D),
        dark: rgb(0xFF, 0x5D, 0x6C)
    )

    /// Fondo suave negativo (`dangerSoft` de doc 14).
    static let negSoft = dynamic(
        light: rgb(0xFF, 0xE4, 0xE8),
        dark: rgb(0x6F, 0x20, 0x30)
    )

    /// Advertencia. Dorado Aurora `#d8b46a` (doc 15), oscurecido en claro.
    static let warn = dynamic(
        light: rgb(0xA5, 0x81, 0x3A),
        dark: rgb(0xD8, 0xB4, 0x6A)
    )

    static let warnSoft = dynamic(
        light: rgba(216, 180, 106, 0.18),
        dark: rgba(216, 180, 106, 0.20)
    )

    /// Informativo neutro. `#6f8794` Aurora (doc 15), oscurecido en claro.
    static let info = dynamic(
        light: rgb(0x5A, 0x72, 0x80),
        dark: rgb(0x6F, 0x87, 0x94)
    )

    static let infoSoft = dynamic(
        light: rgba(111, 135, 148, 0.16),
        dark: rgba(111, 135, 148, 0.24)
    )

    // MARK: - Jerarquía de superficies (colores del sistema)

    /// Fondo base de pantalla (capa de contenido).
    static let bg = Color(uiColor: .systemBackground)

    /// Fondo base para pantallas agrupadas (listas de ajustes, formularios).
    static let bgGrouped = Color(uiColor: .systemGroupedBackground)

    /// Superficie elevada (cards, celdas sobre `bgGrouped`).
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)

    /// Segunda elevación (bloques dentro de una card).
    static let surface2 = Color(uiColor: .tertiarySystemGroupedBackground)

    /// Superficie de controles/inputs sobre fondo plano (buscadores, campos).
    static let controlBackground = Color(uiColor: .secondarySystemBackground)

    /// Pista neutra en reposo de controles seleccionables (chips/tabs/slots).
    /// Doc 14 §2.3: claro `rgba(118,118,128,0.12)` / oscuro `rgba(255,255,255,0.07)`.
    static let controlRest = dynamic(
        light: rgba(118, 118, 128, 0.12),
        dark: rgba(255, 255, 255, 0.07)
    )

    // MARK: - Texto y bordes

    static let textPrimary = Color.primary
    static let textDim = Color.secondary
    static let textMute = Color(uiColor: .tertiaryLabel)
    static let border = Color(uiColor: .separator)

    // MARK: - Chat (paleta doc 14 §2.3, para el módulo de conversación)

    /// Burbuja entrante: blanca en claro y carbón en oscuro.
    static let bubbleIncoming = dynamic(
        light: rgb(0xFF, 0xFF, 0xFF),
        dark: rgb(0x24, 0x25, 0x27)
    )

    /// Base neutra de burbuja saliente para correo, SMS o canal desconocido.
    static let bubbleOutgoing = dynamic(
        light: rgb(0xF0, 0xF1, 0xF4),
        dark: rgb(0x30, 0x31, 0x35)
    )

    /// Alias canónicos usados por `RistakChatBubble` (paridad mobile/):
    /// entrante = `bubbleIncoming`, saliente = `bubbleOutgoing`.
    static let bubbleInbound = bubbleIncoming
    static let bubbleOutbound = bubbleOutgoing

    /// Rellenos por canal usados solamente en globos salientes. En tema oscuro
    /// conservan la identidad del canal con tonos profundos, no con pasteles que
    /// encandilan sobre el wallpaper negro.
    static let chatChannelWhatsAppAPI = dynamic(
        light: rgb(0xD9, 0xFD, 0xD3),
        dark: rgb(0x0B, 0x49, 0x39)
    )
    static let chatChannelWhatsAppQR = dynamic(
        light: rgb(0xC6, 0xEF, 0xBD),
        dark: rgb(0x12, 0x4F, 0x3B)
    )
    static let chatChannelInstagram = dynamic(
        light: rgb(0xF2, 0xD7, 0xE6),
        dark: rgb(0x4A, 0x26, 0x3D)
    )
    static let chatChannelMessenger = dynamic(
        light: rgb(0xDB, 0xEA, 0xFE),
        dark: rgb(0x1B, 0x3C, 0x66)
    )

    /// Texto principal dentro del globo, con contraste real en ambos temas.
    static let bubbleTextInbound = dynamic(
        light: rgb(0x1D, 0x1D, 0x1F),
        dark: rgb(0xF5, 0xF5, 0xF7)
    )
    static let bubbleTextOutbound = bubbleTextInbound

    /// Meta de la burbuja (hora, estado).
    static let bubbleMeta = dynamic(
        light: rgb(0x6E, 0x6E, 0x73),
        dark: rgb(0xB7, 0xB7, 0xBD)
    )

    /// Meta superpuesta sobre foto/video; siempre clara y respaldada por el
    /// degradado del media para conservar contraste con cualquier contenido.
    static let bubbleMediaMeta = Color.white.opacity(0.94)

    /// Borde punteado de burbuja programada sobre superficie clara.
    static let bubbleScheduledBorder = dynamic(
        light: rgba(60, 60, 67, 0.22),
        dark: rgba(235, 235, 245, 0.32)
    )

    /// Color efectivo de la sombra de burbuja: en mobile/ es
    /// `shadowColor × shadowOpacity` → claro `rgba(60,60,67,0.28)×0.12`,
    /// oscuro `#000×0.24`. Radio 1, offset y 1 los aplica la burbuja.
    static let bubbleShadow = dynamic(
        light: rgba(60, 60, 67, 0.0336),
        dark: rgba(0, 0, 0, 0.24)
    )

    /// Burbuja neutral de mensaje programado.
    static let bubbleScheduled = dynamic(
        light: rgb(0xF0, 0xF1, 0xF4),
        dark: rgb(0x30, 0x31, 0x35)
    )

    /// Burbuja de mensaje fallido, clara u oscura según el tema.
    static let bubbleFailed = dynamic(
        light: rgb(0xFF, 0xE4, 0xE8),
        dark: rgb(0x55, 0x20, 0x2A)
    )

    /// Fondo del composer: `#f5f5f7` / panel `#111114` (doc 14).
    static let composerBackground = dynamic(
        light: rgb(0xF5, 0xF5, 0xF7),
        dark: rgb(0x11, 0x11, 0x14)
    )

    /// Chip separador de día en el hilo: `rgba(245,245,247,0.92)` / `rgba(44,44,46,0.82)`.
    static let daySeparator = dynamic(
        light: rgba(245, 245, 247, 0.92),
        dark: rgba(44, 44, 46, 0.82)
    )

    /// Fondo base del hilo bajo el wallpaper (mobile/ `conversationWallpaperBackground`):
    /// `#f5f5f7` claro / `#050506` oscuro.
    static let chatWallpaperBase = dynamic(
        light: rgb(0xF5, 0xF5, 0xF7),
        dark: rgb(0x05, 0x05, 0x06)
    )

    /// Tinte monocromo del wallpaper (mobile/ `chatWallpaperTint` = muted/meta):
    /// `#6e6e73` claro / `#c7c7cc` oscuro. La opacidad (0.82/0.5) la aplica la vista.
    static let chatWallpaperTint = dynamic(
        light: rgb(0x6E, 0x6E, 0x73),
        dark: rgb(0xC7, 0xC7, 0xCC)
    )

    // MARK: - Separadores de lista

    /// Separador uniforme de filas (bandeja): hairline sutil y semitransparente,
    /// idéntico en toda la lista. Claro `rgba(60,60,67,0.12)` /
    /// oscuro `rgba(235,235,245,0.12)`.
    static let rowSeparator = dynamic(
        light: rgba(60, 60, 67, 0.12),
        dark: rgba(235, 235, 245, 0.12)
    )

    // MARK: - Espaciado

    /// Escala de espaciado en puntos.
    enum Spacing {
        /// 4
        static let xxs: CGFloat = 4
        /// 8
        static let xs: CGFloat = 8
        /// 12
        static let sm: CGFloat = 12
        /// 16
        static let md: CGFloat = 16
        /// 20
        static let lg: CGFloat = 20
        /// 24
        static let xl: CGFloat = 24
        /// 32
        static let xxl: CGFloat = 32
    }

    // MARK: - Radios (Aurora: card 20 / control 13, doc 15 §2.4)

    enum Radius {
        /// Cards y paneles: 20 pt.
        static let card: CGFloat = 20
        /// Controles e inputs: 13 pt.
        static let control: CGFloat = 13
        /// Bloques pequeños (iconos tonales, thumbnails): 10 pt.
        static let small: CGFloat = 10
    }

    // MARK: - Helpers privados

    private static func dynamic(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }

    private static func rgb(_ red: Int, _ green: Int, _ blue: Int) -> UIColor {
        rgba(red, green, blue, 1)
    }

    private static func rgba(_ red: Int, _ green: Int, _ blue: Int, _ alpha: Double) -> UIColor {
        UIColor(
            red: CGFloat(red) / 255,
            green: CGFloat(green) / 255,
            blue: CGFloat(blue) / 255,
            alpha: alpha
        )
    }
}
