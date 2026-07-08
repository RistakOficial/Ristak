import SwiftUI

/// Seguimiento DETERMINISTA de la dirección de scroll para minimizar el dock.
///
/// El usuario reportó que el minimizado nativo del tab bar
/// (`.tabBarMinimizeBehavior(.onScrollDown)`) no respondía de forma fiable: el
/// dock «solo se expandía al volver al tope». Este modificador reemplaza ese
/// comportamiento por uno explícito y predecible sobre `ShellState.tabBarHidden`:
///
/// - Al **bajar** (el offset aumenta más de `threshold`) → oculta el dock.
/// - Al **subir** (el offset disminuye más de `threshold`) → lo muestra de
///   inmediato, no solo al llegar al tope.
/// - Cerca del tope (offset ≤ 0) → siempre visible (paridad Safari/App Store).
///
/// Solo actúa en ancho **compacto** (iPhone). En iPad (regular) el `TabView`
/// usa sidebar adaptable, por lo que nunca oculta nada.
///
/// Se adjunta directamente al `ScrollView`/`List` principal de cada tab, el
/// mismo patrón que `onScrollGeometryChange` ya usa `ConversationScreen`. Lee
/// `ShellState` del entorno, así que basta una sola línea sin pasar argumentos.
private struct ReportsShellScrollModifier: ViewModifier {
    @Environment(ShellState.self) private var shell
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// Ancla desde la que se mide la dirección. Se reajusta en cada cambio de
    /// dirección para que un giro de ~`threshold` puntos baste (respuesta
    /// inmediata) sin reaccionar a micro-temblores del scroll.
    @State private var anchorOffset: CGFloat = 0

    /// Umbral anti-jitter en puntos.
    private let threshold: CGFloat = 6

    func body(content: Content) -> some View {
        content.onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.contentOffset.y
        } action: { _, newOffset in
            react(to: newOffset)
        }
    }

    private func react(to offset: CGFloat) {
        // iPad / ancho regular: el dock nunca se oculta.
        guard horizontalSizeClass == .compact else {
            anchorOffset = offset
            show()
            return
        }

        // Cerca del tope: forzar visible siempre.
        if offset <= 0 {
            anchorOffset = offset
            show()
            return
        }

        let delta = offset - anchorOffset
        if delta > threshold {
            // Bajando → minimizar.
            anchorOffset = offset
            hide()
        } else if delta < -threshold {
            // Subiendo → expandir de inmediato.
            anchorOffset = offset
            show()
        }
    }

    /// Muta solo cuando cambia el valor para no invalidar el shell en cada
    /// frame de scroll (la animación vive en `MainShell`).
    private func show() {
        if shell.tabBarHidden { shell.tabBarHidden = false }
    }

    private func hide() {
        if !shell.tabBarHidden { shell.tabBarHidden = true }
    }
}

extension View {
    /// Hace que este scroll principal maneje el dock por DIRECCIÓN de scroll
    /// (bajar oculta, subir muestra). Lee `ShellState` del entorno y solo actúa
    /// en ancho compacto (iPhone). Adjúntalo al `ScrollView`/`List` principal de
    /// cada tab. Ver `ReportsShellScrollModifier`.
    func reportsShellScroll() -> some View {
        modifier(ReportsShellScrollModifier())
    }
}
