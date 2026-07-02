import UIKit
import Capacitor

@objc(MainViewController)
class MainViewController: CAPBridgeViewController, UIScrollViewDelegate {
    override func viewDidLoad() {
        super.viewDidLoad()
        lockWebViewZoom()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        enforceUnitZoomScale()
    }

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

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        nil
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        enforceUnitZoomScale()
    }
}
