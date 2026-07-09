import CoreLocation
import Foundation

/// Ubicación actual del dispositivo para «Compartir ubicación» (doc 05 §2.3).
/// One-shot: pide permiso when-in-use y devuelve la primera coordenada.
final class LocationSender: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    enum LocationError: LocalizedError {
        case denied
        case unavailable

        var errorDescription: String? {
            switch self {
            case .denied:
                // Copy exacto /movil (doc 05 §2.3).
                return "Permite ubicación para Ristak desde ajustes del celular y vuelve a intentar."
            case .unavailable:
                return "No se pudo obtener tu ubicación. Intenta de nuevo."
            }
        }
    }

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocationCoordinate2D, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    /// Coordenada actual (pide permiso si hace falta).
    func currentCoordinate() async throws -> CLLocationCoordinate2D {
        let status = manager.authorizationStatus
        if status == .denied || status == .restricted {
            throw LocationError.denied
        }
        return try await withCheckedThrowingContinuation { continuation in
            // Si ya había una petición en vuelo, RESUÉLVELA antes de reemplazarla:
            // sobreescribir la continuation sin resumirla la FILTRABA para siempre
            // ("SWIFT TASK CONTINUATION MISUSE") y dejaba su Task colgado.
            finish(.failure(LocationError.unavailable))
            self.continuation = continuation
            if status == .notDetermined {
                manager.requestWhenInUseAuthorization()
            } else {
                manager.requestLocation()
            }
        }
    }

    /// Resuelve la continuation pendiente (si la hay) y la limpia de forma atómica.
    /// Un único punto de resume + nil evita fugas y dobles-resume en los callbacks.
    private func finish(_ result: Result<CLLocationCoordinate2D, Error>) {
        guard let pending = continuation else { return }
        continuation = nil
        pending.resume(with: result)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard continuation != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        case .denied, .restricted:
            finish(.failure(LocationError.denied))
        case .notDetermined:
            break
        @unknown default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let coordinate = locations.first?.coordinate else {
            finish(.failure(LocationError.unavailable))
            return
        }
        finish(.success(coordinate))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if let clError = error as? CLError, clError.code == .denied {
            finish(.failure(LocationError.denied))
        } else {
            finish(.failure(LocationError.unavailable))
        }
    }
}
