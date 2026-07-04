import UIKit
import Capacitor

@objc(MainViewController)
class MainViewController: CAPBridgeViewController, UIScrollViewDelegate {

    override func viewDidLoad() {
        super.viewDidLoad()
        lockWebViewZoom()
        setupKeyboardBridge()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        enforceUnitZoomScale()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Zoom Lock

    private func lockWebViewZoom() {
        guard let scrollView = webView?.scrollView else { return }
        scrollView.delegate = self
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 1.0
        scrollView.zoomScale = 1.0
        scrollView.bouncesZoom = false
        scrollView.pinchGestureRecognizer?.isEnabled = false
    }

    private func enforceUnitZoomScale() {
        guard let scrollView = webView?.scrollView else { return }
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 1.0
        if scrollView.zoomScale != 1.0 {
            scrollView.setZoomScale(1.0, animated: false)
        }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { nil }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        enforceUnitZoomScale()
    }

    // MARK: - Puente de teclado (una llamada por evento, NO por frame)
    //
    // No animamos nada por frame ni tocamos webView.frame. Solo leemos del evento
    // NATIVO del teclado la altura + la DURACION y CURVA reales de iOS, y las
    // escribimos UNA vez en CSS vars (--phone-kb / --phone-kb-dur / --phone-kb-ease).
    // La web hace: height: calc(100dvh - var(--phone-kb)) con
    // transition: height var(--phone-kb-dur) var(--phone-kb-ease). Asi el composer se
    // mueve con la MISMA duracion y curva del teclado (sin adivinar el cubic-bezier)
    // y con una sola llamada de puente (minima latencia). Requiere Keyboard.resize=none.

    private func setupKeyboardBridge() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onKeyboardChange(_:)),
                       name: UIResponder.keyboardWillShowNotification, object: nil)
        nc.addObserver(self, selector: #selector(onKeyboardChange(_:)),
                       name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        nc.addObserver(self, selector: #selector(onKeyboardHide(_:)),
                       name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    @objc private func onKeyboardChange(_ note: Notification) {
        guard let info = note.userInfo,
              let endValue = info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue else { return }
        pushKeyboard(height: keyboardOverlap(endFrame: endValue.cgRectValue), userInfo: info)
    }

    @objc private func onKeyboardHide(_ note: Notification) {
        // Al CERRAR el composer baja mas rapido que el teclado (lo adelanta), asi su
        // borde inferior siempre va por debajo del borde del teclado que desciende y
        // este lo tapa -> nunca queda el hueco oscuro. La micro-latencia del puente
        // hacia que, a la misma duracion, el composer fuera un pelin atras y se viera.
        pushKeyboard(height: 0, userInfo: note.userInfo, closing: true)
    }

    /// Solape del teclado dentro del webView, en puntos (== CSS px a zoom 1).
    private func keyboardOverlap(endFrame: CGRect) -> CGFloat {
        guard let webView = webView, let window = webView.window else { return 0 }
        let kbInView = webView.convert(endFrame, from: window)
        let overlap = webView.bounds.maxY - kbInView.minY
        if overlap <= 1 { return 0 }   // teclado fisico / cerrado / fuera de pantalla
        return max(0, min(overlap, webView.bounds.height))
    }

    /// Mapea la UIKeyboardAnimationCurve a un cubic-bezier CSS. La curva 7 (privada
    /// del teclado) se aproxima con la referencia mas usada por la comunidad.
    private func cssEase(for curveRaw: Int) -> String {
        switch curveRaw {
        case 0: return "cubic-bezier(0.42, 0, 0.58, 1)"      // easeInOut
        case 1: return "cubic-bezier(0.42, 0, 1, 1)"          // easeIn
        case 2: return "cubic-bezier(0, 0, 0.58, 1)"          // easeOut
        case 3: return "linear"
        default: return "cubic-bezier(0.38, 0.7, 0.125, 1)"   // 7: curva del teclado iOS
        }
    }

    private func pushKeyboard(height: CGFloat, userInfo: [AnyHashable: Any]?, closing: Bool = false) {
        guard let webView = webView else { return }
        let durationSec = (userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curveRaw = (userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.intValue ?? 7
        // Abrir: curva REAL del teclado y su duracion menos ~40ms, para compensar la
        // micro-latencia del puente: el composer arranca un pelin tarde pero TERMINA
        // junto con el teclado (y por la curva va siempre detras, sin dejar hueco).
        // Cerrar: mas corto y con salida rapida (easeIn) para adelantar al teclado.
        let openMs = max(Int((max(durationSec, 0.0)) * 1000) - 40, 120)
        let durationMs = closing ? 120 : openMs
        let ease = closing ? "cubic-bezier(0.4, 0, 1, 1)" : cssEase(for: curveRaw)
        let heightPx = Int(height.rounded())
        // Orden importante: fijamos duracion + curva ANTES que la altura, para que el
        // cambio de altura dispare la transition con los valores correctos.
        let js = """
        (function(){
          var r=document.documentElement;
          r.style.setProperty('--phone-kb-dur','\(durationMs)ms');
          r.style.setProperty('--phone-kb-ease','\(ease)');
          r.style.setProperty('--phone-kb','\(heightPx)px');
        })();
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
}
