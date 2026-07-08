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

    /// Burbuja entrante: `#ffffff` / `rgba(28,28,30,0.96)`.
    static let bubbleIncoming = dynamic(
        light: rgb(0xFF, 0xFF, 0xFF),
        dark: rgba(28, 28, 30, 0.96)
    )

    /// Burbuja saliente (neutra, nunca verde): `#e9eaee` / `rgba(58,58,60,0.92)`.
    static let bubbleOutgoing = dynamic(
        light: rgb(0xE9, 0xEA, 0xEE),
        dark: rgba(58, 58, 60, 0.92)
    )

    /// Burbuja de mensaje programado: `#f0f1f4` / `rgba(72,72,74,0.48)`.
    static let bubbleScheduled = dynamic(
        light: rgb(0xF0, 0xF1, 0xF4),
        dark: rgba(72, 72, 74, 0.48)
    )

    /// Burbuja de mensaje fallido: `dangerSoft` / `rgba(127,29,29,0.58)`.
    static let bubbleFailed = dynamic(
        light: rgb(0xFF, 0xE4, 0xE8),
        dark: rgba(127, 29, 29, 0.58)
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
