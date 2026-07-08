import SwiftUI
import Observation

// MARK: - Tarjeta guardada seleccionable

/// Tarjeta guardada de un contacto etiquetada con su pasarela (Stripe/Conekta/
/// Rebill). El backend no dice a qué pasarela pertenece cada tarjeta, así que la
/// llevamos aquí para saber a qué endpoint cobrar. Paridad RN
/// `NativePlanSavedCardOption`.
struct SavedCardOption: Identifiable, Equatable, Sendable {
    let gateway: PaymentGateway
    let card: SavedGatewayCard

    /// Clave estable pasarela+tarjeta (un contacto puede tener tarjetas de
    /// varias pasarelas con ids que colisionan).
    var id: String { "\(gateway.rawValue):\(card.id)" }

    /// Token que se manda al cobrar (pm_… / src_… / card_…).
    var chargeToken: String? { card.chargeToken(for: gateway) }

    /// Ej. «VISA •••• 4242» o el `label` que ya viene del backend.
    var displayLabel: String {
        if let label = card.label, !label.isEmpty { return label }
        let brand = (card.brand?.isEmpty == false) ? card.brand!.uppercased() : "Tarjeta"
        if let last4 = card.last4, !last4.isEmpty { return "\(brand) •••• \(last4)" }
        return brand
    }

    /// Ej. «Stripe · vence 12/27».
    var detailLabel: String {
        var parts: [String] = [gateway.displayName]
        if let expires = card.expiresLabel, !expires.isEmpty {
            parts.append(expires)
        } else if let month = card.expMonth, let year = card.expYear {
            parts.append("vence \(String(format: "%02d", month))/\(String(year % 100))")
        }
        if card.isDefault { parts.append("Predeterminada") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Modelo del wizard de pago único (doc 08 §6.3)

@MainActor
@Observable
final class SinglePaymentModel {
    enum ChargeType: String, CaseIterable {
        case custom
        case products

        var label: String {
            switch self {
            case .custom: return "Personalizado"
            case .products: return "Productos"
            }
        }
    }

    enum Method: Equatable {
        case link
        case savedCard
        case manual
    }

    /// Resultado de un cobro con tarjeta guardada.
    enum SavedCardOutcome: Equatable {
        /// La pasarela confirmó el cobro (paid|partial).
        case charged
        /// La pasarela lo dejó en proceso / pendiente de autorización.
        case processing
    }

    /// Métodos del pago manual (doc 08 §6.3.2 etapa `manual`).
    enum ManualMethod: String, CaseIterable, Identifiable {
        case cash
        case bankTransfer = "bank_transfer"
        case card
        case check
        case other

        var id: String { rawValue }

        var label: String {
            switch self {
            case .cash: return "Efectivo"
            case .bankTransfer: return "Transferencia bancaria"
            case .card: return "Tarjeta"
            case .check: return "Cheque"
            case .other: return "Otro"
            }
        }
    }

    // Contacto (contact-first, ya elegido).
    var contact: PickedPaymentContact

    // Paso `form`.
    var chargeType: ChargeType = .custom
    var amountText = ""
    var title = ""
    var descriptionText = ""

    // Productos.
    private(set) var products: [ProductItem] = []
    private(set) var isLoadingProducts = false
    var selectedProductID: String? {
        didSet {
            guard oldValue != selectedProductID else { return }
            selectedPriceID = nil
            Task { await loadPrices() }
        }
    }
    private(set) var prices: [ProductPrice] = []
    var selectedPriceID: String? {
        didSet {
            guard oldValue != selectedPriceID else { return }
            if let price = selectedPrice, let amount = price.resolvedAmount {
                amountText = Self.plainAmountText(amount)
            }
        }
    }

    // Impuestos.
    private(set) var taxSettings: PaymentTaxSettings?
    var applyTax = false
    /// `"exclusive"` (se suma al total) | `"inclusive"` (ya incluido).
    var taxMode = "exclusive"

    // Paso `options`.
    var method: Method?
    var selectedGateway: PaymentGateway?
    var msiEnabled = false
    var maxInstallments = 12

    // Pago manual.
    var manualDate = Date()
    var manualMethod: ManualMethod = .bankTransfer
    var manualReference = ""
    var manualNotes = ""

    // Tarjetas guardadas del contacto (Stripe/Conekta/Rebill).
    private(set) var savedCards: [SavedCardOption] = []
    private(set) var isLoadingSavedCards = false
    private(set) var didLoadSavedCards = false
    var selectedSavedCardID: String?

    // Envío.
    private(set) var isSubmitting = false
    /// Clave estable de idempotencia para el POST manual (PAY-007): reintentos
    /// del mismo intento no duplican el pago.
    private let idempotencyKey = UUID().uuidString
    var validationMessage: String?
    var linkResult: PaymentLinkReadyPayload?
    var manualSuccess = false
    /// Resultado del cobro con tarjeta guardada (nil = aún no hay resultado).
    var savedCardOutcome: SavedCardOutcome?

    init(contact: PickedPaymentContact) {
        self.contact = contact
    }

    // MARK: Derivados

    var selectedProduct: ProductItem? {
        guard let selectedProductID else { return nil }
        return products.first { $0.effectiveID == selectedProductID }
    }

    var selectedPrice: ProductPrice? {
        guard let selectedPriceID else { return nil }
        return prices.first { $0.effectiveID == selectedPriceID }
    }

    var enteredAmount: Double? {
        PaymentsAmountParser.amount(from: amountText)
    }

    /// Tarjeta guardada elegida para cobrar.
    var selectedSavedCard: SavedCardOption? {
        guard let selectedSavedCardID else { return nil }
        return savedCards.first { $0.id == selectedSavedCardID }
    }

    /// Descripción del pago manual: concepto + notas internas unidos por salto de
    /// línea (paridad web `RecordPaymentModal`:
    /// `description = [summary, notes].filter(Boolean).join('\n')`).
    var manualDescription: String? {
        let parts = [descriptionText, manualNotes]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }

    /// Desglose vigente de impuestos (base = monto capturado).
    var breakdown: PaymentTaxBreakdown {
        let amount = enteredAmount ?? 0
        guard applyTax, let taxSettings, taxSettings.enabled else {
            return .none(amount: amount)
        }
        return .compute(amount: amount, settings: taxSettings, mode: taxMode)
    }

    var lineItems: [PaymentLineItem]? {
        guard chargeType == .products, let product = selectedProduct else { return nil }
        let price = selectedPrice
        return [
            PaymentLineItem(
                name: product.name.isEmpty ? "Producto" : product.name,
                description: product.description,
                amount: enteredAmount ?? 0,
                qty: 1,
                currency: nil,
                priceId: price?.effectiveID,
                productId: product.effectiveID
            )
        ]
    }

    // MARK: Cargas

    func loadSupportData() async {
        async let productsTask: Void = loadProducts()
        async let taxesTask: Void = loadTaxSettings()
        _ = await (productsTask, taxesTask)
    }

    func loadProducts() async {
        guard products.isEmpty, !isLoadingProducts else { return }
        isLoadingProducts = true
        defer { isLoadingProducts = false }
        if let result = try? await ProductsService.products(limit: 100) {
            products = result.products.filter { !$0.effectiveID.isEmpty }
        }
    }

    /// Carga las tarjetas guardadas del contacto en cada pasarela conectada que
    /// las soporta (Stripe → `payment-methods`; Conekta/Rebill →
    /// `payment-sources`). Tolerante a fallos por pasarela (paridad RN: cada
    /// `catch(() => [])`). Una sola vez por flujo salvo `force`.
    func loadSavedCards(connectedGateways: [PaymentGateway], force: Bool = false) async {
        guard !contact.id.isEmpty else { return }
        let capable = connectedGateways.filter { $0.supportsSavedCards }
        // Sin pasarelas de tarjetas guardadas conectadas todavía: no marcamos
        // como cargado para que un `.task(id:)` reintente cuando lleguen.
        guard !capable.isEmpty else { return }
        if !force, didLoadSavedCards { return }
        guard !isLoadingSavedCards else { return }
        isLoadingSavedCards = true
        defer {
            isLoadingSavedCards = false
            didLoadSavedCards = true
        }

        let contactID = contact.id
        var collected: [SavedCardOption] = []
        await withTaskGroup(of: [SavedCardOption].self) { group in
            for gateway in capable {
                group.addTask {
                    let cards = (try? await PaymentLinksService.savedCards(gateway: gateway, contactID: contactID)) ?? []
                    return cards.map { SavedCardOption(gateway: gateway, card: $0) }
                }
            }
            for await chunk in group {
                collected.append(contentsOf: chunk)
            }
        }

        // Orden estable: predeterminadas primero, luego por pasarela y etiqueta.
        collected.sort { lhs, rhs in
            if lhs.card.isDefault != rhs.card.isDefault { return lhs.card.isDefault }
            if lhs.gateway.rawValue != rhs.gateway.rawValue { return lhs.gateway.rawValue < rhs.gateway.rawValue }
            return lhs.displayLabel < rhs.displayLabel
        }
        savedCards = collected

        if selectedSavedCardID == nil || !collected.contains(where: { $0.id == selectedSavedCardID }) {
            selectedSavedCardID = collected.first(where: { $0.card.isDefault })?.id ?? collected.first?.id
        }
    }

    private func loadPrices() async {
        prices = []
        guard let product = selectedProduct else { return }
        if !product.prices.isEmpty {
            prices = product.prices
        } else if let fetched = try? await ProductsService.prices(productID: product.effectiveID) {
            prices = fetched
        }
        if prices.count == 1 {
            selectedPriceID = prices.first?.effectiveID
        }
    }

    private func loadTaxSettings() async {
        guard taxSettings == nil else { return }
        let snapshot: PaymentSettingsSnapshot? = try? await APIClient.shared.get("/api/settings/payments")
        taxSettings = snapshot?.taxes
        if let taxes = snapshot?.taxes, taxes.enabled {
            taxMode = taxes.calculationMode == "inclusive" ? "inclusive" : "exclusive"
        }
    }

    // MARK: Validación (copys doc 08 §6.3.1)

    func validateForm() -> Bool {
        if contact.id.isEmpty {
            validationMessage = "Selecciona un contacto"
            return false
        }
        if chargeType == .products {
            if selectedProduct == nil {
                validationMessage = "Selecciona un producto"
                return false
            }
            if !prices.isEmpty, selectedPrice == nil {
                validationMessage = "Selecciona un precio"
                return false
            }
        }
        guard let amount = enteredAmount, amount > 0 else {
            validationMessage = "Ingresa un monto válido"
            return false
        }
        return true
    }

    // MARK: MSI (constantes de Core, doc 08 gaps 13-14)

    func msiTerms(for gateway: PaymentGateway) -> [Int] {
        switch gateway {
        case .stripe: return GatewayInstallmentRules.stripeTerms
        case .conekta: return GatewayInstallmentRules.conektaTerms
        case .mercadopago: return GatewayInstallmentRules.mercadoPagoTerms
        case .rebill: return GatewayInstallmentRules.rebillTerms
        case .clip: return []
        }
    }

    func msiTermAvailable(_ term: Int, gateway: PaymentGateway) -> Bool {
        guard gateway == .conekta else { return true }
        return GatewayInstallmentRules.conektaTermAvailable(term, amount: breakdown.total)
    }

    /// Razón por la que el MSI no está disponible para la pasarela (o `nil`).
    func msiUnavailableReason(gateway: PaymentGateway, accountCurrency: String?) -> String? {
        let total = breakdown.total
        switch gateway {
        case .stripe:
            if accountCurrency != "MXN" || total < GatewayInstallmentRules.stripeMinimumAmountMXN {
                return "Stripe requiere MXN y mínimo 300 MXN para meses sin intereses"
            }
        case .clip:
            if accountCurrency != "MXN" || total < GatewayInstallmentRules.clipMinimumAmountMXN {
                return "CLIP requiere MXN y mínimo 300 MXN para meses sin intereses"
            }
        case .conekta:
            let anyAvailable = GatewayInstallmentRules.conektaTerms.contains {
                GatewayInstallmentRules.conektaTermAvailable($0, amount: total)
            }
            if !anyAvailable {
                return "Sube el monto del cobro para habilitar meses sin intereses."
            }
        case .mercadopago, .rebill:
            break
        }
        return nil
    }

    /// Deshabilitadores del botón confirmar (doc 08 §6.3.2).
    func confirmDisabledReason(accountCurrency: String?) -> String? {
        guard let method else { return "Elige cómo quieres cobrar" }
        switch method {
        case .manual:
            return nil
        case .savedCard:
            if isLoadingSavedCards { return "Buscando tarjetas guardadas…" }
            if savedCards.isEmpty { return "Este contacto no tiene tarjetas guardadas" }
            if selectedSavedCard == nil { return "Selecciona una tarjeta guardada" }
            return nil
        case .link:
            guard let gateway = selectedGateway else { return "Selecciona una pasarela" }
            if gateway == .clip, contact.email.isEmpty || contact.phone.isEmpty {
                return "CLIP requiere email y teléfono"
            }
            if msiEnabled {
                if let reason = msiUnavailableReason(gateway: gateway, accountCurrency: accountCurrency) {
                    return reason
                }
                if gateway == .conekta, !msiTermAvailable(maxInstallments, gateway: .conekta) {
                    return "Selecciona un plazo disponible para Conekta"
                }
            }
            return nil
        }
    }

    var confirmLabel: String {
        switch method {
        case .manual:
            return "Registrar pago"
        case .savedCard:
            return "Cobrar tarjeta"
        case .link:
            guard let gateway = selectedGateway else { return "Continuar" }
            return "Crear link \(gateway.displayName)"
        case nil:
            return "Continuar"
        }
    }

    // MARK: Envío

    /// Ejecuta la acción confirmada. Devuelve `true` si terminó con éxito.
    func submit(appConfig: AppConfigStore) async -> Bool {
        guard !isSubmitting else { return false }
        guard validateForm() else { return false }
        guard let method else { return false }

        // Guard duro de moneda (doc 01 §10): sin `account_currency` NO se
        // crean registros de dinero.
        guard let accountCurrency = appConfig.accountCurrency else {
            validationMessage = "No se pudo leer la moneda de la cuenta. Reintenta cuando haya conexión."
            return false
        }

        isSubmitting = true
        defer { isSubmitting = false }

        let timeZone = appConfig.businessTimeZone
        let formatters = appConfig.formatters
        let breakdown = breakdown

        do {
            switch method {
            case .manual:
                var metadata: [String: RistakJSONValue] = [
                    "source": .string("ios_native_payments"),
                ]
                if let lineItems {
                    metadata["lineItems"] = .array(lineItems.map { item in
                        var object: [String: RistakJSONValue] = [
                            "name": .string(item.name),
                            "amount": .number(item.amount),
                            "qty": .number(Double(item.qty)),
                        ]
                        if let description = item.description { object["description"] = .string(description) }
                        if let priceId = item.priceId { object["priceId"] = .string(priceId) }
                        if let productId = item.productId { object["productId"] = .string(productId) }
                        return .object(object)
                    })
                }
                if let tax = breakdown.metadataValue {
                    metadata["tax"] = tax
                }

                let request = ManualPaymentRequest(
                    amount: breakdown.total,
                    currency: accountCurrency,
                    method: manualMethod.rawValue,
                    status: "paid",
                    reference: manualReference.isEmpty ? nil : manualReference,
                    title: title.isEmpty ? "Pago" : title,
                    description: manualDescription,
                    date: PaymentsDateMath.dateString(manualDate, timeZone: timeZone),
                    contactId: contact.id,
                    contactName: contact.name.isEmpty ? nil : contact.name,
                    email: contact.email.isEmpty ? nil : contact.email,
                    phone: contact.phone.isEmpty ? nil : contact.phone,
                    metadata: .object(metadata)
                )
                _ = try await PaymentsService.createManualPayment(request, idempotencyKey: idempotencyKey)
                manualSuccess = true
                return true

            case .savedCard:
                guard let option = selectedSavedCard, let token = option.chargeToken, !token.isEmpty else {
                    validationMessage = "Selecciona una tarjeta guardada válida."
                    return false
                }
                let gateway = option.gateway
                var request = SavedCardPaymentRequest(
                    contactId: contact.id,
                    contactName: contact.name.isEmpty ? nil : contact.name,
                    email: contact.email.isEmpty ? nil : contact.email,
                    phone: contact.phone.isEmpty ? nil : contact.phone,
                    // `amount` = base gravable; el backend recalcula el impuesto.
                    amount: enteredAmount ?? 0,
                    currency: accountCurrency,
                    applyTax: breakdown.applied,
                    taxCalculationMode: breakdown.applied ? breakdown.mode : nil,
                    title: title.isEmpty ? "Pago" : title,
                    description: descriptionText.isEmpty ? nil : descriptionText,
                    dueDate: PaymentsDateMath.dateString(Date(), timeZone: timeZone),
                    source: "ios_native_payments_saved_card",
                    lineItems: lineItems
                )
                // Stripe usa `paymentMethodId`; Conekta/Rebill usan `paymentSourceId`
                // (el backend de Rebill también acepta `paymentSourceId`).
                if gateway == .stripe {
                    request.paymentMethodId = token
                } else {
                    request.paymentSourceId = token
                }
                let result = try await PaymentLinksService.chargeSavedCard(gateway: gateway, request)
                // Solo se marca como cobrado cuando la pasarela lo confirma; un
                // estado de proceso/autorización se comunica como pendiente (no
                // reportar un falso "cobro realizado"). Paridad RN.
                let status = result.payment?.status ?? ""
                if !status.isEmpty, PaymentTransactionStatus.parse(status)?.countsAsReceived != true {
                    savedCardOutcome = .processing
                } else {
                    savedCardOutcome = .charged
                }
                return true

            case .link:
                guard let gateway = selectedGateway else { return false }
                let request = GatewayPaymentLinkRequest(
                    contactId: contact.id,
                    contactName: contact.name.isEmpty ? nil : contact.name,
                    email: contact.email.isEmpty ? nil : contact.email,
                    phone: contact.phone.isEmpty ? nil : contact.phone,
                    amount: enteredAmount ?? 0,
                    currency: accountCurrency,
                    applyTax: breakdown.applied,
                    taxCalculationMode: breakdown.applied ? breakdown.mode : nil,
                    title: title.isEmpty ? "Pago" : title,
                    description: descriptionText.isEmpty ? nil : descriptionText,
                    source: "ios_native_payments",
                    lineItems: lineItems,
                    installments: PaymentInstallmentsOption(
                        enabled: msiEnabled,
                        maxInstallments: msiEnabled ? maxInstallments : 12
                    )
                )
                let result = try await PaymentLinksService.createPaymentLink(gateway: gateway, request)
                guard let url = result.paymentUrl ?? result.payment?.paymentUrl, !url.isEmpty else {
                    validationMessage = "La pasarela no devolvió un enlace de pago."
                    return false
                }
                linkResult = PaymentLinkReadyPayload(
                    kind: .payment,
                    url: url,
                    gatewayName: gateway.displayName,
                    contactName: contact.displayName,
                    amountLabel: formatters.currency(breakdown.total),
                    contactID: contact.id.isEmpty ? nil : contact.id,
                    contactPhone: contact.phone.isEmpty ? nil : contact.phone
                )
                return true
            }
        } catch let error as RistakAPIError {
            validationMessage = error.message
            return false
        } catch {
            validationMessage = "No se pudo completar el cobro. Intenta de nuevo."
            return false
        }
    }

    // MARK: Helpers

    static func plainAmountText(_ value: Double) -> String {
        if value.rounded() == value {
            return String(format: "%.0f", value)
        }
        return String(format: "%.2f", value)
    }
}

// MARK: - Paso 1: formulario

struct SinglePaymentFlowView: View {
    @State private var model: SinglePaymentModel
    @State private var showOptions = false
    var onDone: () -> Void

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(PaymentsHomeModel.self) private var home

    init(contact: PickedPaymentContact, onDone: @escaping () -> Void) {
        _model = State(initialValue: SinglePaymentModel(contact: contact))
        self.onDone = onDone
    }

    var body: some View {
        Group {
            if appConfig.canCreateMoneyRecords {
                form
            } else {
                PaymentsCurrencyGuardView {
                    Task { await appConfig.refresh() }
                }
            }
        }
        .navigationTitle("Pago único")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.loadSupportData()
        }
        .alert(
            "Revisa el cobro",
            isPresented: Binding(
                get: { model.validationMessage != nil },
                set: { if !$0 { model.validationMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { model.validationMessage = nil }
        } message: {
            Text(model.validationMessage ?? "")
        }
        .navigationDestination(isPresented: $showOptions) {
            SinglePaymentOptionsView(model: model, onDone: onDone)
        }
    }

    private var form: some View {
        let formatters = appConfig.formatters

        return Form {
            Section("Cliente") {
                PaymentContactSummaryRow(contact: model.contact)
            }

            Section("Tipo de cobro") {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ForEach(SinglePaymentModel.ChargeType.allCases, id: \.rawValue) { type in
                        RistakFilterChip(
                            title: type.label,
                            isSelected: model.chargeType == type
                        ) {
                            model.chargeType = type
                        }
                    }
                }
                .listRowSeparator(.hidden)

                if model.chargeType == .products {
                    productPickers
                }

                LabeledContent("Monto (\(appConfig.displayCurrencyCode))") {
                    TextField("0.00", text: $model.amountText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                }

                if model.chargeType == .products {
                    Text("Puedes modificar el precio según tu negociación con el cliente")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textMute)
                        .listRowSeparator(.hidden)
                }
            }

            Section("Concepto") {
                TextField("Pago", text: $model.title)
                TextField("Ej: Pago de servicios, consulta, etc.", text: $model.descriptionText, axis: .vertical)
                    .lineLimit(2...4)
            }

            if let taxes = model.taxSettings, taxes.enabled {
                Section("Impuestos") {
                    HStack(spacing: RistakTheme.Spacing.xs) {
                        RistakFilterChip(
                            title: "Sin \(taxes.taxName)",
                            isSelected: !model.applyTax
                        ) {
                            model.applyTax = false
                        }
                        RistakFilterChip(
                            title: "Aplicar \(SinglePaymentModel.plainAmountText(taxes.rateValue))%",
                            isSelected: model.applyTax
                        ) {
                            model.applyTax = true
                        }
                    }
                    .listRowSeparator(.hidden)

                    if model.applyTax {
                        HStack(spacing: RistakTheme.Spacing.xs) {
                            RistakFilterChip(
                                title: "Se suma al total",
                                isSelected: model.taxMode == "exclusive"
                            ) {
                                model.taxMode = "exclusive"
                            }
                            RistakFilterChip(
                                title: "Ya incluido",
                                isSelected: model.taxMode == "inclusive"
                            ) {
                                model.taxMode = "inclusive"
                            }
                        }
                        .listRowSeparator(.hidden)
                    }
                }
            }

            Section {
                summaryRow(label: "Subtotal", value: formatters.currency(model.breakdown.subtotal))
                if model.breakdown.applied {
                    summaryRow(
                        label: "\(model.breakdown.name) (\(SinglePaymentModel.plainAmountText(model.breakdown.rate))%)",
                        value: formatters.currency(model.breakdown.taxAmount)
                    )
                }
                summaryRow(label: "Total a cobrar", value: formatters.currency(model.breakdown.total), emphasized: true)
            }

            Section {
                Button {
                    if model.validateForm() {
                        showOptions = true
                    }
                } label: {
                    Text("Continuar")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
        }
        .paymentsKeyboardDismissable()
    }

    @ViewBuilder
    private var productPickers: some View {
        Picker("Producto", selection: $model.selectedProductID) {
            Text("Selecciona un producto").tag(String?.none)
            ForEach(model.products, id: \.effectiveID) { product in
                Text(product.name.isEmpty ? "Producto sin nombre" : product.name)
                    .tag(String?.some(product.effectiveID))
            }
        }

        if model.selectedProduct != nil {
            if model.prices.isEmpty {
                Text("No hay precios disponibles para este producto")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            } else {
                Picker("Precio", selection: $model.selectedPriceID) {
                    Text("Selecciona un precio").tag(String?.none)
                    ForEach(model.prices, id: \.effectiveID) { price in
                        Text(priceLabel(price)).tag(String?.some(price.effectiveID))
                    }
                }
            }
        }
    }

    private func priceLabel(_ price: ProductPrice) -> String {
        let name = (price.name?.isEmpty == false) ? price.name! : "Precio"
        guard let amount = price.resolvedAmount else { return name }
        return "\(name) - \(appConfig.formatters.currency(amount, currencyOverride: price.currency))"
    }

    private func summaryRow(label: String, value: String, emphasized: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(emphasized ? .body.weight(.semibold) : .subheadline)
                .foregroundStyle(emphasized ? RistakTheme.textPrimary : RistakTheme.textDim)
            Spacer()
            Text(value)
                .font(emphasized ? .body.weight(.bold) : .subheadline.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(RistakTheme.textPrimary)
        }
    }
}

// MARK: - Paso 2: método de cobro

struct SinglePaymentOptionsView: View {
    @Bindable var model: SinglePaymentModel
    var onDone: () -> Void

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(PaymentsHomeModel.self) private var home

    @State private var successHaptic = false

    var body: some View {
        Form {
            summarySection
            methodSection

            if model.method == .link {
                gatewaySection

                if let gateway = model.selectedGateway {
                    msiSection(gateway: gateway)
                }
            }

            if model.method == .savedCard {
                savedCardSection
            }

            if model.method == .manual {
                manualSection
            }

            confirmSection
        }
        .paymentsKeyboardDismissable()
        .navigationTitle("Cobrar")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: (home.capabilities?.connectedGateways ?? []).map(\.rawValue)) {
            await model.loadSavedCards(connectedGateways: home.capabilities?.connectedGateways ?? [])
        }
        .sensoryFeedback(.success, trigger: successHaptic)
        .alert(
            "Revisa el cobro",
            isPresented: Binding(
                get: { model.validationMessage != nil },
                set: { if !$0 { model.validationMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { model.validationMessage = nil }
        } message: {
            Text(model.validationMessage ?? "")
        }
        .alert("Pago registrado", isPresented: $model.manualSuccess) {
            Button("Listo") {
                home.refreshRecentSilently()
                onDone()
            }
        } message: {
            Text("El pago quedó guardado y aparecerá en el historial del contacto.")
        }
        .alert(
            model.savedCardOutcome == .processing ? "Cobro en proceso" : "Cobro realizado",
            isPresented: Binding(
                get: { model.savedCardOutcome != nil },
                set: { if !$0 { model.savedCardOutcome = nil } }
            )
        ) {
            Button("Listo") {
                model.savedCardOutcome = nil
                home.refreshRecentSilently()
                onDone()
            }
        } message: {
            Text(model.savedCardOutcome == .processing
                 ? "El cobro con la tarjeta guardada quedó en proceso. Confirma el estado en unos minutos."
                 : "El cobro con la tarjeta guardada se completó y aparecerá en el historial del contacto.")
        }
        .sheet(item: $model.linkResult) { payload in
            PaymentLinkReadySheet(payload: payload)
                .presentationDetents([.medium, .large])
                .onDisappear {
                    home.refreshRecentSilently()
                    onDone()
                }
        }
    }

    private var summarySection: some View {
        Section("Resumen del cobro") {
            PaymentContactSummaryRow(contact: model.contact)

            HStack {
                Text("Total a cobrar")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                Spacer()
                Text(appConfig.formatters.currency(model.breakdown.total))
                    .font(.body.weight(.bold))
                    .monospacedDigit()
            }

            if model.breakdown.applied {
                Text("\(model.breakdown.name) \(SinglePaymentModel.plainAmountText(model.breakdown.rate))% · \(model.breakdown.mode == "inclusive" ? "ya incluido" : "se suma al total")")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            } else {
                Text("Este cobro no incluye impuestos")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            }
        }
    }

    /// Hay alguna pasarela conectada que maneje tarjetas guardadas.
    private var savedCardCapableConnected: Bool {
        (home.capabilities?.connectedGateways ?? []).contains { $0.supportsSavedCards }
    }

    private var savedCardOptionSubtitle: String {
        if model.isLoadingSavedCards { return "Buscando tarjetas guardadas del contacto…" }
        let count = model.savedCards.count
        if count == 0 { return "Este contacto todavía no tiene tarjetas guardadas." }
        return "Cobra una tarjeta guardada del contacto (\(count) disponible\(count == 1 ? "" : "s"))."
    }

    private var methodSection: some View {
        Section("¿Cómo quieres cobrar?") {
            VStack(spacing: RistakTheme.Spacing.xs) {
                if !(home.capabilities?.offlineOnly ?? true) {
                    PaymentOptionRow(
                        title: "Enviar enlace de pago",
                        subtitle: linkOptionSubtitle,
                        isSelected: model.method == .link
                    ) {
                        model.method = .link
                        if model.selectedGateway == nil {
                            model.selectedGateway = home.capabilities?.connectedGateways.first
                        }
                    }

                    if savedCardCapableConnected {
                        PaymentOptionRow(
                            title: "Cobrar tarjeta guardada",
                            subtitle: savedCardOptionSubtitle,
                            isSelected: model.method == .savedCard,
                            isDisabled: !model.isLoadingSavedCards && model.savedCards.isEmpty
                        ) {
                            model.method = .savedCard
                        }
                    }
                }

                PaymentOptionRow(
                    title: "Registrar pago manual",
                    subtitle: "Registra el pago en Ristak (efectivo, transferencia, etc.)",
                    isSelected: model.method == .manual
                ) {
                    model.method = .manual
                }
            }
            .listRowSeparator(.hidden)
        }
    }

    private var savedCardSection: some View {
        Section("Tarjeta a cobrar") {
            if model.isLoadingSavedCards {
                HStack(spacing: RistakTheme.Spacing.sm) {
                    ProgressView().controlSize(.small)
                    Text("Buscando tarjetas guardadas…")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                }
                .listRowSeparator(.hidden)
            } else if model.savedCards.isEmpty {
                Text("Este contacto no tiene tarjetas guardadas. Regresa y usa un enlace de pago o registra el pago manual.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .listRowSeparator(.hidden)
            } else {
                VStack(spacing: RistakTheme.Spacing.xs) {
                    ForEach(model.savedCards) { option in
                        PaymentOptionRow(
                            title: option.displayLabel,
                            subtitle: option.detailLabel,
                            isSelected: model.selectedSavedCardID == option.id
                        ) {
                            model.selectedSavedCardID = option.id
                        }
                    }
                }
                .listRowSeparator(.hidden)

                Text("Si el contacto tiene varias tarjetas de la misma pasarela, se muestran por separado.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
                    .listRowSeparator(.hidden)
            }
        }
    }

    private var linkOptionSubtitle: String {
        let names = (home.capabilities?.connectedGateways ?? []).map(\.displayName)
        guard !names.isEmpty else { return "" }
        if names.count == 1 {
            return "Genera el enlace público con \(names[0])."
        }
        return "Después eliges pasarela: \(names.joined(separator: ", "))."
    }

    private var gatewaySection: some View {
        Section("Pasarela") {
            VStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(home.capabilities?.connectedGateways ?? [], id: \.rawValue) { gateway in
                    PaymentOptionRow(
                        title: gateway.displayName,
                        subtitle: gatewayCopy(gateway),
                        isSelected: model.selectedGateway == gateway
                    ) {
                        model.selectedGateway = gateway
                        model.msiEnabled = false
                        model.maxInstallments = defaultTerm(for: gateway)
                    }
                }
            }
            .listRowSeparator(.hidden)
        }
    }

    private func gatewayCopy(_ gateway: PaymentGateway) -> String {
        switch gateway {
        case .stripe:
            return "Genera tu página pública con campo seguro de tarjeta y meses sin intereses si aplica."
        case .conekta:
            return "Genera tu página pública con tokenizador seguro y opción de meses sin intereses."
        case .mercadopago:
            return "Genera el enlace y después configura si tendrá meses sin intereses."
        case .clip:
            return "Genera una página pública con Checkout Transparente y MSI si aplica."
        case .rebill:
            return "Genera una página pública con checkout seguro y opción de meses sin intereses si aplica."
        }
    }

    private func defaultTerm(for gateway: PaymentGateway) -> Int {
        switch gateway {
        case .stripe: return 24
        case .rebill: return GatewayInstallmentRules.rebillDefaultMaxTerm
        default: return 12
        }
    }

    @ViewBuilder
    private func msiSection(gateway: PaymentGateway) -> some View {
        Section("Meses sin intereses") {
            HStack(spacing: RistakTheme.Spacing.xs) {
                RistakFilterChip(title: "Cobro único", isSelected: !model.msiEnabled) {
                    model.msiEnabled = false
                }
                RistakFilterChip(title: "Meses sin intereses", isSelected: model.msiEnabled) {
                    model.msiEnabled = true
                }
            }
            .listRowSeparator(.hidden)

            if !model.msiEnabled {
                Text("Crea el link de \(gateway.displayName) para pago de contado.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            } else if let reason = model.msiUnavailableReason(gateway: gateway, accountCurrency: appConfig.accountCurrency) {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(RistakTheme.warn)
            } else if gateway == .clip {
                Text("CLIP decide los planes disponibles desde su Dashboard.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)

                Text(model.contact.email.isEmpty || model.contact.phone.isEmpty
                     ? "Falta email o teléfono"
                     : "Email y teléfono listos")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(model.contact.email.isEmpty || model.contact.phone.isEmpty
                                     ? RistakTheme.warn
                                     : RistakTheme.pos)
            } else {
                Picker("Máximo de meses", selection: $model.maxInstallments) {
                    ForEach(model.msiTerms(for: gateway), id: \.self) { term in
                        if gateway == .conekta, !model.msiTermAvailable(term, gateway: .conekta) {
                            Text("\(term) meses - mínimo \(appConfig.formatters.currency(GatewayInstallmentRules.conektaMinimumByTerm[term] ?? 0))")
                                .tag(term)
                        } else {
                            Text("\(term) meses").tag(term)
                        }
                    }
                }

                Text(msiNote(gateway: gateway))
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            }
        }
    }

    private func msiNote(gateway: PaymentGateway) -> String {
        switch gateway {
        case .stripe:
            return "Ristak mostrará sólo los plazos que Stripe confirme para la tarjeta del cliente y nunca más de \(model.maxInstallments) meses."
        case .mercadopago:
            return "Mercado Pago solo mostrará meses disponibles. Ristak registra el total completo cuando el pago se confirma por webhook."
        case .conekta:
            return "Conekta valida la disponibilidad con el banco emisor."
        case .rebill:
            return "Rebill mostrará MSI solo cuando la cuenta, país, moneda, monto y tarjeta califiquen."
        case .clip:
            return "CLIP decide los planes disponibles desde su Dashboard."
        }
    }

    private var manualSection: some View {
        Section("Pago manual") {
            DatePicker(
                "Fecha de pago",
                selection: $model.manualDate,
                in: ...Date(),
                displayedComponents: .date
            )
            .environment(\.timeZone, appConfig.businessTimeZone)

            Picker("Método de pago", selection: $model.manualMethod) {
                ForEach(SinglePaymentModel.ManualMethod.allCases) { method in
                    Text(method.label).tag(method)
                }
            }

            TextField("Referencia (opcional)", text: $model.manualReference)
                .textInputAutocapitalization(.never)

            TextField("Notas internas", text: $model.manualNotes, axis: .vertical)
                .lineLimit(2...4)
        }
    }

    private var confirmSection: some View {
        Section {
            let disabledReason = model.confirmDisabledReason(accountCurrency: appConfig.accountCurrency)

            Button {
                Task {
                    let finished = await model.submit(appConfig: appConfig)
                    if finished { successHaptic.toggle() }
                }
            } label: {
                HStack {
                    if model.isSubmitting {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(model.isSubmitting ? "Procesando..." : model.confirmLabel)
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isSubmitting || disabledReason != nil)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())

            if let disabledReason {
                Text(disabledReason)
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
            }
        }
    }
}
