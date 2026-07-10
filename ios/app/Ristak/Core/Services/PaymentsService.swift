import Foundation

/// Endpoints tipados de Transacciones y flujos de parcialidades
/// (doc research/08 §2). Módulo `payments`.
enum PaymentsService {
    // MARK: - Listado

    /// `GET /api/transactions`. REGLA (doc 08 gap 1): mandar SIEMPRE rango de
    /// fechas (`YYYY-MM-DD`, TZ del negocio) o `limit`, si no el backend
    /// devuelve TODO. Devuelve el envelope completo (data + pagination).
    static func transactions(
        page: Int? = nil,
        limit: Int? = nil,
        status: String? = nil,
        query: String? = nil,
        startDate: String? = nil,
        endDate: String? = nil,
        sortBy: String? = nil,
        sortOrder: String? = nil
    ) async throws -> TransactionsPage {
        let data = try await APIClient.shared.rawData(
            "/api/transactions",
            query: [
                "page": page.map(String.init),
                "limit": limit.map(String.init),
                "status": status,
                "q": query,
                "startDate": startDate,
                "endDate": endDate,
                "sortBy": sortBy,
                "sortOrder": sortOrder,
            ],
            timeout: APIClient.dashboardTimeout
        )
        do {
            let envelope = try JSONDecoder().decode(TransactionsListEnvelope.self, from: data)
            return TransactionsPage(
                transactions: envelope.data ?? [],
                pagination: envelope.pagination
            )
        } catch {
            throw RistakAPIError.decoding(error)
        }
    }

    /// `GET /api/transactions/:id` (agrega `contactSource`, atribución).
    static func transaction(id: String) async throws -> PaymentTransaction {
        try await APIClient.shared.get("/api/transactions/\(id)")
    }

    // MARK: - Crear / editar / borrar

    /// `POST /api/transactions` — pago manual. SIEMPRE manda `Idempotency-Key`
    /// (PAY-007): un reintento con la misma clave devuelve el pago existente
    /// sin duplicar. La `currency` del body es ignorada (fuerza
    /// `account_currency`).
    static func createManualPayment(
        _ request: ManualPaymentRequest,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> PaymentTransaction {
        try await postWithExtraHeaders(
            path: "/api/transactions",
            body: request,
            headers: ["Idempotency-Key": idempotencyKey]
        )
    }

    /// `PUT /api/transactions/:id` — subset de campos (doc 08 §2.4; reglas
    /// 422 para planes Stripe / invoices HighLevel llegan como mensaje).
    static func updateTransaction(id: String, _ request: ManualPaymentRequest) async throws -> PaymentTransaction {
        try await APIClient.shared.put("/api/transactions/\(id)", body: request)
    }

    /// `DELETE /api/transactions/:id` — pasa por el deletion guard (422 con
    /// mensajes específicos si pertenece a plan/suscripción/ledger).
    static func deleteTransaction(id: String) async throws -> APIAcknowledgment {
        try await APIClient.shared.delete("/api/transactions/\(id)")
    }

    // MARK: - Acciones (doc 08 §2.6)

    /// `POST /:id/refund` — SOLO marca `refunded` local; NO reembolsa en la
    /// pasarela (comunicarlo en UI, doc 08 gap 3).
    static func refund(id: String) async throws -> APIAcknowledgment {
        try await APIClient.shared.post("/api/transactions/\(id)/refund", body: RistakEmptyJSONBody())
    }

    /// `POST /:id/void` — anula pagos NO exitosos.
    static func voidPayment(id: String) async throws -> APIAcknowledgment {
        try await APIClient.shared.post("/api/transactions/\(id)/void", body: RistakEmptyJSONBody())
    }

    /// `POST /:id/record-payment` — marca `paid` (y en GHL si tiene invoice).
    static func recordPayment(id: String, _ request: RecordPaymentActionRequest = RecordPaymentActionRequest()) async throws -> APIAcknowledgment {
        try await APIClient.shared.post("/api/transactions/\(id)/record-payment", body: request)
    }

    /// `POST /:id/send` — solo pagos con invoice HighLevel.
    static func send(id: String) async throws -> APIAcknowledgment {
        try await APIClient.shared.post("/api/transactions/\(id)/send", body: RistakEmptyJSONBody())
    }

    /// `GET /:id/payment-link` → `data: { link }`; 400 si no tiene enlace.
    static func paymentLink(id: String) async throws -> String? {
        let result: TransactionPaymentLinkLookup = try await APIClient.shared.get("/api/transactions/\(id)/payment-link")
        return result.link
    }

    // MARK: - Resumen

    /// `GET /api/transactions/summary` — KPIs con periodo previo.
    static func summary(startDate: String, endDate: String) async throws -> TransactionsSummary {
        try await APIClient.shared.get(
            "/api/transactions/summary",
            query: ["startDate": startDate, "endDate": endDate],
            timeout: APIClient.dashboardTimeout
        )
    }

    // MARK: - Planes de pago (feature `payment_plans`, doc 08 §2.8)

    /// `GET /api/transactions/payment-plans` → `data: PaymentPlan[]`.
    static func paymentPlans(
        activeOnly: Bool = false,
        limit: Int? = nil,
        offset: Int? = nil
    ) async throws -> [PaymentPlanSummaryItem] {
        try await APIClient.shared.get(
            "/api/transactions/payment-plans",
            query: [
                "activeOnly": activeOnly ? "true" : nil,
                "limit": limit.map(String.init),
                "offset": offset.map(String.init),
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `POST /api/transactions/payment-plans/:scheduleId/action` — body
    /// `{ action, payload }`; `action ∈ activate|pause|cancel|delete|auto-payment`.
    static func paymentPlanAction(
        scheduleID: String,
        action: String,
        payload: RistakJSONValue? = nil
    ) async throws -> APIAcknowledgment {
        try await APIClient.shared.post(
            "/api/transactions/payment-plans/\(scheduleID)/action",
            body: PaymentPlanActionBody(action: action, payload: payload)
        )
    }

    // MARK: - Parcialidades HighLevel/local (feature `payment_plans`, doc 08 §2.9)

    /// `POST /api/transactions/payment-flows/installments`. La app valida que
    /// primer pago + restantes cuadren exactamente en unidades mínimas.
    static func createInstallmentsFlow(_ request: PaymentFlowInstallmentsRequest) async throws -> PaymentFlowInstallmentsResult {
        try await APIClient.shared.post(
            "/api/transactions/payment-flows/installments",
            body: request,
            timeout: APIClient.mediaTimeout
        )
    }

    // MARK: - POST con headers extra (Idempotency-Key)

    /// `APIClient` no expone headers custom; este helper arma el request
    /// autenticado con `authorizedRequest` y replica la tubería de errores
    /// (los hooks globales de 401/licencia no se disparan aquí — caso borde
    /// aceptado para el POST idempotente).
    private static func postWithExtraHeaders<T: Decodable>(
        path: String,
        body: some Encodable,
        headers: [String: String],
        timeout: TimeInterval = APIClient.defaultTimeout
    ) async throws -> T {
        var request = try await APIClient.shared.authorizedRequest(
            for: path,
            method: "POST",
            timeout: timeout
        )
        do {
            request.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw RistakAPIError(
                kind: .badRequest,
                status: 0,
                message: "No se pudo preparar la solicitud.",
                underlying: error
            )
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw RistakAPIError.network(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw RistakAPIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONDecoder().decode(RistakAPIErrorPayload.self, from: data)
            throw RistakAPIError.from(status: http.statusCode, payload: payload)
        }
        do {
            return try RistakEnvelopeDecoder.unwrap(data, decoder: JSONDecoder())
        } catch {
            throw RistakAPIError.decoding(error)
        }
    }
}

/// Envelope completo de `GET /api/transactions` (el genérico de `APIClient`
/// desenvuelve `data` y perdería `pagination`).
private struct TransactionsListEnvelope: Decodable {
    let success: Bool?
    let data: [PaymentTransaction]?
    let pagination: TransactionsPagination?

    enum CodingKeys: String, CodingKey {
        case success, data, pagination
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        data = try container.decodeIfPresent([PaymentTransaction].self, forKey: .data)
        pagination = try? container.decodeIfPresent(TransactionsPagination.self, forKey: .pagination)
    }
}

/// Body `{ action, payload }` de acciones de planes.
private struct PaymentPlanActionBody: Encodable {
    let action: String
    let payload: RistakJSONValue?
}

/// Body vacío `{}` para acciones POST sin parámetros.
struct RistakEmptyJSONBody: Encodable, Sendable {
    init() {}

    func encode(to encoder: Encoder) throws {
        _ = encoder.container(keyedBy: RistakDynamicCodingKey.self)
    }
}
