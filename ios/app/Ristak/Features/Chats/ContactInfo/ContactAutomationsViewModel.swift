import Foundation
import Observation

// "Meter a automatización" de la ficha de contacto (#7 / paridad desktop
// `ContactDetailsModal`). Lista las automatizaciones PUBLICADAS del negocio y
// permite inscribir a ESTE contacto en la que elija el usuario.
//
// Backend (ver `automations.routes.js` + `automationsController.js`):
//   - Catálogo:  GET  /api/automations            → { folders, automations }
//   - Inscribir: POST /api/automations/:id/enroll-contact  body { contactId, mode }
//     · `mode: "now"` inscribe de inmediato (única modalidad en móvil).
//     · Solo se puede inscribir en automatizaciones con `status === "published"`.
//
// Core aún no tiene `AutomationsService`, así que se llama a `APIClient.shared`
// directamente desde aquí (preferido sobre tocar Core — ver notas del task).

// MARK: - DTOs del catálogo de automatizaciones

/// Resumen de automatización tal como llega en `GET /api/automations`
/// (subset de campos que la ficha necesita).
struct ContactAutomationSummary: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let description: String
    let status: String

    /// Nombre visible con respaldo cuando el backend lo devuelve vacío.
    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Automatización sin título" : trimmed
    }

    enum CodingKeys: String, CodingKey {
        case id, name, description, status
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? container.decode(String.self, forKey: .id)) ?? ""
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? ""
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? ""
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? ""
    }
}

/// Envelope `data` de `GET /api/automations` (`{ folders, automations }`).
struct ContactAutomationsOverview: Decodable, Sendable {
    let automations: [ContactAutomationSummary]

    enum CodingKeys: String, CodingKey {
        case automations
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        automations = (try? container.decodeIfPresent([ContactAutomationSummary].self, forKey: .automations)) ?? []
    }
}

/// Body de `POST /api/automations/:id/enroll-contact` (modo inmediato).
struct ContactAutomationEnrollRequest: Encodable, Sendable {
    let contactId: String
    let mode: String
}

// MARK: - ViewModel

@MainActor
@Observable
final class ContactAutomationsViewModel {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        /// Error de carga con reintento.
        case failed(String)
        /// 403 de módulo/plan → estado "sin acceso" (no logout, no reintento).
        case accessDenied(String)
    }

    let contactID: String

    private(set) var phase: Phase = .idle
    private(set) var automations: [ContactAutomationSummary] = []
    var searchText: String = ""

    /// Id de la automatización que se está inscribiendo (spinner en la fila).
    private(set) var enrollingID: String?
    /// Id de la última automatización inscrita con éxito (check en la fila).
    private(set) var enrolledID: String?
    /// Error inline de inscripción (se pinta bajo la lista; sin popup).
    var enrollError: String?
    /// Trigger de háptico de éxito (`.sensoryFeedback`).
    private(set) var successFeedbackCount = 0

    init(contactID: String) {
        self.contactID = contactID
    }

    // MARK: Derivados

    /// Solo publicadas: son las únicas donde el backend permite inscribir.
    var publishedAutomations: [ContactAutomationSummary] {
        automations.filter { $0.status.lowercased() == "published" }
    }

    /// Publicadas filtradas por el buscador (nombre o descripción).
    var filteredAutomations: [ContactAutomationSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let published = publishedAutomations
        guard !query.isEmpty else { return published }
        return published.filter {
            $0.name.lowercased().contains(query) || $0.description.lowercased().contains(query)
        }
    }

    // MARK: Carga

    func loadIfNeeded() async {
        if case .loaded = phase { return }
        await load()
    }

    func load() async {
        phase = .loading
        enrollError = nil
        do {
            let overview: ContactAutomationsOverview = try await APIClient.shared.get("/automations")
            automations = overview.automations
            phase = .loaded
        } catch let error as RistakAPIError {
            switch error.kind {
            case .accessDenied, .featureUnavailable, .adminRequired:
                phase = .accessDenied(error.message)
            default:
                phase = .failed(error.message)
            }
        } catch {
            phase = .failed("No se pudieron cargar las automatizaciones.")
        }
    }

    // MARK: Inscripción (POST enroll-contact, modo inmediato)

    /// Inscribe al contacto en la automatización. Devuelve `true` en éxito.
    @discardableResult
    func enroll(_ automation: ContactAutomationSummary) async -> Bool {
        guard enrollingID == nil else { return false }
        enrollingID = automation.id
        enrollError = nil
        defer { enrollingID = nil }
        do {
            try await APIClient.shared.post(
                "/automations/\(automation.id)/enroll-contact",
                body: ContactAutomationEnrollRequest(contactId: contactID, mode: "now")
            )
            enrolledID = automation.id
            successFeedbackCount += 1
            return true
        } catch let error as RistakAPIError {
            enrollError = error.message
            return false
        } catch {
            enrollError = "No se pudo agregar el contacto a la automatización."
            return false
        }
    }
}
