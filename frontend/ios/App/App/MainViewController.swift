import UIKit
import Capacitor
import WebKit

@objc(MainViewController)
class MainViewController: CAPBridgeViewController, UIScrollViewDelegate, WKScriptMessageHandler {
    private var shellBackgroundColor: UIColor?

    override func viewDidLoad() {
        super.viewDidLoad()
        lockWebViewZoom()
        setupShellBridge()
        setupKeyboardBridge()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        enforceUnitZoomScale()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if shellBackgroundColor == nil {
            applyNativeBackground(defaultShellBackgroundColor())
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "ristakShell")
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

    // MARK: - Shell Bridge

    private func setupShellBridge() {
        webView?.configuration.userContentController.add(self, name: "ristakShell")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "ristakShell",
              let payload = message.body as? [String: Any],
              let type = payload["type"] as? String else { return }

        if type == "setWindowBackground", let color = payload["color"] as? String {
            applyWindowBackground(color)
        }
    }

    private func applyWindowBackground(_ hex: String) {
        guard let color = UIColor(hex: hex) else { return }
        shellBackgroundColor = color
        applyNativeBackground(color)
    }

    private func applyNativeBackground(_ color: UIColor) {
        view.backgroundColor = color
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
        view.window?.backgroundColor = color
        (UIApplication.shared.delegate as? AppDelegate)?.window?.backgroundColor = color
    }

    private func defaultShellBackgroundColor() -> UIColor {
        if let shellBackgroundColor {
            return shellBackgroundColor
        }
        if traitCollection.userInterfaceStyle == .dark {
            return UIColor(hex: "#081a4e") ?? .black
        }
        return UIColor(hex: "#eef6ff") ?? .white
    }

    // MARK: - Teclado iOS (resize nativo sincronizado)
    //
    // Capacitor.resize=native/body redimensiona tarde en nuestro caso. Aqui dejamos
    // Keyboard.resize=none para que el WebView no cambie de tamano y publicamos
    // una sola vez por evento la altura/duracion/curva reales del teclado. El chat
    // mueve mensajes + composer como una pieza, sin alturas hardcodeadas.

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
        let height = keyboardOverlap(endFrame: endValue.cgRectValue)
        publishKeyboardState(height: height, userInfo: info)
    }

    @objc private func onKeyboardHide(_ note: Notification) {
        publishKeyboardState(height: 0, userInfo: note.userInfo)
    }

    /// Solape del teclado dentro de la ventana, en puntos (== CSS px a zoom 1).
    private func keyboardOverlap(endFrame: CGRect) -> CGFloat {
        guard let window = view.window ?? webView?.window else { return 0 }
        let kbInWindow = window.convert(endFrame, from: nil)
        let overlap = window.bounds.maxY - kbInWindow.minY
        if overlap <= 1 { return 0 }
        return max(0, min(overlap, window.bounds.height))
    }

    /// Mapea la UIKeyboardAnimationCurve a CSS. La curva 7 es la curva privada que
    /// iOS suele usar para el teclado; la aproximamos para evitar `ease` generico.
    private func cssEase(for curveRaw: Int) -> String {
        switch curveRaw {
        case 0: return "cubic-bezier(0.42, 0, 0.58, 1)"
        case 1: return "cubic-bezier(0.42, 0, 1, 1)"
        case 2: return "cubic-bezier(0, 0, 0.58, 1)"
        case 3: return "linear"
        default: return "cubic-bezier(0.38, 0.7, 0.125, 1)"
        }
    }

    private func publishKeyboardState(height: CGFloat, userInfo: [AnyHashable: Any]? = nil) {
        guard let webView = webView else { return }
        let durationSec = (userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curveRaw = (userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.intValue ?? 7
        let heightPx = Int(height.rounded())
        let durationMs = max(0, Int((max(durationSec, 0.0)) * 1000))
        let ease = cssEase(for: curveRaw)
        let js = """
        (function(){
          var r=document.documentElement;
          var h=\(heightPx);
          var d=\(durationMs);
          if (window.__ristakPhoneChatKeyboardClearTimer) {
            window.clearTimeout(window.__ristakPhoneChatKeyboardClearTimer);
            window.__ristakPhoneChatKeyboardClearTimer = 0;
          }
          r.style.setProperty('--phone-kb-dur',d + 'ms');
          r.style.setProperty('--phone-kb-ease','\(ease)');
          r.style.setProperty('--phone-kb',h + 'px');
          if (h > 0) {
            r.setAttribute('data-phone-chat-keyboard','true');
          } else {
            window.__ristakPhoneChatKeyboardClearTimer = window.setTimeout(function(){
              r.removeAttribute('data-phone-chat-keyboard');
              window.__ristakPhoneChatKeyboardClearTimer = 0;
            }, Math.max(d, 0));
          }
        })();
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
}

private extension UIColor {
    convenience init?(hex: String) {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") {
            value.removeFirst()
        }
        guard value.count == 6, let rgb = UInt64(value, radix: 16) else { return nil }
        self.init(
            red: CGFloat((rgb & 0xFF0000) >> 16) / 255.0,
            green: CGFloat((rgb & 0x00FF00) >> 8) / 255.0,
            blue: CGFloat(rgb & 0x0000FF) / 255.0,
            alpha: 1.0
        )
    }
}
