import SwiftUI
import UIKit

/// Overlay de gestos (UIKit) para las filas de la bandeja: tap + long-press
/// reconocidos por `UITapGestureRecognizer` / `UILongPressGestureRecognizer`.
///
/// El `.onLongPressGesture` de SwiftUI dentro de un `List` se siente lentísimo:
/// el List arbitra entre scroll y toque (delaysContentTouches) y un
/// micro-movimiento cancela y reinicia el gesto. Con recognizers de UIKit el
/// long-press dispara rápido y CONFIABLE (0.3 s, tolerancia amplia) en cuanto
/// entra en estado `.began`, conviviendo con el scroll del List (reconocimiento
/// simultáneo). El tap se maneja aquí también para no competir con el long-press.
struct RowGestureOverlay: UIViewRepresentable {
    let onTap: () -> Void
    let onLongPress: () -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear

        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleTap)
        )
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)

        let longPress = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleLongPress(_:))
        )
        longPress.minimumPressDuration = 0.3
        longPress.allowableMovement = 40
        longPress.delegate = context.coordinator
        view.addGestureRecognizer(longPress)

        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: RowGestureOverlay
        init(_ parent: RowGestureOverlay) { self.parent = parent }

        @objc func handleTap() {
            parent.onTap()
        }

        @objc func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
            // Dispara en cuanto se cumple la duración (estado `.began`): haptic +
            // sheet al instante, sin esperar a que el dedo se levante.
            guard gesture.state == .began else { return }
            parent.onLongPress()
        }

        // SOLO el long-press convive con el pan del scroll del List: necesita
        // dispararse durante la arbitración scroll/toque (por eso se migró de
        // SwiftUI a UIKit). El TAP, en cambio, NO debe ser simultáneo con el
        // scroll: así recupera el comportamiento nativo de CEDER al scroll —
        // cuando la lista trae inercia o la estás desplazando, tocarla ya no abre
        // un chat por error (antes este método devolvía `true` para todo, lo que
        // dejaba al tap disparar en medio del scroll: la raíz de la
        // hipersensibilidad).
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            gestureRecognizer is UILongPressGestureRecognizer
        }
    }
}
