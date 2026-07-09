import Foundation

/// Caché instantánea (stale-while-revalidate) del módulo Pagos — Round 6 #4.
///
/// `RistakSnapshotCache` decodifica el `Data` guardado con el `init(from:)` del
/// tipo que le pidas. Como `PaymentTransaction`, `ProductItem` y
/// `PaymentCapabilities` son **Decodable-only** (o ni siquiera Codable) y NO
/// podemos añadir `Encodable` a los modelos de `Core`, este archivo define
/// DTOs Codable feature-local que:
///
/// 1. Se construyen desde el modelo vivo (`init(_:)`).
/// 2. Codifican al MISMO shape JSON (mismas claves) que el `init(from:)` del
///    modelo. Así guardamos `[…Snapshot]` y lo LEEMOS de vuelta como
///    `[Modelo]` directamente (`cache.value([Modelo].self, for:)`), sin puente
///    manual y con round-trip fiel a un fetch en vivo.
///
/// Capamos las listas antes de guardar: la caché no infla el tamaño por ti.
enum PaymentsCache {
    /// Clave de la lista de productos guardados (no parametrizada).
    static let productsKey = "payments:products"

    /// Máximo de filas persistidas por lista (paint instantáneo, disco acotado).
    static let recentCap = 100
    static let productsCap = 100

    /// Clave de «últimos pagos» para un periodo concreto.
    static func recentKey(for period: RecentPaymentsPeriod) -> String {
        RistakCacheKey.paymentsRecent(range: period.rawValue)
    }

    /// Clave de las capacidades de pago (pasarelas + planes + suscripciones).
    static var capabilitiesKey: String { RistakCacheKey.paymentsGateways }
}

// MARK: - Capacidades

/// Snapshot Codable de las capacidades de pago + estado de HighLevel.
///
/// Preserva el gating condicional (tarjetas guardadas, pasarelas, planes,
/// suscripciones) para que la última configuración conocida pinte AL INSTANTE
/// y no se oculte una función que el usuario tenía la sesión anterior mientras
/// revalida.
struct PaymentCapabilitiesSnapshot: Codable, Sendable {
    let connectedGateways: [PaymentGateway]
    let planProviders: [PaymentGateway]
    let subscriptionProviders: [PaymentGateway]
    let canUsePaymentPlans: Bool
    let canUseSubscriptions: Bool
    let offlineOnly: Bool
    let isHighLevelConnected: Bool

    init(capabilities: PaymentCapabilities, isHighLevelConnected: Bool) {
        connectedGateways = capabilities.connectedGateways
        planProviders = capabilities.planProviders
        subscriptionProviders = capabilities.subscriptionProviders
        canUsePaymentPlans = capabilities.canUsePaymentPlans
        canUseSubscriptions = capabilities.canUseSubscriptions
        offlineOnly = capabilities.offlineOnly
        self.isHighLevelConnected = isHighLevelConnected
    }

    /// Reconstruye el modelo vivo (init sintetizado, mismo módulo).
    var capabilities: PaymentCapabilities {
        PaymentCapabilities(
            connectedGateways: connectedGateways,
            planProviders: planProviders,
            subscriptionProviders: subscriptionProviders,
            canUsePaymentPlans: canUsePaymentPlans,
            canUseSubscriptions: canUseSubscriptions,
            offlineOnly: offlineOnly
        )
    }
}

// MARK: - Transacción (espejo Encodable de `PaymentTransaction`)

/// Espejo Encodable de `PaymentTransaction`. Las claves coinciden 1:1 con
/// `PaymentTransaction.CodingKeys` (nombres de propiedad, sin remapeos), así el
/// JSON que produce se decodifica de vuelta como `PaymentTransaction` con su
/// `init(from:)` tolerante. Los opcionales se omiten cuando son `nil`
/// (`encodeIfPresent` sintetizado), idéntico a lo que llega en un fetch real.
struct PaymentTransactionSnapshot: Encodable, Sendable {
    let id: String
    let date: String?
    let contactId: String?
    let contactName: String
    let email: String
    let phone: String
    let amount: Double
    let currency: String
    let method: String
    let status: String
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
    let contactSource: String?
    let attributionAdName: String?
    let attributionAdId: String?

    init(_ t: PaymentTransaction) {
        id = t.id
        date = t.date
        contactId = t.contactId
        contactName = t.contactName
        email = t.email
        phone = t.phone
        amount = t.amount
        currency = t.currency
        method = t.method
        status = t.status
        paymentMode = t.paymentMode
        paymentProvider = t.paymentProvider
        paymentMethodCategory = t.paymentMethodCategory
        paymentMethodCategoryId = t.paymentMethodCategoryId
        paymentType = t.paymentType
        paymentChannel = t.paymentChannel
        paymentChannelId = t.paymentChannelId
        reference = t.reference
        title = t.title
        description = t.description
        createdAt = t.createdAt
        updatedAt = t.updatedAt
        invoiceId = t.invoiceId
        invoiceNumber = t.invoiceNumber
        dueDate = t.dueDate
        sentAt = t.sentAt
        publicPaymentId = t.publicPaymentId
        paymentUrl = t.paymentUrl
        stripePaymentIntentId = t.stripePaymentIntentId
        stripeChargeId = t.stripeChargeId
        mercadoPagoPaymentId = t.mercadoPagoPaymentId
        mercadoPagoPreferenceId = t.mercadoPagoPreferenceId
        conektaOrderId = t.conektaOrderId
        conektaChargeId = t.conektaChargeId
        conektaPaymentSourceId = t.conektaPaymentSourceId
        clipPaymentId = t.clipPaymentId
        clipReceiptNo = t.clipReceiptNo
        rebillPaymentId = t.rebillPaymentId
        rebillSubscriptionId = t.rebillSubscriptionId
        rebillCustomerId = t.rebillCustomerId
        rebillCardId = t.rebillCardId
        paidAt = t.paidAt
        contactSource = t.contactSource
        attributionAdName = t.attributionAdName
        attributionAdId = t.attributionAdId
    }
}

// MARK: - Producto (espejo Encodable de `ProductItem` / `ProductPrice`)

/// Espejo Encodable de `ProductPrice`. `underscoreId` viaja como `_id` para
/// que `ProductPrice.init(from:)` lo lea igual que del backend.
struct ProductPriceSnapshot: Encodable, Sendable {
    let id: String?
    let underscoreId: String?
    let localId: String?
    let ghlPriceId: String?
    let localProductId: String?
    let name: String?
    let amount: Double?
    let price: Double?
    let currency: String?
    let type: String?
    let sku: String?
    let syncStatus: String?

    enum CodingKeys: String, CodingKey {
        case id, localId, ghlPriceId, localProductId, name, amount, price, currency, type, sku, syncStatus
        case underscoreId = "_id"
    }

    init(_ p: ProductPrice) {
        id = p.id
        underscoreId = p.underscoreId
        localId = p.localId
        ghlPriceId = p.ghlPriceId
        localProductId = p.localProductId
        name = p.name
        amount = p.amount
        price = p.price
        currency = p.currency
        type = p.type
        sku = p.sku
        syncStatus = p.syncStatus
    }
}

/// Espejo Encodable de `ProductItem`. Guardamos `[ProductItemSnapshot]` y lo
/// leemos de vuelta como `[ProductItem]`.
struct ProductItemSnapshot: Encodable, Sendable {
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
    let prices: [ProductPriceSnapshot]

    enum CodingKeys: String, CodingKey {
        case id, localId, ghlProductId, name, description, currency, productType
        case source, syncStatus, syncError
        case gigstackProductKey, gigstackUnitKey, gigstackUnitName, prices
        case underscoreId = "_id"
    }

    init(_ p: ProductItem) {
        id = p.id
        underscoreId = p.underscoreId
        localId = p.localId
        ghlProductId = p.ghlProductId
        name = p.name
        description = p.description
        currency = p.currency
        productType = p.productType
        source = p.source
        syncStatus = p.syncStatus
        syncError = p.syncError
        gigstackProductKey = p.gigstackProductKey
        gigstackUnitKey = p.gigstackUnitKey
        gigstackUnitName = p.gigstackUnitName
        prices = p.prices.map(ProductPriceSnapshot.init)
    }
}
