import Foundation

/// Operaciones de cobro por pasarela: links de pago, tarjetas guardadas,
/// cobros directos y planes (doc research/08 §5). Módulo `payments`;
/// `payment-plans` exige además la feature `payment_plans`.
///
/// Los cobros con tarjeta guardada incluyen `clientRequestId`: backend y
/// proveedor reutilizan el resultado del mismo intento para evitar doble cargo.
/// Los demas POST siguen deshabilitando el boton mientras hay request en vuelo.
enum PaymentLinksService {
    /// `POST /api/<gw>/payment-links` — payload común para las 5 pasarelas.
    /// Respuesta 201 `data: { payment, paymentUrl, publicPaymentId }`
    /// (Mercado Pago agrega `preferenceId`).
    static func createPaymentLink(
        gateway: PaymentGateway,
        _ request: GatewayPaymentLinkRequest
    ) async throws -> PaymentLinkCreationResult {
        try await APIClient.shared.post(
            "/api/\(gateway.rawValue)/payment-links",
            body: request,
            timeout: APIClient.dashboardTimeout
        )
    }

    /// Tarjetas guardadas del contacto:
    /// Stripe `GET /api/stripe/contacts/:id/payment-methods`;
    /// Conekta/Rebill `GET /api/<gw>/contacts/:id/payment-sources`.
    /// Mercado Pago y CLIP NO exponen tarjetas guardadas.
    static func savedCards(gateway: PaymentGateway, contactID: String) async throws -> [SavedGatewayCard] {
        guard let component = gateway.savedCardsPathComponent else {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "\(gateway.displayName) no maneja tarjetas guardadas."
            )
        }
        return try await APIClient.shared.get(
            "/api/\(gateway.rawValue)/contacts/\(contactID)/\(component)",
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `POST /api/<gw>/saved-card-payments` — cobro directo con tarjeta
    /// guardada (stripe/conekta/rebill; conekta acepta `installments`).
    /// `payment.status` puede volver `paid` inmediato o pendiente
    /// («la pasarela está terminando de procesar»).
    static func chargeSavedCard(
        gateway: PaymentGateway,
        _ request: SavedCardPaymentRequest
    ) async throws -> SavedCardPaymentResult {
        guard gateway.supportsSavedCards else {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "\(gateway.displayName) no maneja cobros con tarjeta guardada."
            )
        }
        return try await APIClient.shared.post(
            "/api/\(gateway.rawValue)/saved-card-payments",
            body: request,
            timeout: APIClient.mediaTimeout
        )
    }

    /// `POST /api/<gw>/payment-plans` (stripe/conekta/rebill). Si se dio
    /// `paymentMethodId` el plan queda programado directo; si no, la respuesta
    /// trae `firstPaymentLink` o `cardSetupLink` para compartir.
    static func createPaymentPlan(
        gateway: PaymentGateway,
        _ request: GatewayPaymentPlanRequest
    ) async throws -> GatewayPaymentPlanResult {
        guard gateway.supportsPaymentPlans else {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "\(gateway.displayName) no maneja planes de pago."
            )
        }
        return try await APIClient.shared.post(
            "/api/\(gateway.rawValue)/payment-plans",
            body: request,
            timeout: APIClient.mediaTimeout
        )
    }

    /// `GET /api/contacts/:id/payment-link-delivery-options` — canales
    /// conectados del contacto para el panel «link listo» (gate `contacts`).
    static func deliveryOptions(contactID: String) async throws -> PaymentLinkDeliveryOptions {
        try await APIClient.shared.get("/api/contacts/\(contactID)/payment-link-delivery-options")
    }
}
