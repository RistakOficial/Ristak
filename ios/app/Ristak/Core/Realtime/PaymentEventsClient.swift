import Foundation

/// Scopes de los eventos de pagos (`payment_changed.scopes`).
enum PaymentRealtimeScope {
    static let transactions = "transactions"
    static let paymentPlans = "payment_plans"
    static let subscriptions = "subscriptions"
}

/// Payload de `payment_changed` (doc research/11 §4.3).
struct PaymentChangedRealtimeEvent: Decodable, Sendable, Equatable {
    let type: String
    /// Siempre incluye `transactions`; agrega `payment_plans`/`subscriptions`
    /// según el origen del pago.
    let scopes: [String]
    let paymentId: String
    let publicPaymentId: String
    let contactId: String
    /// lowercase: `paid|pending|failed|refunded|void|…`.
    let status: String
    let previousStatus: String
    let provider: String
    let method: String
    let receivedAt: String

    enum CodingKeys: String, CodingKey {
        case type, scopes, paymentId, publicPaymentId, contactId
        case status, previousStatus, provider, method, receivedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = container.flexibleString(forKey: .type) ?? ""
        scopes = (try? container.decodeIfPresent([String].self, forKey: .scopes)) ?? []
        paymentId = container.flexibleString(forKey: .paymentId) ?? ""
        publicPaymentId = container.flexibleString(forKey: .publicPaymentId) ?? ""
        contactId = container.flexibleString(forKey: .contactId) ?? ""
        status = container.flexibleString(forKey: .status) ?? ""
        previousStatus = container.flexibleString(forKey: .previousStatus) ?? ""
        provider = container.flexibleString(forKey: .provider) ?? ""
        method = container.flexibleString(forKey: .method) ?? ""
        receivedAt = container.flexibleString(forKey: .receivedAt) ?? ""
    }
}

/// Payload de `subscription_changed` (doc research/11 §4.3).
struct SubscriptionChangedRealtimeEvent: Decodable, Sendable, Equatable {
    let type: String
    let scopes: [String]
    let subscriptionId: String
    let contactId: String
    let status: String
    let previousStatus: String
    let provider: String
    let receivedAt: String

    enum CodingKeys: String, CodingKey {
        case type, scopes, subscriptionId, contactId
        case status, previousStatus, provider, receivedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = container.flexibleString(forKey: .type) ?? ""
        scopes = (try? container.decodeIfPresent([String].self, forKey: .scopes)) ?? []
        subscriptionId = container.flexibleString(forKey: .subscriptionId) ?? ""
        contactId = container.flexibleString(forKey: .contactId) ?? ""
        status = container.flexibleString(forKey: .status) ?? ""
        previousStatus = container.flexibleString(forKey: .previousStatus) ?? ""
        provider = container.flexibleString(forKey: .provider) ?? ""
        receivedAt = container.flexibleString(forKey: .receivedAt) ?? ""
    }
}

/// Evento tipado del stream de pagos.
enum PaymentRealtimeEvent: Sendable {
    case connected(serverTime: String?)
    /// Refrescar la(s) lista(s) indicadas por `scopes`.
    case paymentChanged(PaymentChangedRealtimeEvent)
    case subscriptionChanged(SubscriptionChangedRealtimeEvent)

    init?(frame: RistakServerSentEvent) {
        switch frame.name {
        case "connected":
            let payload = try? JSONDecoder().decode(
                ChatConnectedFramePayload.self,
                from: Data(frame.data.utf8)
            )
            self = .connected(serverTime: payload?.serverTime)
        case "payment_changed":
            guard let payload = try? JSONDecoder().decode(
                PaymentChangedRealtimeEvent.self,
                from: Data(frame.data.utf8)
            ) else { return nil }
            self = .paymentChanged(payload)
        case "subscription_changed":
            guard let payload = try? JSONDecoder().decode(
                SubscriptionChangedRealtimeEvent.self,
                from: Data(frame.data.utf8)
            ) else { return nil }
            self = .subscriptionChanged(payload)
        default:
            return nil
        }
    }
}

/// Cliente SSE de pagos — `GET /api/payment-events/stream` (doc research/11
/// §4). Requiere sesión + feature de licencia `payments` + módulo `payments`
/// (403 detiene el stream sin romper la pantalla). Conectarlo mientras la
/// sección Pagos esté visible; los eventos disparan refresh de las listas
/// según `scopes`.
final class PaymentEventsClient: Sendable {
    private let engine = RistakSSEStreamEngine(path: "/api/payment-events/stream")

    init() {}

    func start() async -> AsyncStream<PaymentRealtimeEvent> {
        let frames = await engine.start()
        let (stream, continuation) = AsyncStream<PaymentRealtimeEvent>.makeStream()
        let task = Task {
            for await frame in frames {
                if let event = PaymentRealtimeEvent(frame: frame) {
                    continuation.yield(event)
                }
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    func stop() async {
        await engine.stop()
    }
}
