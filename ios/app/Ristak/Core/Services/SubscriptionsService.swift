import Foundation

/// Endpoints de suscripciones (doc research/08 §4). Módulo `payments` +
/// feature de licencia `subscriptions` (403 `feature_not_available` sin ella).
enum SubscriptionsService {
    /// `GET /api/subscriptions` → `data: { subscriptions, summary }`.
    /// - `status`: `all` o un estado (`active`, `paused`, …).
    /// - `refresh`: `true` sincroniza pendientes de Mercado Pago antes.
    static func subscriptions(status: String? = nil, refresh: Bool = false) async throws -> SubscriptionsList {
        try await APIClient.shared.get(
            "/api/subscriptions",
            query: [
                "status": status,
                "refresh": refresh ? "true" : nil,
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `GET /api/subscriptions/:id`; 404 «Suscripción no encontrada.».
    static func subscription(id: String) async throws -> PaymentSubscription {
        try await APIClient.shared.get("/api/subscriptions/\(id)")
    }

    /// `POST /api/subscriptions` → 201. Validaciones backend: `name`
    /// obligatorio, `amount > 0`, CLIP prohibido, fechas no pasadas (TZ del
    /// negocio).
    static func createSubscription(_ payload: SubscriptionPayload) async throws -> PaymentSubscription {
        try await APIClient.shared.post("/api/subscriptions", body: payload, timeout: APIClient.dashboardTimeout)
    }

    /// `PUT /api/subscriptions/:id`.
    static func updateSubscription(id: String, _ payload: SubscriptionPayload) async throws -> PaymentSubscription {
        try await APIClient.shared.put("/api/subscriptions/\(id)", body: payload, timeout: APIClient.dashboardTimeout)
    }

    /// `POST /api/subscriptions/:id/action` — `pause|activate|resume|cancel|
    /// mark_past_due` (+ `nextRunAt` opcional). Se propaga a la pasarela.
    static func performAction(
        id: String,
        action: PaymentSubscriptionAction,
        nextRunAt: String? = nil
    ) async throws -> PaymentSubscription {
        try await APIClient.shared.post(
            "/api/subscriptions/\(id)/action",
            body: SubscriptionActionBody(
                action: action.rawValue,
                payload: SubscriptionActionPayload(nextRunAt: nextRunAt)
            ),
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `DELETE /api/subscriptions/:id` → 204 sin body. 422 si ya tiene cobros
    /// («…cancélala para conservar el historial.»).
    static func deleteSubscription(id: String) async throws {
        try await APIClient.shared.delete("/api/subscriptions/\(id)")
    }
}

private struct SubscriptionActionPayload: Encodable {
    let nextRunAt: String?
}

private struct SubscriptionActionBody: Encodable {
    let action: String
    let payload: SubscriptionActionPayload
}
