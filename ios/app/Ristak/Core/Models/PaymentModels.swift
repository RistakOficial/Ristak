import Foundation

// MARK: - Pasarelas (doc 08 §5)

enum PaymentGateway: String, Codable, CaseIterable, Sendable, Equatable {
    case stripe
    case conekta
    case mercadopago
    case clip
    case rebill

    var displayName: String {
        switch self {
        case .stripe: return "Stripe"
        case .conekta: return "Conekta"
        case .mercadopago: return "Mercado Pago"
        case .clip: return "CLIP"
        case .rebill: return "Rebill"
        }
    }

    /// Pasarelas con tarjetas guardadas + cobro directo (doc 08 §5.1).
    var supportsSavedCards: Bool {
        switch self {
        case .stripe, .conekta, .rebill: return true
        case .mercadopago, .clip: return false
        }
    }

    /// Segmento del endpoint de tarjetas guardadas
    /// (`payment-methods` en Stripe; `payment-sources` en Conekta/Rebill).
    var savedCardsPathComponent: String? {
        switch self {
        case .stripe: return "payment-methods"
        case .conekta, .rebill: return "payment-sources"
        case .mercadopago, .clip: return nil
        }
    }

    /// Pasarelas que la UI ofrece para planes de pago (paridad web/RN:
    /// MP existe en backend pero NO se ofrece — doc 08 gap 4).
    var supportsPaymentPlans: Bool {
        switch self {
        case .stripe, .conekta, .rebill: return true
        case .mercadopago, .clip: return false
        }
    }

    var supportsSubscriptions: Bool {
        switch self {
        case .stripe, .conekta, .mercadopago, .rebill: return true
        case .clip: return false
        }
    }

    /// Frecuencias de suscripción soportadas (doc 08 §4):
    /// Conekta NO acepta `daily`; Rebill SOLO `monthly|yearly`.
    var supportedSubscriptionIntervals: [String] {
        switch self {
        case .stripe, .mercadopago: return ["daily", "weekly", "monthly", "yearly"]
        case .conekta: return ["weekly", "monthly", "yearly"]
        case .rebill: return ["monthly", "yearly"]
        case .clip: return []
        }
    }
}

/// Reglas de MSI por pasarela (constantes de frontend replicadas — doc 08
/// §5.1 y gaps 13/14; el backend NO valida montos mínimos en todos los casos).
enum GatewayInstallmentRules {
    /// Stripe: MXN, monto ≥ $300, plazos hasta 3/6/9/12/18/24.
    static let stripeMinimumAmountMXN: Double = 300
    static let stripeTerms: [Int] = [3, 6, 9, 12, 18, 24]

    /// Conekta: mínimos por plazo (`CONEKTA_INSTALLMENT_TERMS`).
    static let conektaMinimumByTerm: [Int: Double] = [
        3: 300, 6: 600, 9: 900, 12: 1200, 18: 1800, 24: 2400,
    ]
    static let conektaTerms: [Int] = [3, 6, 9, 12, 18, 24]

    /// Mercado Pago: hasta 2/3/6/9/12/18/24 (o contado); MP decide plazos reales.
    static let mercadoPagoTerms: [Int] = [2, 3, 6, 9, 12, 18, 24]

    /// CLIP: MXN, monto ≥ $300, máx 24; CLIP decide plazos en su Dashboard.
    static let clipMinimumAmountMXN: Double = 300
    static let clipMaximumTerm = 24

    /// Rebill: 3–24, default 12; Rebill decide según cuenta/país/tarjeta.
    static let rebillTerms: [Int] = Array(3...24)
    static let rebillDefaultMaxTerm = 12

    /// ¿El plazo está disponible en Conekta para ese monto?
    static func conektaTermAvailable(_ term: Int, amount: Double) -> Bool {
        guard let minimum = conektaMinimumByTerm[term] else { return false }
        return amount >= minimum
    }
}

// MARK: - Estados de pago (doc 08 §1.1, §1.2)

enum PaymentTransactionStatus: String, Codable, CaseIterable, Sendable, Equatable {
    case draft, sent, scheduled, paid, pending, overdue, partial
    case void, refunded, failed, deleted

    /// Parse tolerante con los alias que el backend normaliza
    /// (`succeeded/completed/complete/fulfilled/success` → `paid`).
    static func parse(_ raw: String?) -> PaymentTransactionStatus? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch value {
        case "succeeded", "completed", "complete", "fulfilled", "success":
            return .paid
        default:
            return PaymentTransactionStatus(rawValue: value)
        }
    }

    var displayLabel: String {
        switch self {
        case .paid: return "Pagado"
        case .partial: return "Parcial"
        case .refunded: return "Reembolsado"
        case .failed: return "Fallido"
        case .pending: return "Pendiente"
        case .draft: return "Borrador"
        case .sent: return "Enviado"
        case .scheduled: return "Programado"
        case .overdue: return "Vencido"
        case .void: return "Anulado"
        case .deleted: return "Eliminado"
        }
    }

    /// "Pagos recibidos" en la UI móvil = `paid` y `partial` (doc 08 §7.2).
    var countsAsReceived: Bool { self == .paid || self == .partial }
}

/// Labels de método de pago de /movil (doc 08 §6.1).
enum PaymentMethodDisplay {
    static func label(for method: String?) -> String {
        switch (method ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "card", "direct_card", "saved_card": return "Tarjeta"
        case "bank_transfer", "transfer": return "Transferencia"
        case "cash": return "Efectivo"
        case "check": return "Cheque"
        case "paypal": return "PayPal"
        case "", "other": return "Otro"
        default: return "Otro"
        }
    }
}

// MARK: - Transacción (doc 08 §1.1, ~40 campos de `mapTransactionRow`)

struct PaymentTransaction: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    /// Momento del pago (ISO datetime).
    let date: String?
    let contactId: String?
    let contactName: String
    let email: String
    let phone: String
    let amount: Double
    let currency: String
    let method: String
    /// Estado crudo (usar `transactionStatus` para el enum).
    let status: String
    /// `'live' | 'test'`.
    let paymentMode: String
    let paymentProvider: String
    let paymentMethodCategory: String?
    let paymentMethodCategoryId: String?
    let paymentType: String?
    let paymentChannel: String?
    let paymentChannelId: String?
    let reference: String?
    let title: String
    let description: String?
    let createdAt: String?
    let updatedAt: String?
    let invoiceId: String?
    let invoiceNumber: String?
    let dueDate: String?
    let sentAt: String?
    let publicPaymentId: String?
    let paymentUrl: String?
    let stripePaymentIntentId: String?
    let stripeChargeId: String?
    let mercadoPagoPaymentId: String?
    let mercadoPagoPreferenceId: String?
    let conektaOrderId: String?
    let conektaChargeId: String?
    let conektaPaymentSourceId: String?
    let clipPaymentId: String?
    let clipReceiptNo: String?
    let rebillPaymentId: String?
    let rebillSubscriptionId: String?
    let rebillCustomerId: String?
    let rebillCardId: String?
    let paidAt: String?
    /// Solo en `GET /api/transactions/:id`.
    let contactSource: String?
    let attributionAdName: String?
    let attributionAdId: String?

    enum CodingKeys: String, CodingKey {
        case id, date, contactId, contactName, email, phone, amount, currency, method, status
        case paymentMode, paymentProvider
        case paymentMethodCategory, paymentMethodCategoryId, paymentType, paymentChannel, paymentChannelId
        case reference, title, description, createdAt, updatedAt
        case invoiceId, invoiceNumber, dueDate, sentAt, publicPaymentId, paymentUrl
        case stripePaymentIntentId, stripeChargeId
        case mercadoPagoPaymentId, mercadoPagoPreferenceId
        case conektaOrderId, conektaChargeId, conektaPaymentSourceId
        case clipPaymentId, clipReceiptNo
        case rebillPaymentId, rebillSubscriptionId, rebillCustomerId, rebillCardId
        case paidAt, contactSource, attributionAdName, attributionAdId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        date = container.flexibleString(forKey: .date)
        contactId = container.flexibleString(forKey: .contactId)
        contactName = container.flexibleString(forKey: .contactName) ?? ""
        email = container.flexibleString(forKey: .email) ?? ""
        phone = container.flexibleString(forKey: .phone) ?? ""
        amount = container.flexibleDouble(forKey: .amount) ?? 0
        currency = container.flexibleString(forKey: .currency) ?? ""
        method = container.flexibleString(forKey: .method) ?? "other"
        status = container.flexibleString(forKey: .status) ?? ""
        paymentMode = container.flexibleString(forKey: .paymentMode) ?? "live"
        paymentProvider = container.flexibleString(forKey: .paymentProvider) ?? "manual"
        paymentMethodCategory = container.flexibleString(forKey: .paymentMethodCategory)
        paymentMethodCategoryId = container.flexibleString(forKey: .paymentMethodCategoryId)
        paymentType = container.flexibleString(forKey: .paymentType)
        paymentChannel = container.flexibleString(forKey: .paymentChannel)
        paymentChannelId = container.flexibleString(forKey: .paymentChannelId)
        reference = container.flexibleString(forKey: .reference)
        title = container.flexibleString(forKey: .title) ?? "Pago"
        description = container.flexibleString(forKey: .description)
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        invoiceId = container.flexibleString(forKey: .invoiceId)
        invoiceNumber = container.flexibleString(forKey: .invoiceNumber)
        dueDate = container.flexibleString(forKey: .dueDate)
        sentAt = container.flexibleString(forKey: .sentAt)
        publicPaymentId = container.flexibleString(forKey: .publicPaymentId)
        paymentUrl = container.flexibleString(forKey: .paymentUrl)
        stripePaymentIntentId = container.flexibleString(forKey: .stripePaymentIntentId)
        stripeChargeId = container.flexibleString(forKey: .stripeChargeId)
        mercadoPagoPaymentId = container.flexibleString(forKey: .mercadoPagoPaymentId)
        mercadoPagoPreferenceId = container.flexibleString(forKey: .mercadoPagoPreferenceId)
        conektaOrderId = container.flexibleString(forKey: .conektaOrderId)
        conektaChargeId = container.flexibleString(forKey: .conektaChargeId)
        conektaPaymentSourceId = container.flexibleString(forKey: .conektaPaymentSourceId)
        clipPaymentId = container.flexibleString(forKey: .clipPaymentId)
        clipReceiptNo = container.flexibleString(forKey: .clipReceiptNo)
        rebillPaymentId = container.flexibleString(forKey: .rebillPaymentId)
        rebillSubscriptionId = container.flexibleString(forKey: .rebillSubscriptionId)
        rebillCustomerId = container.flexibleString(forKey: .rebillCustomerId)
        rebillCardId = container.flexibleString(forKey: .rebillCardId)
        paidAt = container.flexibleString(forKey: .paidAt)
        contactSource = container.flexibleString(forKey: .contactSource)
        attributionAdName = container.flexibleString(forKey: .attributionAdName)
        attributionAdId = container.flexibleString(forKey: .attributionAdId)
    }

    var transactionStatus: PaymentTransactionStatus? {
        PaymentTransactionStatus.parse(status)
    }

    /// Fecha para ordenar: `date || createdAt` (doc 08 gap 16).
    var sortDate: Date? {
        RistakDateParsing.date(fromISO: date) ?? RistakDateParsing.date(fromISO: createdAt)
    }

    /// Etiqueta de contacto: nombre → email → teléfono → «Cliente sin nombre».
    var contactDisplayLabel: String {
        if !contactName.isEmpty { return contactName }
        if !email.isEmpty { return email }
        if !phone.isEmpty { return phone }
        return "Cliente sin nombre"
    }
}

/// Objeto `pagination` del envelope de `GET /api/transactions`.
struct TransactionsPagination: Decodable, Sendable, Equatable {
    let page: Int
    let limit: Int
    let total: Int
    let totalPages: Int
    let hasNext: Bool
    let hasPrev: Bool

    enum CodingKeys: String, CodingKey {
        case page, limit, total, totalPages, hasNext, hasPrev
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        page = container.flexibleInt(forKey: .page) ?? 1
        limit = container.flexibleInt(forKey: .limit) ?? 0
        total = container.flexibleInt(forKey: .total) ?? 0
        totalPages = container.flexibleInt(forKey: .totalPages) ?? 0
        hasNext = container.flexibleBool(forKey: .hasNext) ?? false
        hasPrev = container.flexibleBool(forKey: .hasPrev) ?? false
    }
}

/// Página completa de transacciones (data + pagination del envelope).
struct TransactionsPage: Sendable {
    let transactions: [PaymentTransaction]
    let pagination: TransactionsPagination?
}

/// `GET /api/transactions/summary` → `data`.
struct TransactionsSummary: Decodable, Sendable, Equatable {
    let totalRevenue: Double
    let totalRevenuePrev: Double
    let completedPayments: Double
    let completedPaymentsPrev: Double
    let averageTicket: Double
    let averageTicketPrev: Double
    let refunds: Double
    let refundsPrev: Double

    enum CodingKeys: String, CodingKey {
        case totalRevenue, totalRevenuePrev, completedPayments, completedPaymentsPrev
        case averageTicket, averageTicketPrev, refunds, refundsPrev
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        totalRevenue = container.flexibleDouble(forKey: .totalRevenue) ?? 0
        totalRevenuePrev = container.flexibleDouble(forKey: .totalRevenuePrev) ?? 0
        completedPayments = container.flexibleDouble(forKey: .completedPayments) ?? 0
        completedPaymentsPrev = container.flexibleDouble(forKey: .completedPaymentsPrev) ?? 0
        averageTicket = container.flexibleDouble(forKey: .averageTicket) ?? 0
        averageTicketPrev = container.flexibleDouble(forKey: .averageTicketPrev) ?? 0
        refunds = container.flexibleDouble(forKey: .refunds) ?? 0
        refundsPrev = container.flexibleDouble(forKey: .refundsPrev) ?? 0
    }
}

// MARK: - Crear/editar pago manual (doc 08 §2.2, §2.4)

/// Body de `POST/PUT /api/transactions`. La `currency` es IGNORADA por el
/// backend (fuerza `account_currency`). `nil` se omite del JSON.
struct ManualPaymentRequest: Encodable, Sendable {
    var id: String?
    /// Requerido al crear; > 0 (400 «El monto debe ser mayor a 0»).
    var amount: Double?
    var currency: String?
    /// Default backend: `cash`.
    var method: String?
    /// Default backend: `paid`.
    var status: String?
    var reference: String?
    var title: String?
    var description: String?
    /// `YYYY-MM-DD` o ISO completo (ver normalización doc 08 §2.2).
    var date: String?
    var dueDate: String?
    var contactId: String?
    var contactName: String?
    var email: String?
    var phone: String?
    var paymentMode: String?
    /// Objeto opcional (`lineItems`, `tax`, etc.).
    var metadata: RistakJSONValue?

    init(
        id: String? = nil,
        amount: Double? = nil,
        currency: String? = nil,
        method: String? = nil,
        status: String? = nil,
        reference: String? = nil,
        title: String? = nil,
        description: String? = nil,
        date: String? = nil,
        dueDate: String? = nil,
        contactId: String? = nil,
        contactName: String? = nil,
        email: String? = nil,
        phone: String? = nil,
        paymentMode: String? = nil,
        metadata: RistakJSONValue? = nil
    ) {
        self.id = id
        self.amount = amount
        self.currency = currency
        self.method = method
        self.status = status
        self.reference = reference
        self.title = title
        self.description = description
        self.date = date
        self.dueDate = dueDate
        self.contactId = contactId
        self.contactName = contactName
        self.email = email
        self.phone = phone
        self.paymentMode = paymentMode
        self.metadata = metadata
    }
}

/// Body de `POST /api/transactions/:id/record-payment`.
struct RecordPaymentActionRequest: Encodable, Sendable {
    var amount: Double?
    var paymentDate: String?
    var paymentMethod: String?

    init(amount: Double? = nil, paymentDate: String? = nil, paymentMethod: String? = nil) {
        self.amount = amount
        self.paymentDate = paymentDate
        self.paymentMethod = paymentMethod
    }
}

/// `GET /api/transactions/:id/payment-link` → `data: { link }`.
struct TransactionPaymentLinkLookup: Decodable, Sendable {
    let link: String?

    enum CodingKeys: String, CodingKey {
        case link
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        link = container.flexibleString(forKey: .link)
    }
}

// MARK: - Productos (doc 08 §1.3, §3)

struct ProductPrice: Decodable, Sendable, Equatable {
    let id: String?
    let underscoreId: String?
    let localId: String?
    let ghlPriceId: String?
    let localProductId: String?
    let name: String?
    let amount: Double?
    /// Alias legacy de `amount`.
    let price: Double?
    let currency: String?
    let type: String?
    let sku: String?
    let syncStatus: String?

    enum CodingKeys: String, CodingKey {
        case id, localId, ghlPriceId, localProductId, name, amount, price, currency, type, sku, syncStatus
        case underscoreId = "_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        underscoreId = container.flexibleString(forKey: .underscoreId)
        localId = container.flexibleString(forKey: .localId)
        ghlPriceId = container.flexibleString(forKey: .ghlPriceId)
        localProductId = container.flexibleString(forKey: .localProductId)
        name = container.flexibleString(forKey: .name)
        amount = container.flexibleDouble(forKey: .amount)
        price = container.flexibleDouble(forKey: .price)
        currency = container.flexibleString(forKey: .currency)
        type = container.flexibleString(forKey: .type)
        sku = container.flexibleString(forKey: .sku)
        syncStatus = container.flexibleString(forKey: .syncStatus)
    }

    /// Regla de identidad: `localId || id || _id` (doc 08 §1.3).
    var effectiveID: String {
        for candidate in [localId, id, underscoreId] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return ""
    }

    var resolvedAmount: Double? { amount ?? price }
}

struct ProductItem: Decodable, Sendable, Equatable {
    let id: String?
    let underscoreId: String?
    let localId: String?
    let ghlProductId: String?
    let name: String
    let description: String?
    let currency: String?
    let productType: String?
    let source: String?
    let syncStatus: String?
    let syncError: String?
    let gigstackProductKey: String?
    let gigstackUnitKey: String?
    let gigstackUnitName: String?
    let prices: [ProductPrice]

    enum CodingKeys: String, CodingKey {
        case id, localId, ghlProductId, name, description, currency, productType
        case source, syncStatus, syncError
        case gigstackProductKey, gigstackUnitKey, gigstackUnitName, prices
        case underscoreId = "_id"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        underscoreId = container.flexibleString(forKey: .underscoreId)
        localId = container.flexibleString(forKey: .localId)
        ghlProductId = container.flexibleString(forKey: .ghlProductId)
        name = container.flexibleString(forKey: .name) ?? ""
        description = container.flexibleString(forKey: .description)
        currency = container.flexibleString(forKey: .currency)
        productType = container.flexibleString(forKey: .productType)
        source = container.flexibleString(forKey: .source)
        syncStatus = container.flexibleString(forKey: .syncStatus)
        syncError = container.flexibleString(forKey: .syncError)
        gigstackProductKey = container.flexibleString(forKey: .gigstackProductKey)
        gigstackUnitKey = container.flexibleString(forKey: .gigstackUnitKey)
        gigstackUnitName = container.flexibleString(forKey: .gigstackUnitName)
        prices = (try? container.decodeIfPresent([ProductPrice].self, forKey: .prices)) ?? []
    }

    /// Regla de identidad: `localId || id || _id`.
    var effectiveID: String {
        for candidate in [localId, id, underscoreId] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return ""
    }
}

/// Precio dentro del payload de guardado de producto.
struct ProductPriceInput: Encodable, Sendable {
    var id: String?
    var localId: String?
    var name: String
    var amount: Double
    var currency: String?
    var type: String
    var sku: String?
    var description: String?

    init(
        id: String? = nil,
        localId: String? = nil,
        name: String,
        amount: Double,
        currency: String? = nil,
        type: String = "one_time",
        sku: String? = nil,
        description: String? = nil
    ) {
        self.id = id
        self.localId = localId
        self.name = name
        self.amount = amount
        self.currency = currency
        self.type = type
        self.sku = sku
        self.description = description
    }
}

/// Body de `POST/PUT /api/products`.
struct ProductSaveRequest: Encodable, Sendable {
    var name: String
    var description: String?
    var currency: String?
    var productType: String?
    var availableInStore: Bool?
    var gigstackProductKey: String?
    var gigstackUnitKey: String?
    var gigstackUnitName: String?
    var prices: [ProductPriceInput]?

    init(
        name: String,
        description: String? = nil,
        currency: String? = nil,
        productType: String? = nil,
        availableInStore: Bool? = nil,
        gigstackProductKey: String? = nil,
        gigstackUnitKey: String? = nil,
        gigstackUnitName: String? = nil,
        prices: [ProductPriceInput]? = nil
    ) {
        self.name = name
        self.description = description
        self.currency = currency
        self.productType = productType
        self.availableInStore = availableInStore
        self.gigstackProductKey = gigstackProductKey
        self.gigstackUnitKey = gigstackUnitKey
        self.gigstackUnitName = gigstackUnitName
        self.prices = prices
    }
}

/// `GET /api/products` → envelope RAÍZ `{ success, products, total, source }`
/// (⚠️ NO usa la clave `data`).
struct ProductsListResult: Decodable, Sendable {
    let success: Bool?
    let products: [ProductItem]
    let total: Int
    let source: String?

    enum CodingKeys: String, CodingKey {
        case success, products, total, source
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        products = (try? container.decodeIfPresent([ProductItem].self, forKey: .products)) ?? []
        total = container.flexibleInt(forKey: .total) ?? 0
        source = container.flexibleString(forKey: .source)
    }
}

/// `POST/PUT /api/products*` → `{ success, product, message }`.
struct ProductMutationResult: Decodable, Sendable {
    let success: Bool?
    let product: ProductItem?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case success, product, message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        product = try? container.decodeIfPresent(ProductItem.self, forKey: .product)
        message = container.flexibleString(forKey: .message)
    }
}

/// `POST /api/products/:id/prices` → `{ success, price, message }`.
struct ProductPriceMutationResult: Decodable, Sendable {
    let success: Bool?
    let price: ProductPrice?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case success, price, message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        price = try? container.decodeIfPresent(ProductPrice.self, forKey: .price)
        message = container.flexibleString(forKey: .message)
    }
}

// MARK: - Suscripciones (doc 08 §1.4, §4)

enum PaymentSubscriptionStatus: String, Codable, CaseIterable, Sendable, Equatable {
    case draft, active, trialing, paused, cancelled, incomplete
    case pastDue = "past_due"

    static func parse(_ raw: String?) -> PaymentSubscriptionStatus? {
        guard let raw else { return nil }
        return PaymentSubscriptionStatus(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    var displayLabel: String {
        switch self {
        case .draft: return "Borrador"
        case .active: return "Activa"
        case .trialing: return "En prueba"
        case .paused: return "Pausada"
        case .cancelled: return "Cancelada"
        case .incomplete: return "Incompleta"
        case .pastDue: return "Vencida"
        }
    }

    /// Resumen backend: activos = active|trialing; vencidos = past_due|incomplete.
    var countsAsActive: Bool { self == .active || self == .trialing }
    var countsAsPastDue: Bool { self == .pastDue || self == .incomplete }
}

struct PaymentSubscription: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let contactId: String?
    let contactName: String?
    let contactEmail: String?
    let contactPhone: String?
    let name: String
    let description: String?
    let status: String
    let amount: Double
    let currency: String?
    /// `daily|weekly|monthly|yearly`.
    let intervalType: String
    let intervalCount: Int
    let startDate: String?
    let nextRunAt: String?
    let currentPeriodStart: String?
    let currentPeriodEnd: String?
    let cancelAt: String?
    let cancelledAt: String?
    let paymentMethod: String?
    let paymentProvider: String?
    let paymentMode: String?
    let source: String?
    let createdAt: String?
    let updatedAt: String?
    // Stripe
    let stripeCustomerId: String?
    let stripeSubscriptionId: String?
    let stripeCheckoutUrl: String?
    // Mercado Pago
    let mercadoPagoPreapprovalId: String?
    let mercadoPagoInitPoint: String?
    let mercadoPagoSandboxInitPoint: String?
    let mercadoPagoNextPaymentDate: String?
    // Conekta
    let conektaCustomerId: String?
    let conektaSubscriptionId: String?
    let conektaNextBillingAt: String?
    let conektaCheckoutUrl: String?
    // Rebill
    let rebillSubscriptionId: String?
    let rebillPaymentLinkUrl: String?
    let rebillCheckoutUrl: String?
    let rebillNextChargeAt: String?
    // Pago de arranque
    let subscriptionStartPaymentId: String?
    let subscriptionStartPublicPaymentId: String?
    let subscriptionStartPaymentProvider: String?
    let subscriptionStartPaymentStatus: String?
    let subscriptionStartUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, contactId, contactName, contactEmail, contactPhone
        case name, description, status, amount, currency
        case intervalType, intervalCount, startDate, nextRunAt
        case currentPeriodStart, currentPeriodEnd, cancelAt, cancelledAt
        case paymentMethod, paymentProvider, paymentMode, source, createdAt, updatedAt
        case stripeCustomerId, stripeSubscriptionId, stripeCheckoutUrl
        case mercadoPagoPreapprovalId, mercadoPagoInitPoint, mercadoPagoSandboxInitPoint, mercadoPagoNextPaymentDate
        case conektaCustomerId, conektaSubscriptionId, conektaNextBillingAt, conektaCheckoutUrl
        case rebillSubscriptionId, rebillPaymentLinkUrl, rebillCheckoutUrl, rebillNextChargeAt
        case subscriptionStartPaymentId, subscriptionStartPublicPaymentId
        case subscriptionStartPaymentProvider, subscriptionStartPaymentStatus, subscriptionStartUrl
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        contactId = container.flexibleString(forKey: .contactId)
        contactName = container.flexibleString(forKey: .contactName)
        contactEmail = container.flexibleString(forKey: .contactEmail)
        contactPhone = container.flexibleString(forKey: .contactPhone)
        name = container.flexibleString(forKey: .name) ?? ""
        description = container.flexibleString(forKey: .description)
        status = container.flexibleString(forKey: .status) ?? ""
        amount = container.flexibleDouble(forKey: .amount) ?? 0
        currency = container.flexibleString(forKey: .currency)
        intervalType = container.flexibleString(forKey: .intervalType) ?? "monthly"
        intervalCount = container.flexibleInt(forKey: .intervalCount) ?? 1
        startDate = container.flexibleString(forKey: .startDate)
        nextRunAt = container.flexibleString(forKey: .nextRunAt)
        currentPeriodStart = container.flexibleString(forKey: .currentPeriodStart)
        currentPeriodEnd = container.flexibleString(forKey: .currentPeriodEnd)
        cancelAt = container.flexibleString(forKey: .cancelAt)
        cancelledAt = container.flexibleString(forKey: .cancelledAt)
        paymentMethod = container.flexibleString(forKey: .paymentMethod)
        paymentProvider = container.flexibleString(forKey: .paymentProvider)
        paymentMode = container.flexibleString(forKey: .paymentMode)
        source = container.flexibleString(forKey: .source)
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        stripeCustomerId = container.flexibleString(forKey: .stripeCustomerId)
        stripeSubscriptionId = container.flexibleString(forKey: .stripeSubscriptionId)
        stripeCheckoutUrl = container.flexibleString(forKey: .stripeCheckoutUrl)
        mercadoPagoPreapprovalId = container.flexibleString(forKey: .mercadoPagoPreapprovalId)
        mercadoPagoInitPoint = container.flexibleString(forKey: .mercadoPagoInitPoint)
        mercadoPagoSandboxInitPoint = container.flexibleString(forKey: .mercadoPagoSandboxInitPoint)
        mercadoPagoNextPaymentDate = container.flexibleString(forKey: .mercadoPagoNextPaymentDate)
        conektaCustomerId = container.flexibleString(forKey: .conektaCustomerId)
        conektaSubscriptionId = container.flexibleString(forKey: .conektaSubscriptionId)
        conektaNextBillingAt = container.flexibleString(forKey: .conektaNextBillingAt)
        conektaCheckoutUrl = container.flexibleString(forKey: .conektaCheckoutUrl)
        rebillSubscriptionId = container.flexibleString(forKey: .rebillSubscriptionId)
        rebillPaymentLinkUrl = container.flexibleString(forKey: .rebillPaymentLinkUrl)
        rebillCheckoutUrl = container.flexibleString(forKey: .rebillCheckoutUrl)
        rebillNextChargeAt = container.flexibleString(forKey: .rebillNextChargeAt)
        subscriptionStartPaymentId = container.flexibleString(forKey: .subscriptionStartPaymentId)
        subscriptionStartPublicPaymentId = container.flexibleString(forKey: .subscriptionStartPublicPaymentId)
        subscriptionStartPaymentProvider = container.flexibleString(forKey: .subscriptionStartPaymentProvider)
        subscriptionStartPaymentStatus = container.flexibleString(forKey: .subscriptionStartPaymentStatus)
        subscriptionStartUrl = container.flexibleString(forKey: .subscriptionStartUrl)
    }

    var subscriptionStatus: PaymentSubscriptionStatus? {
        PaymentSubscriptionStatus.parse(status)
    }

    /// Link de activación a compartir (doc 08 §4): MP → initPoint (sandbox en
    /// test); Rebill → paymentLink/checkout; genérico → `subscriptionStartUrl`.
    var activationLink: String? {
        let candidates: [String?]
        switch (paymentProvider ?? "").lowercased() {
        case "mercadopago":
            candidates = paymentMode == "test"
                ? [mercadoPagoSandboxInitPoint, mercadoPagoInitPoint, subscriptionStartUrl]
                : [mercadoPagoInitPoint, subscriptionStartUrl]
        case "rebill":
            candidates = [rebillPaymentLinkUrl, rebillCheckoutUrl, subscriptionStartUrl]
        default:
            candidates = [subscriptionStartUrl, stripeCheckoutUrl, conektaCheckoutUrl]
        }
        return candidates.compactMap { $0 }.first { !$0.isEmpty }
    }
}

/// Resumen de `GET /api/subscriptions`.
struct SubscriptionsSummary: Decodable, Sendable, Equatable {
    let total: Int
    let active: Int
    let paused: Int
    let pastDue: Int
    let monthlyRevenue: Double
    let nextRunAt: String?

    enum CodingKeys: String, CodingKey {
        case total, active, paused, pastDue, monthlyRevenue, nextRunAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        total = container.flexibleInt(forKey: .total) ?? 0
        active = container.flexibleInt(forKey: .active) ?? 0
        paused = container.flexibleInt(forKey: .paused) ?? 0
        pastDue = container.flexibleInt(forKey: .pastDue) ?? 0
        monthlyRevenue = container.flexibleDouble(forKey: .monthlyRevenue) ?? 0
        nextRunAt = container.flexibleString(forKey: .nextRunAt)
    }
}

/// `GET /api/subscriptions` → `data: { subscriptions, summary }`.
struct SubscriptionsList: Decodable, Sendable {
    let subscriptions: [PaymentSubscription]
    let summary: SubscriptionsSummary?

    enum CodingKeys: String, CodingKey {
        case subscriptions, summary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        subscriptions = (try? container.decodeIfPresent([PaymentSubscription].self, forKey: .subscriptions)) ?? []
        summary = try? container.decodeIfPresent(SubscriptionsSummary.self, forKey: .summary)
    }
}

/// Payload de `POST/PUT /api/subscriptions` (doc 08 §4).
struct SubscriptionPayload: Encodable, Sendable {
    var contactId: String?
    var contactName: String?
    var contactEmail: String?
    var contactPhone: String?
    var name: String
    var description: String?
    var status: String?
    var amount: Double
    var currency: String?
    var intervalType: String
    var intervalCount: Int
    var startDate: String?
    var nextRunAt: String?
    var cancelAt: String?
    /// `stripe_saved_card`, `conekta_subscription`, `mercadopago_subscription`,
    /// `rebill_subscription`, `stripe_link`, `conekta_link`… (doc 08 §4).
    var paymentMethod: String?
    var paymentProvider: String?
    var paymentMode: String?
    var source: String?
    var metadata: RistakJSONValue?

    init(
        contactId: String? = nil,
        contactName: String? = nil,
        contactEmail: String? = nil,
        contactPhone: String? = nil,
        name: String,
        description: String? = nil,
        status: String? = nil,
        amount: Double,
        currency: String? = nil,
        intervalType: String,
        intervalCount: Int = 1,
        startDate: String? = nil,
        nextRunAt: String? = nil,
        cancelAt: String? = nil,
        paymentMethod: String? = nil,
        paymentProvider: String? = nil,
        paymentMode: String? = nil,
        source: String? = nil,
        metadata: RistakJSONValue? = nil
    ) {
        self.contactId = contactId
        self.contactName = contactName
        self.contactEmail = contactEmail
        self.contactPhone = contactPhone
        self.name = name
        self.description = description
        self.status = status
        self.amount = amount
        self.currency = currency
        self.intervalType = intervalType
        self.intervalCount = intervalCount
        self.startDate = startDate
        self.nextRunAt = nextRunAt
        self.cancelAt = cancelAt
        self.paymentMethod = paymentMethod
        self.paymentProvider = paymentProvider
        self.paymentMode = paymentMode
        self.source = source
        self.metadata = metadata
    }
}

/// Acción de `POST /api/subscriptions/:id/action`.
enum PaymentSubscriptionAction: String, Sendable {
    case pause
    case activate
    case resume
    case cancel
    case markPastDue = "mark_past_due"
}

// MARK: - Planes de pago (doc 08 §1.5, §2.8)

struct PaymentPlanSummaryItem: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let title: String?
    let status: String
    let total: Double
    let currency: String?
    let contactId: String?
    let contactName: String?
    let email: String?
    let phone: String?
    let description: String?
    let startDate: String?
    let nextRunAt: String?
    let endDate: String?
    let recurrenceLabel: String?
    let liveMode: Bool?
    let deleted: Bool?
    let itemCount: Int?
    let source: String?
    let createdAt: String?
    let updatedAt: String?
    let sortDate: String?

    enum CodingKeys: String, CodingKey {
        case id, name, title, status, total, currency
        case contactId, contactName, email, phone, description
        case startDate, nextRunAt, endDate, recurrenceLabel
        case liveMode, deleted, itemCount, source, createdAt, updatedAt, sortDate
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        name = container.flexibleString(forKey: .name) ?? ""
        title = container.flexibleString(forKey: .title)
        status = container.flexibleString(forKey: .status) ?? ""
        total = container.flexibleDouble(forKey: .total) ?? 0
        currency = container.flexibleString(forKey: .currency)
        contactId = container.flexibleString(forKey: .contactId)
        contactName = container.flexibleString(forKey: .contactName)
        email = container.flexibleString(forKey: .email)
        phone = container.flexibleString(forKey: .phone)
        description = container.flexibleString(forKey: .description)
        startDate = container.flexibleString(forKey: .startDate)
        nextRunAt = container.flexibleString(forKey: .nextRunAt)
        endDate = container.flexibleString(forKey: .endDate)
        recurrenceLabel = container.flexibleString(forKey: .recurrenceLabel)
        liveMode = container.flexibleBool(forKey: .liveMode)
        deleted = container.flexibleBool(forKey: .deleted)
        itemCount = container.flexibleInt(forKey: .itemCount)
        source = container.flexibleString(forKey: .source)
        createdAt = container.flexibleString(forKey: .createdAt)
        updatedAt = container.flexibleString(forKey: .updatedAt)
        sortDate = container.flexibleString(forKey: .sortDate)
    }
}

/// Estados del flujo de parcialidades (doc 08 §1.6).
enum PaymentFlowState: String, Codable, CaseIterable, Sendable {
    case draft
    case firstPaymentPending = "first_payment_pending"
    case firstPaymentRegistered = "first_payment_registered"
    case offlinePaymentRegistered = "offline_payment_registered"
    case waitingCardAuthorization = "waiting_card_authorization"
    case installmentPlanCreated = "installment_plan_created"
    case installmentPlanActive = "installment_plan_active"
    case cancelled

    static func parse(_ raw: String?) -> PaymentFlowState? {
        guard let raw else { return nil }
        return PaymentFlowState(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}

/// Contacto embebido en payloads de planes/parcialidades.
struct PaymentPlanContact: Encodable, Sendable {
    var id: String
    var name: String?
    var email: String?
    var phone: String?

    init(id: String, name: String? = nil, email: String? = nil, phone: String? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.phone = phone
    }
}

/// Primer pago de un plan/flujo de parcialidades.
struct PaymentPlanFirstPayment: Encodable, Sendable {
    /// `false` o `amount <= 0` ⇒ sin enganche.
    var enabled: Bool
    /// `"amount" | "percentage"` (solo flujo installments).
    var type: String?
    var value: Double?
    var amount: Double
    /// `YYYY-MM-DD`.
    var date: String?
    var frequency: String?
    /// `card|bank_transfer|cash|deposit|none|…` — requerido si `enabled`.
    var method: String?

    init(
        enabled: Bool,
        type: String? = nil,
        value: Double? = nil,
        amount: Double,
        date: String? = nil,
        frequency: String? = nil,
        method: String? = nil
    ) {
        self.enabled = enabled
        self.type = type
        self.value = value
        self.amount = amount
        self.date = date
        self.frequency = frequency
        self.method = method
    }
}

/// Pago restante programado de un plan.
struct PaymentPlanRemainingPayment: Encodable, Sendable {
    var sequence: Int
    var type: String
    var value: Double
    var amount: Double
    var percentage: Double?
    /// `YYYY-MM-DD`.
    var dueDate: String
    var frequency: String?

    init(
        sequence: Int,
        type: String = "amount",
        value: Double,
        amount: Double,
        percentage: Double? = nil,
        dueDate: String,
        frequency: String? = nil
    ) {
        self.sequence = sequence
        self.type = type
        self.value = value
        self.amount = amount
        self.percentage = percentage
        self.dueDate = dueDate
        self.frequency = frequency
    }
}

/// Canales de envío del flujo de parcialidades HighLevel/local.
struct PaymentFlowChannels: Encodable, Sendable {
    var email: Bool
    var sms: Bool
    var whatsapp: Bool

    init(email: Bool = false, sms: Bool = false, whatsapp: Bool = false) {
        self.email = email
        self.sms = sms
        self.whatsapp = whatsapp
    }
}

enum PaymentPlanAmountMath {
    private static let zeroDecimalCurrencies: Set<String> = [
        "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
        "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
    ]

    static func minorUnitFactor(currency: String) -> Int64 {
        zeroDecimalCurrencies.contains(currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()) ? 1 : 100
    }

    static func minorUnits(_ value: Double, currency: String) -> Int64? {
        guard value.isFinite else { return nil }
        let rounded = (value * Double(minorUnitFactor(currency: currency))).rounded()
        guard rounded >= Double(Int64.min), rounded <= Double(Int64.max) else { return nil }
        return Int64(rounded)
    }
}

/// Body de `POST /api/transactions/payment-flows/installments` (doc 08 §2.9).
/// Regla: primer pago + restantes debe coincidir exactamente en unidades mínimas.
struct PaymentFlowInstallmentsRequest: Encodable, Sendable {
    var contact: PaymentPlanContact
    var totalAmount: Double
    /// Ignorada: el backend fuerza `account_currency`.
    var currency: String?
    var description: String?
    var invoicePayload: RistakJSONValue?
    var firstPayment: PaymentPlanFirstPayment
    var remainingAutomatic: Bool
    var remainingFrequency: String
    var remainingPayments: [PaymentPlanRemainingPayment]
    var channels: PaymentFlowChannels

    init(
        contact: PaymentPlanContact,
        totalAmount: Double,
        currency: String? = nil,
        description: String? = nil,
        invoicePayload: RistakJSONValue? = nil,
        firstPayment: PaymentPlanFirstPayment,
        remainingAutomatic: Bool = true,
        remainingFrequency: String = "monthly",
        remainingPayments: [PaymentPlanRemainingPayment],
        channels: PaymentFlowChannels = PaymentFlowChannels()
    ) {
        self.contact = contact
        self.totalAmount = totalAmount
        self.currency = currency
        self.description = description
        self.invoicePayload = invoicePayload
        self.firstPayment = firstPayment
        self.remainingAutomatic = remainingAutomatic
        self.remainingFrequency = remainingFrequency
        self.remainingPayments = remainingPayments
        self.channels = channels
    }
}

/// Respuesta RAÍZ de installments (`{ success, message, flowId, … }` sin `data`).
struct PaymentFlowInstallmentsResult: Decodable, Sendable {
    let success: Bool?
    let message: String?
    let flowId: String?
    let currentState: String?
    let paymentMode: String?
    let firstPaymentInvoiceId: String?
    let firstPaymentLink: String?
    let cardSetupInvoiceId: String?
    let cardSetupPaymentLink: String?
    let cardSetupSendMethod: String?

    enum CodingKeys: String, CodingKey {
        case success, message, flowId, currentState, paymentMode
        case firstPaymentInvoiceId, firstPaymentLink
        case cardSetupInvoiceId, cardSetupPaymentLink, cardSetupSendMethod
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success)
        message = container.flexibleString(forKey: .message)
        flowId = container.flexibleString(forKey: .flowId)
        currentState = container.flexibleString(forKey: .currentState)
        paymentMode = container.flexibleString(forKey: .paymentMode)
        firstPaymentInvoiceId = container.flexibleString(forKey: .firstPaymentInvoiceId)
        firstPaymentLink = container.flexibleString(forKey: .firstPaymentLink)
        cardSetupInvoiceId = container.flexibleString(forKey: .cardSetupInvoiceId)
        cardSetupPaymentLink = container.flexibleString(forKey: .cardSetupPaymentLink)
        cardSetupSendMethod = container.flexibleString(forKey: .cardSetupSendMethod)
    }

    var flowState: PaymentFlowState? { PaymentFlowState.parse(currentState) }
}

// MARK: - Links de pago por pasarela (doc 08 §5.3)

/// Opción de MSI de un cobro.
struct PaymentInstallmentsOption: Encodable, Sendable {
    var enabled: Bool
    var maxInstallments: Int

    init(enabled: Bool, maxInstallments: Int = 12) {
        self.enabled = enabled
        self.maxInstallments = maxInstallments
    }
}

/// Line item del cobro (invoice/link).
struct PaymentLineItem: Encodable, Sendable {
    var name: String
    var description: String?
    var amount: Double
    var qty: Int
    var currency: String?
    var priceId: String?
    var productId: String?

    init(
        name: String,
        description: String? = nil,
        amount: Double,
        qty: Int = 1,
        currency: String? = nil,
        priceId: String? = nil,
        productId: String? = nil
    ) {
        self.name = name
        self.description = description
        self.amount = amount
        self.qty = qty
        self.currency = currency
        self.priceId = priceId
        self.productId = productId
    }
}

/// Payload común de `POST /api/<gw>/payment-links` (idéntico para las 5
/// pasarelas). `amount` = BASE gravable; el backend recalcula el impuesto.
struct GatewayPaymentLinkRequest: Encodable, Sendable {
    var contactId: String?
    var contactName: String?
    var email: String?
    var phone: String?
    var amount: Double
    /// Informativa; el backend usa la moneda configurada.
    var currency: String?
    /// Default backend `true`; `false` desactiva impuestos en este cobro.
    var applyTax: Bool?
    /// `"exclusive" | "inclusive"`.
    var taxCalculationMode: String?
    var title: String?
    var description: String?
    /// `YYYY-MM-DD`.
    var dueDate: String?
    var source: String?
    var lineItems: [PaymentLineItem]?
    var installments: PaymentInstallmentsOption?

    init(
        contactId: String? = nil,
        contactName: String? = nil,
        email: String? = nil,
        phone: String? = nil,
        amount: Double,
        currency: String? = nil,
        applyTax: Bool? = nil,
        taxCalculationMode: String? = nil,
        title: String? = nil,
        description: String? = nil,
        dueDate: String? = nil,
        source: String? = nil,
        lineItems: [PaymentLineItem]? = nil,
        installments: PaymentInstallmentsOption? = nil
    ) {
        self.contactId = contactId
        self.contactName = contactName
        self.email = email
        self.phone = phone
        self.amount = amount
        self.currency = currency
        self.applyTax = applyTax
        self.taxCalculationMode = taxCalculationMode
        self.title = title
        self.description = description
        self.dueDate = dueDate
        self.source = source
        self.lineItems = lineItems
        self.installments = installments
    }
}

/// Contacto embebido en `PublicPayment`.
struct PaymentLinkContact: Decodable, Sendable, Equatable {
    let id: String?
    let name: String?
    let email: String?
    let phone: String?

    enum CodingKeys: String, CodingKey {
        case id, name, email, phone
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        name = container.flexibleString(forKey: .name)
        email = container.flexibleString(forKey: .email)
        phone = container.flexibleString(forKey: .phone)
    }
}

/// Subset tolerante del `PublicPayment` por pasarela (doc 08 §5.3).
struct PublicPaymentSummary: Decodable, Sendable, Equatable {
    let id: String?
    let publicPaymentId: String?
    let paymentUrl: String?
    let status: String?
    let amount: Double?
    let currency: String?
    let title: String?
    let description: String?
    let dueDate: String?
    let sentAt: String?
    let paidAt: String?
    let timezone: String?
    let paymentMode: String?
    let provider: String?
    let contact: PaymentLinkContact?

    enum CodingKeys: String, CodingKey {
        case id, publicPaymentId, paymentUrl, status, amount, currency
        case title, description, dueDate, sentAt, paidAt, timezone
        case paymentMode, provider, contact
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id)
        publicPaymentId = container.flexibleString(forKey: .publicPaymentId)
        paymentUrl = container.flexibleString(forKey: .paymentUrl)
        status = container.flexibleString(forKey: .status)
        amount = container.flexibleDouble(forKey: .amount)
        currency = container.flexibleString(forKey: .currency)
        title = container.flexibleString(forKey: .title)
        description = container.flexibleString(forKey: .description)
        dueDate = container.flexibleString(forKey: .dueDate)
        sentAt = container.flexibleString(forKey: .sentAt)
        paidAt = container.flexibleString(forKey: .paidAt)
        timezone = container.flexibleString(forKey: .timezone)
        paymentMode = container.flexibleString(forKey: .paymentMode)
        provider = container.flexibleString(forKey: .provider)
        contact = try? container.decodeIfPresent(PaymentLinkContact.self, forKey: .contact)
    }
}

/// `POST /api/<gw>/payment-links` → `data: { payment, paymentUrl,
/// publicPaymentId }` (Mercado Pago agrega `preferenceId`).
struct PaymentLinkCreationResult: Decodable, Sendable {
    let payment: PublicPaymentSummary?
    let paymentUrl: String?
    let publicPaymentId: String?
    let preferenceId: String?

    enum CodingKeys: String, CodingKey {
        case payment, paymentUrl, publicPaymentId, preferenceId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        payment = try? container.decodeIfPresent(PublicPaymentSummary.self, forKey: .payment)
        paymentUrl = container.flexibleString(forKey: .paymentUrl)
        publicPaymentId = container.flexibleString(forKey: .publicPaymentId)
        preferenceId = container.flexibleString(forKey: .preferenceId)
    }
}

// MARK: - Tarjetas guardadas (doc 08 §1.7, §5.4)

/// Tarjeta guardada unificada (Stripe `payment-methods`, Conekta/Rebill
/// `payment-sources`). Campos ausentes por pasarela quedan `nil`.
struct SavedGatewayCard: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let contactId: String?
    let stripeCustomerId: String?
    let stripePaymentMethodId: String?
    let conektaCustomerId: String?
    let conektaPaymentSourceId: String?
    let rebillCustomerId: String?
    let rebillCardId: String?
    let brand: String?
    let last4: String?
    let expMonth: Int?
    let expYear: Int?
    let funding: String?
    let country: String?
    let name: String?
    /// `'test' | 'live'`.
    let mode: String?
    let isDefault: Bool
    /// Ej. «VISA •••• 4242».
    let label: String?
    /// Ej. «vence 12/27».
    let expiresLabel: String?

    enum CodingKeys: String, CodingKey {
        case id, contactId
        case stripeCustomerId, stripePaymentMethodId
        case conektaCustomerId, conektaPaymentSourceId
        case rebillCustomerId, rebillCardId
        case brand, last4, expMonth, expYear, funding, country, name
        case mode, isDefault, label, expiresLabel
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        contactId = container.flexibleString(forKey: .contactId)
        stripeCustomerId = container.flexibleString(forKey: .stripeCustomerId)
        stripePaymentMethodId = container.flexibleString(forKey: .stripePaymentMethodId)
        conektaCustomerId = container.flexibleString(forKey: .conektaCustomerId)
        conektaPaymentSourceId = container.flexibleString(forKey: .conektaPaymentSourceId)
        rebillCustomerId = container.flexibleString(forKey: .rebillCustomerId)
        rebillCardId = container.flexibleString(forKey: .rebillCardId)
        brand = container.flexibleString(forKey: .brand)
        last4 = container.flexibleString(forKey: .last4)
        expMonth = container.flexibleInt(forKey: .expMonth)
        expYear = container.flexibleInt(forKey: .expYear)
        funding = container.flexibleString(forKey: .funding)
        country = container.flexibleString(forKey: .country)
        name = container.flexibleString(forKey: .name)
        mode = container.flexibleString(forKey: .mode)
        isDefault = container.flexibleBool(forKey: .isDefault) ?? false
        label = container.flexibleString(forKey: .label)
        expiresLabel = container.flexibleString(forKey: .expiresLabel)
    }

    /// Identificador que se manda al cobrar con tarjeta guardada:
    /// Stripe → `paymentMethodId`; Conekta → `paymentSourceId`; Rebill → cardId.
    func chargeToken(for gateway: PaymentGateway) -> String? {
        switch gateway {
        case .stripe: return firstNonEmpty(stripePaymentMethodId, id)
        case .conekta: return firstNonEmpty(conektaPaymentSourceId, id)
        case .rebill: return firstNonEmpty(rebillCardId, id)
        case .mercadopago, .clip: return nil
        }
    }

    private func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            if let value, !value.isEmpty { return value }
        }
        return nil
    }
}

/// Body de `POST /api/<gw>/saved-card-payments` (doc 08 §5.4).
/// Stripe usa `paymentMethodId`; Conekta/Rebill usan `paymentSourceId`.
struct SavedCardPaymentRequest: Encodable, Sendable {
    var contactId: String
    var paymentMethodId: String?
    var paymentSourceId: String?
    var contactName: String?
    var email: String?
    var phone: String?
    var amount: Double
    var currency: String?
    var applyTax: Bool?
    var taxCalculationMode: String?
    var title: String?
    var description: String?
    var dueDate: String?
    var source: String?
    var lineItems: [PaymentLineItem]?
    /// Solo Conekta.
    var installments: PaymentInstallmentsOption?

    init(
        contactId: String,
        paymentMethodId: String? = nil,
        paymentSourceId: String? = nil,
        contactName: String? = nil,
        email: String? = nil,
        phone: String? = nil,
        amount: Double,
        currency: String? = nil,
        applyTax: Bool? = nil,
        taxCalculationMode: String? = nil,
        title: String? = nil,
        description: String? = nil,
        dueDate: String? = nil,
        source: String? = nil,
        lineItems: [PaymentLineItem]? = nil,
        installments: PaymentInstallmentsOption? = nil
    ) {
        self.contactId = contactId
        self.paymentMethodId = paymentMethodId
        self.paymentSourceId = paymentSourceId
        self.contactName = contactName
        self.email = email
        self.phone = phone
        self.amount = amount
        self.currency = currency
        self.applyTax = applyTax
        self.taxCalculationMode = taxCalculationMode
        self.title = title
        self.description = description
        self.dueDate = dueDate
        self.source = source
        self.lineItems = lineItems
        self.installments = installments
    }
}

/// `POST /api/<gw>/saved-card-payments` → `data: { payment }`.
/// `payment.status` puede ser `paid` inmediato o pendiente.
struct SavedCardPaymentResult: Decodable, Sendable {
    let payment: PublicPaymentSummary?

    enum CodingKeys: String, CodingKey {
        case payment
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        payment = try? container.decodeIfPresent(PublicPaymentSummary.self, forKey: .payment)
    }
}

// MARK: - Planes de pago por pasarela (doc 08 §5.5)

/// Body de `POST /api/<gw>/payment-plans` (stripe/conekta/rebill).
struct GatewayPaymentPlanRequest: Encodable, Sendable {
    var idempotencyKey: String
    var contact: PaymentPlanContact
    var totalAmount: Double
    var currency: String?
    var description: String?
    var title: String?
    var invoicePayload: RistakJSONValue?
    var firstPayment: PaymentPlanFirstPayment
    var remainingFrequency: String
    var remainingPayments: [PaymentPlanRemainingPayment]
    /// `pm_…` / `src_…` / `card_…`; `""` si tarjeta nueva por link.
    var paymentMethodId: String
    /// Monto de domiciliación (default backend $25).
    var cardSetupAmount: Double?
    var source: String?

    init(
        idempotencyKey: String = "ristak-ios-plan-\(UUID().uuidString.lowercased())",
        contact: PaymentPlanContact,
        totalAmount: Double,
        currency: String? = nil,
        description: String? = nil,
        title: String? = nil,
        invoicePayload: RistakJSONValue? = nil,
        firstPayment: PaymentPlanFirstPayment,
        remainingFrequency: String = "monthly",
        remainingPayments: [PaymentPlanRemainingPayment],
        paymentMethodId: String = "",
        cardSetupAmount: Double? = nil,
        source: String? = nil
    ) {
        self.idempotencyKey = idempotencyKey
        self.contact = contact
        self.totalAmount = totalAmount
        self.currency = currency
        self.description = description
        self.title = title
        self.invoicePayload = invoicePayload
        self.firstPayment = firstPayment
        self.remainingFrequency = remainingFrequency
        self.remainingPayments = remainingPayments
        self.paymentMethodId = paymentMethodId
        self.cardSetupAmount = cardSetupAmount
        self.source = source
    }
}

/// Pago programado devuelto por un plan.
struct ScheduledPlanPayment: Decodable, Sendable, Equatable {
    let installmentId: String?
    let paymentId: String?
    let sequence: Int?
    let amount: Double?
    let currency: String?
    let dueDate: String?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case installmentId, paymentId, sequence, amount, currency, dueDate, status
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        installmentId = container.flexibleString(forKey: .installmentId)
        paymentId = container.flexibleString(forKey: .paymentId)
        sequence = container.flexibleInt(forKey: .sequence)
        amount = container.flexibleDouble(forKey: .amount)
        currency = container.flexibleString(forKey: .currency)
        dueDate = container.flexibleString(forKey: .dueDate)
        status = container.flexibleString(forKey: .status)
    }
}

/// `POST /api/<gw>/payment-plans` → `data` (doc 08 §5.5).
struct GatewayPaymentPlanResult: Decodable, Sendable {
    let flowId: String?
    let currentState: String?
    let paymentMode: String?
    let firstPaymentLink: String?
    let firstPaymentPaymentId: String?
    let cardSetupLink: String?
    let cardSetupPaymentId: String?
    let cardSetupAmount: Double?
    /// Stripe.
    let savedPaymentMethod: SavedGatewayCard?
    /// Conekta/Rebill.
    let savedPaymentSource: SavedGatewayCard?
    let scheduledPayments: [ScheduledPlanPayment]

    enum CodingKeys: String, CodingKey {
        case flowId, currentState, paymentMode
        case firstPaymentLink, firstPaymentPaymentId
        case cardSetupLink, cardSetupPaymentId, cardSetupAmount
        case savedPaymentMethod, savedPaymentSource, scheduledPayments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        flowId = container.flexibleString(forKey: .flowId)
        currentState = container.flexibleString(forKey: .currentState)
        paymentMode = container.flexibleString(forKey: .paymentMode)
        firstPaymentLink = container.flexibleString(forKey: .firstPaymentLink)
        firstPaymentPaymentId = container.flexibleString(forKey: .firstPaymentPaymentId)
        cardSetupLink = container.flexibleString(forKey: .cardSetupLink)
        cardSetupPaymentId = container.flexibleString(forKey: .cardSetupPaymentId)
        cardSetupAmount = container.flexibleDouble(forKey: .cardSetupAmount)
        savedPaymentMethod = try? container.decodeIfPresent(SavedGatewayCard.self, forKey: .savedPaymentMethod)
        savedPaymentSource = try? container.decodeIfPresent(SavedGatewayCard.self, forKey: .savedPaymentSource)
        scheduledPayments = (try? container.decodeIfPresent([ScheduledPlanPayment].self, forKey: .scheduledPayments)) ?? []
    }

    var flowState: PaymentFlowState? { PaymentFlowState.parse(currentState) }
}

// MARK: - Canales de envío de links (doc 08 §5.9)

struct PaymentDeliveryChannel: Decodable, Sendable, Equatable {
    let key: String?
    let label: String?
    let available: Bool
    let connected: Bool
    let value: String?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case key, label, available, connected, value, reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = container.flexibleString(forKey: .key)
        label = container.flexibleString(forKey: .label)
        available = container.flexibleBool(forKey: .available) ?? false
        connected = container.flexibleBool(forKey: .connected) ?? false
        value = container.flexibleString(forKey: .value)
        reason = container.flexibleString(forKey: .reason)
    }
}

/// `GET /api/contacts/:id/payment-link-delivery-options` → `data`.
struct PaymentLinkDeliveryOptions: Decodable, Sendable {
    let contact: PaymentLinkContact?
    /// Claves: `whatsapp | messenger | instagram | email`.
    let channels: [String: PaymentDeliveryChannel]

    enum CodingKeys: String, CodingKey {
        case contact, channels
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contact = try? container.decodeIfPresent(PaymentLinkContact.self, forKey: .contact)
        channels = (try? container.decodeIfPresent([String: PaymentDeliveryChannel].self, forKey: .channels)) ?? [:]
    }
}

// MARK: - Matriz de capacidades (doc 08 §5.1 + doc 13 §7.2)

/// Capacidades de Pagos resueltas desde `GET /api/integrations/status` +
/// `GET /api/license/status` (regla `resolveMobilePaymentAccess` de RN).
struct PaymentCapabilities: Sendable, Equatable {
    let connectedGateways: [PaymentGateway]
    /// Pasarelas de planes conectadas (`stripe|conekta|rebill`).
    let planProviders: [PaymentGateway]
    /// Pasarelas de suscripción conectadas (`stripe|conekta|mercadopago|rebill`).
    let subscriptionProviders: [PaymentGateway]
    /// Hay pasarela de planes Y la feature `payment_plans` no está apagada.
    let canUsePaymentPlans: Bool
    /// Hay pasarela de suscripción Y la feature `subscriptions` no está apagada.
    let canUseSubscriptions: Bool
    /// Sin pasarelas conectadas ⇒ solo pago único offline.
    let offlineOnly: Bool

    /// Default seguro cuando fallan las cargas: solo pago único offline.
    static let offlineFallback = PaymentCapabilities(
        connectedGateways: [],
        planProviders: [],
        subscriptionProviders: [],
        canUsePaymentPlans: false,
        canUseSubscriptions: false,
        offlineOnly: true
    )

    static func resolve(integrations: IntegrationsStatus?, license: RistakLicenseStatus?) -> PaymentCapabilities {
        let connected = integrations?.connectedGateways ?? []
        let planProviders = connected.filter { $0.supportsPaymentPlans }
        let subscriptionProviders = connected.filter { $0.supportsSubscriptions }

        // Feature ausente cuenta como `true` (paridad RN).
        let features = license?.features ?? [:]
        let plansAllowed = features["payment_plans"] ?? true
        let subscriptionsAllowed = features["subscriptions"] ?? true

        return PaymentCapabilities(
            connectedGateways: connected,
            planProviders: planProviders,
            subscriptionProviders: subscriptionProviders,
            canUsePaymentPlans: !planProviders.isEmpty && plansAllowed,
            canUseSubscriptions: !subscriptionProviders.isEmpty && subscriptionsAllowed,
            offlineOnly: connected.isEmpty
        )
    }
}
