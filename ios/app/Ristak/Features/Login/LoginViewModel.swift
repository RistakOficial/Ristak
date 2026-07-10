import Foundation
import Observation

/// ViewModel del login móvil de un solo paso (doc research/02):
/// email + contraseña → resolve de tenant en el portal central → login contra
/// la instalación correcta de esa cuenta.
@MainActor
@Observable
final class LoginViewModel {
    var email = ""
    var password = ""

    private(set) var isBusy = false
    private(set) var errorMessage: String?

    var canSubmit: Bool { !isBusy }

    func clearError() {
        errorMessage = nil
    }

    /// Ejecuta el login. La transición de pantalla la maneja `SessionStore`
    /// (phase → .active); aquí solo validamos y mostramos errores inline.
    func submit(using session: SessionStore) async {
        guard !isBusy else { return }
        errorMessage = nil

        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanEmail.isEmpty, !password.isEmpty else {
            errorMessage = "Escribe tu correo y contraseña."
            return
        }
        guard Self.isValidEmail(cleanEmail) else {
            errorMessage = "Escribe un correo válido."
            return
        }

        isBusy = true
        defer { isBusy = false }

        do {
            try await session.login(email: cleanEmail, password: password)
        } catch let error as TenantResolverError {
            // Copy exacto del portal: tenant_not_found / client_inactive /
            // installation_not_ready / rate_limited (doc 02, Audit #1).
            errorMessage = error.errorDescription ?? TenantResolver.fallbackMessage
        } catch let error as RistakAPIError {
            // Mensaje del backend (`message || error`), incl. license_blocked
            // y rate_limited del login.
            errorMessage = error.message
        } catch {
            errorMessage = "No se pudo iniciar sesión. Intenta de nuevo."
        }
    }

    /// Paridad con la regex RN `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
    static func isValidEmail(_ value: String) -> Bool {
        guard !value.contains(where: { $0.isWhitespace }) else { return false }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        let local = parts[0]
        let domain = parts[1]
        guard !local.isEmpty, !domain.isEmpty else { return false }
        return domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".")
    }
}
