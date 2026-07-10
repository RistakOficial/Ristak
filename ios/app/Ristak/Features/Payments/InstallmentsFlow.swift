import SwiftUI
import Observation

// MARK: - Modelo del plan de parcialidades (doc 08 §2.9, §5.5, §6.3.3)

@MainActor
@Observable
final class InstallmentsPlanModel {
    /// Métodos del primer pago (fila #1 del plan, doc 08 §6.3.1).
    enum FirstPaymentMethod: String, CaseIterable, Identifiable {
        case card
        case bankTransfer = "bank_transfer"
        case cash
        case deposit

        var id: String { rawValue }

        var label: String {
            switch self {
            case .card: return "Tarjeta / link"
            case .bankTransfer: return "Transferencia"
            case .cash: return "Efectivo"
            case .deposit: return "Depósito"
            }
        }

        /// ¿Método offline? (doc 08 §1.6: en pasarela genera `cardSetupLink`.)
        var isOffline: Bool { self != .card }
    }

    /// Destino del plan: pasarela con espejo (stripe/conekta/rebill) o el
    /// flujo local/HighLevel de parcialidades (doc 08 §2.9).
    enum PlanDestination: Hashable {
        case gateway(PaymentGateway)
        case ristak

        var label: String {
            switch self {
            case .gateway(let gateway): return gateway.displayName
            case .ristak: return "Ristak · parcialidades"
            }
        }
    }

    struct RemainingRow: Identifiable {
        let id = UUID()
        var amountText: String
        var date: Date
    }

    var contact: PickedPaymentContact

    // Formulario.
    var totalText = ""
    var concept = ""
    var frequency: PaymentPlanFrequency = .monthly {
        didSet {
            guard oldValue != frequency else { return }
            recalcDates()
        }
    }
    var firstPaymentImmediate = true
    var firstPaymentMethod: FirstPaymentMethod = .card
    var firstPaymentDate = Date()
    var firstPaymentAmountText = ""
    var rows: [RemainingRow] = []
    var destination: PlanDestination?

    // Envío.
    private(set) var isSubmitting = false
    var validationMessage: String?
    var linkResult: PaymentLinkReadyPayload?
    var successMessage: String?

    private let timeZoneProvider: () -> TimeZone
    private let gatewayPaymentPlanIdempotencyKey = "ristak-ios-plan-\(UUID().uuidString.lowercased())"

    init(contact: PickedPaymentContact, timeZoneProvider: @escaping () -> TimeZone) {
        self.contact = contact
        self.timeZoneProvider = timeZoneProvider
        let timeZone = timeZoneProvider()
        let today = PaymentsDateMath.startOfToday(timeZone: timeZone)
        firstPaymentDate = today
        rows = [
            RemainingRow(amountText: "", date: PaymentsDateMath.advancing(today, frequency: .monthly, steps: 1, timeZone: timeZone)),
            RemainingRow(amountText: "", date: PaymentsDateMath.advancing(today, frequency: .monthly, steps: 2, timeZone: timeZone)),
        ]
    }

    // MARK: Derivados

    var totalAmount: Double? {
        PaymentsAmountParser.amount(from: totalText)
    }

    var firstPaymentAmount: Double {
        PaymentsAmountParser.amount(from: firstPaymentAmountText) ?? 0
    }

    func rowAmount(_ row: RemainingRow) -> Double {
        PaymentsAmountParser.amount(from: row.amountText) ?? 0
    }

    var assignedTotal: Double {
        firstPaymentAmount + rows.reduce(0) { $0 + rowAmount($1) }
    }

    /// Diferencia contra el total (positiva = falta, negativa = sobra).
    var remainder: Double {
        (totalAmount ?? 0) - assignedTotal
    }

    func remainderMinorUnits(currency: String) -> Int64? {
        guard let total = totalAmount,
              let totalUnits = PaymentPlanAmountMath.minorUnits(total, currency: currency),
              let firstUnits = PaymentPlanAmountMath.minorUnits(firstPaymentAmount, currency: currency) else {
            return nil
        }
        var assignedUnits = firstUnits
        for row in rows {
            guard let rowUnits = PaymentPlanAmountMath.minorUnits(rowAmount(row), currency: currency) else {
                return nil
            }
            assignedUnits += rowUnits
        }
        return totalUnits - assignedUnits
    }

    func isBalanced(currency: String) -> Bool {
        remainderMinorUnits(currency: currency) == 0
    }

    // MARK: Reparto en partes iguales (botón «Distribuir»)

    func distributeEqually(currency: String) {
        guard let total = totalAmount, total > 0 else { return }
        let slots = rows.count + 1 // primer pago + restantes
        guard slots > 0,
              let totalUnits = PaymentPlanAmountMath.minorUnits(total, currency: currency) else { return }
        let factor = Double(PaymentPlanAmountMath.minorUnitFactor(currency: currency))
        let eachUnits = totalUnits / Int64(slots)
        firstPaymentAmountText = SinglePaymentModel.plainAmountText(Double(eachUnits) / factor)

        var assignedUnits = eachUnits
        for index in rows.indices {
            if index == rows.count - 1 {
                let lastUnits = max(0, totalUnits - assignedUnits)
                rows[index].amountText = SinglePaymentModel.plainAmountText(Double(lastUnits) / factor)
            } else {
                rows[index].amountText = SinglePaymentModel.plainAmountText(Double(eachUnits) / factor)
                assignedUnits += eachUnits
            }
        }
    }

    func recalcDates() {
        guard frequency != .custom else { return }
        let timeZone = timeZoneProvider()
        let anchor = firstPaymentImmediate
            ? PaymentsDateMath.startOfToday(timeZone: timeZone)
            : firstPaymentDate
        for index in rows.indices {
            rows[index].date = PaymentsDateMath.advancing(anchor, frequency: frequency, steps: index + 1, timeZone: timeZone)
        }
    }

    func addRow() {
        let timeZone = timeZoneProvider()
        let lastDate = rows.last?.date ?? PaymentsDateMath.startOfToday(timeZone: timeZone)
        rows.append(
            RemainingRow(
                amountText: "",
                date: PaymentsDateMath.advancing(
                    lastDate,
                    frequency: frequency == .custom ? .monthly : frequency,
                    steps: 1,
                    timeZone: timeZone
                )
            )
        )
    }

    func removeRow(id: UUID) {
        rows.removeAll { $0.id == id }
    }

    // MARK: Validación (copys doc 08 §6.3.1)

    func validate(formatters: BusinessFormatters) -> Bool {
        guard let total = totalAmount, total > 0 else {
            validationMessage = "Ingresa un total válido para el plan"
            return false
        }
        guard !rows.isEmpty else {
            validationMessage = "Agrega al menos un pago restante"
            return false
        }
        if firstPaymentAmount > 0, firstPaymentAmount >= total {
            validationMessage = "El primer pago debe ser menor al total cuando hay parcialidades restantes"
            return false
        }
        for row in rows where rowAmount(row) <= 0 {
            validationMessage = "Todos los pagos restantes necesitan monto y fecha"
            return false
        }
        guard isBalanced(currency: formatters.currencyCode) else {
            let difference = formatters.currency(abs(remainder))
            validationMessage = "Las parcialidades no cuadran: faltan o sobran \(difference)"
            return false
        }
        guard destination != nil else {
            validationMessage = "Selecciona dónde crear el plan"
            return false
        }
        return true
    }

    // MARK: Envío

    func submit(appConfig: AppConfigStore) async -> Bool {
        guard !isSubmitting else { return false }
        let formatters = appConfig.formatters
        guard validate(formatters: formatters) else { return false }
        guard let destination, let total = totalAmount else { return false }

        // Guard duro de moneda (doc 01 §10).
        guard let accountCurrency = appConfig.accountCurrency else {
            validationMessage = "No se pudo leer la moneda de la cuenta. Reintenta cuando haya conexión."
            return false
        }

        isSubmitting = true
        defer { isSubmitting = false }

        let timeZone = timeZoneProvider()
        let firstEnabled = firstPaymentAmount > 0
        let firstDateString = firstPaymentImmediate
            ? ISO8601DateFormatter().string(from: Date())
            : PaymentsDateMath.dateString(firstPaymentDate, timeZone: timeZone)

        let firstPayment = PaymentPlanFirstPayment(
            enabled: firstEnabled,
            type: "amount",
            value: firstEnabled ? firstPaymentAmount : nil,
            amount: firstPaymentAmount,
            date: firstDateString,
            frequency: frequency == .custom ? "monthly" : frequency.apiValue,
            method: firstEnabled ? firstPaymentMethod.rawValue : nil
        )

        let remaining = rows.enumerated().map { index, row in
            PaymentPlanRemainingPayment(
                sequence: index + 1,
                type: "amount",
                value: rowAmount(row),
                amount: rowAmount(row),
                percentage: nil,
                dueDate: PaymentsDateMath.dateString(row.date, timeZone: timeZone),
                frequency: frequency == .custom ? "custom" : frequency.apiValue
            )
        }

        let planContact = PaymentPlanContact(
            id: contact.id,
            name: contact.name.isEmpty ? nil : contact.name,
            email: contact.email.isEmpty ? nil : contact.email,
            phone: contact.phone.isEmpty ? nil : contact.phone
        )

        do {
            switch destination {
            case .gateway(let gateway):
                let request = GatewayPaymentPlanRequest(
                    idempotencyKey: gatewayPaymentPlanIdempotencyKey,
                    contact: planContact,
                    totalAmount: total,
                    currency: accountCurrency,
                    description: concept.isEmpty ? nil : concept,
                    title: concept.isEmpty ? nil : concept,
                    firstPayment: firstPayment,
                    remainingFrequency: frequency == .custom ? "custom" : frequency.apiValue,
                    remainingPayments: remaining,
                    paymentMethodId: "",
                    source: "ios_native_payments_plan"
                )
                let result = try await PaymentLinksService.createPaymentPlan(gateway: gateway, request)
                handlePlanResult(
                    firstPaymentLink: result.firstPaymentLink,
                    cardSetupLink: result.cardSetupLink,
                    scheduledCount: result.scheduledPayments.count,
                    gatewayName: gateway.displayName,
                    total: total,
                    formatters: formatters
                )
                return true

            case .ristak:
                let request = PaymentFlowInstallmentsRequest(
                    contact: planContact,
                    totalAmount: total,
                    currency: accountCurrency,
                    description: concept.isEmpty ? nil : concept,
                    firstPayment: firstPayment,
                    remainingAutomatic: true,
                    remainingFrequency: frequency == .custom ? "custom" : frequency.apiValue,
                    remainingPayments: remaining,
                    channels: PaymentFlowChannels(
                        email: !contact.email.isEmpty,
                        sms: false,
                        whatsapp: !contact.phone.isEmpty
                    )
                )
                let result = try await PaymentsService.createInstallmentsFlow(request)
                if result.flowState == .waitingCardAuthorization,
                   (result.cardSetupPaymentLink ?? "").isEmpty,
                   (result.firstPaymentLink ?? "").isEmpty {
                    successMessage = "Parcialidades creadas. El sistema esperará la autorización de tarjeta antes de activar los pagos automáticos."
                } else {
                    handlePlanResult(
                        firstPaymentLink: result.firstPaymentLink,
                        cardSetupLink: result.cardSetupPaymentLink,
                        scheduledCount: rows.count,
                        gatewayName: nil,
                        total: total,
                        formatters: formatters
                    )
                }
                return true
            }
        } catch let error as RistakAPIError {
            validationMessage = error.message
            return false
        } catch {
            validationMessage = "No se pudo crear el plan. Intenta de nuevo."
            return false
        }
    }

    private func handlePlanResult(
        firstPaymentLink: String?,
        cardSetupLink: String?,
        scheduledCount: Int,
        gatewayName: String?,
        total: Double,
        formatters: BusinessFormatters
    ) {
        if let link = firstPaymentLink, !link.isEmpty {
            linkResult = PaymentLinkReadyPayload(
                kind: .firstPayment,
                url: link,
                gatewayName: gatewayName,
                contactName: contact.displayName,
                amountLabel: formatters.currency(firstPaymentAmount > 0 ? firstPaymentAmount : total),
                contactID: contact.id.isEmpty ? nil : contact.id,
                contactPhone: contact.phone.isEmpty ? nil : contact.phone
            )
        } else if let link = cardSetupLink, !link.isEmpty {
            linkResult = PaymentLinkReadyPayload(
                kind: .cardSetup,
                url: link,
                gatewayName: gatewayName,
                contactName: contact.displayName,
                amountLabel: formatters.currency(total),
                contactID: contact.id.isEmpty ? nil : contact.id,
                contactPhone: contact.phone.isEmpty ? nil : contact.phone
            )
        } else {
            successMessage = "\(scheduledCount) cobros quedaron programados."
        }
    }
}

// MARK: - Vista del plan

struct InstallmentsFlowView: View {
    @State private var model: InstallmentsPlanModel
    var onDone: () -> Void

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(PaymentsHomeModel.self) private var home

    @State private var successHaptic = false

    init(contact: PickedPaymentContact, timeZoneProvider: @escaping () -> TimeZone, onDone: @escaping () -> Void) {
        _model = State(initialValue: InstallmentsPlanModel(contact: contact, timeZoneProvider: timeZoneProvider))
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
        .navigationTitle("Plan de pagos")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: successHaptic)
        .alert(
            "Revisa el plan",
            isPresented: Binding(
                get: { model.validationMessage != nil },
                set: { if !$0 { model.validationMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { model.validationMessage = nil }
        } message: {
            Text(model.validationMessage ?? "")
        }
        .alert(
            "Plan creado",
            isPresented: Binding(
                get: { model.successMessage != nil },
                set: { if !$0 { model.successMessage = nil } }
            )
        ) {
            Button("Listo") {
                model.successMessage = nil
                home.refreshRecentSilently()
                onDone()
            }
        } message: {
            Text(model.successMessage ?? "")
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

    private var form: some View {
        Form {
            Section("Cliente") {
                PaymentContactSummaryRow(contact: model.contact)
            }

            Section {
                LabeledContent("Total (\(appConfig.displayCurrencyCode))") {
                    TextField("0.00", text: $model.totalText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                }

                TextField("Concepto", text: $model.concept)

                Picker("Frecuencia de cobro", selection: $model.frequency) {
                    ForEach(PaymentPlanFrequency.allCases) { frequency in
                        Text(frequency.label).tag(frequency)
                    }
                }

                Text(model.frequency == .custom
                     ? "Ajusta el monto y la fecha de cada cobro."
                     : "Las fechas se calculan automáticamente. Cambia a 'Personalizada' para editarlas a mano.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            } header: {
                Text("Plan de pagos")
            } footer: {
                Text("Define el primer pago y los cobros automáticos hasta cubrir el total a cobrar.")
            }

            firstPaymentSection
            remainingSection
            balanceSection
            destinationSection
            confirmSection
        }
        .paymentsKeyboardDismissable()
    }

    private var firstPaymentSection: some View {
        Section("Primer pago") {
            Picker("Momento", selection: $model.firstPaymentImmediate) {
                Text("Cobrar inmediato").tag(true)
                Text("Cobro programado").tag(false)
            }
            .pickerStyle(.segmented)
            .onChange(of: model.firstPaymentImmediate) {
                model.recalcDates()
            }

            if !model.firstPaymentImmediate {
                DatePicker(
                    "Fecha del primer pago",
                    selection: $model.firstPaymentDate,
                    in: PaymentsDateMath.startOfToday(timeZone: appConfig.businessTimeZone)...,
                    displayedComponents: .date
                )
                .environment(\.timeZone, appConfig.businessTimeZone)
                .onChange(of: model.firstPaymentDate) {
                    model.recalcDates()
                }
            }

            Picker("Método del primer pago", selection: $model.firstPaymentMethod) {
                ForEach(InstallmentsPlanModel.FirstPaymentMethod.allCases) { method in
                    Text(method.label).tag(method)
                }
            }

            LabeledContent("Monto del primer pago") {
                TextField("0.00", text: $model.firstPaymentAmountText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
            }

            Text(model.firstPaymentMethod.isOffline
                 ? "Con método offline, al crear el plan se genera un enlace de domiciliación para activar los cobros automáticos."
                 : "La pasarela enviará el primer link; cuando se pague, guardará la tarjeta y activará los cobros futuros.")
                .font(.caption)
                .foregroundStyle(RistakTheme.textMute)
        }
    }

    private var remainingSection: some View {
        Section("Pagos restantes") {
            ForEach($model.rows) { $row in
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    HStack {
                        Text("#\(rowNumber(for: row.id))")
                            .font(.caption.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(RistakTheme.textMute)

                        TextField("0.00", text: $row.amountText)
                            .keyboardType(.decimalPad)
                            .monospacedDigit()

                        Spacer()

                        Button(role: .destructive) {
                            model.removeRow(id: row.id)
                        } label: {
                            Image(systemName: "trash")
                                .font(.footnote)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Eliminar pago")
                    }

                    DatePicker(
                        "Fecha de cobro",
                        selection: $row.date,
                        in: PaymentsDateMath.startOfToday(timeZone: appConfig.businessTimeZone)...,
                        displayedComponents: .date
                    )
                    .environment(\.timeZone, appConfig.businessTimeZone)
                    .font(.subheadline)
                }
                .padding(.vertical, 2)
            }

            Button {
                model.addRow()
            } label: {
                Label("Agregar pago", systemImage: "plus")
            }

            Button {
                model.distributeEqually(currency: appConfig.displayCurrencyCode)
            } label: {
                Label("Distribuir en partes iguales", systemImage: "equal.circle")
            }
            .disabled((model.totalAmount ?? 0) <= 0)
        }
    }

    private var balanceSection: some View {
        let formatters = appConfig.formatters
        let total = model.totalAmount ?? 0
        let remainderMinorUnits = model.remainderMinorUnits(currency: appConfig.displayCurrencyCode)
        let isBalanced = remainderMinorUnits == 0

        return Section {
            HStack {
                Text("Asignado al plan")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                Spacer()
                Text("\(formatters.currency(model.assignedTotal)) / \(formatters.currency(total))")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(isBalanced ? RistakTheme.pos : RistakTheme.warn)
            }

            if isBalanced, total > 0 {
                Text("El plan cuadra con el total a cobrar.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.pos)
            } else if (remainderMinorUnits ?? 0) > 0 {
                Text("Faltan \(formatters.currency(model.remainder)) por asignar.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.warn)
            } else if (remainderMinorUnits ?? 0) < 0 {
                Text("Te excediste \(formatters.currency(abs(model.remainder))) del total.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.neg)
            }
        }
    }

    private func rowNumber(for id: UUID) -> Int {
        (model.rows.firstIndex { $0.id == id } ?? 0) + 2 // la fila #1 es el primer pago
    }

    private var destinationSection: some View {
        Section("Crear el plan con") {
            VStack(spacing: RistakTheme.Spacing.xs) {
                ForEach(destinations, id: \.self) { destination in
                    PaymentOptionRow(
                        title: destination.label,
                        subtitle: destinationCopy(destination),
                        isSelected: model.destination == destination
                    ) {
                        model.destination = destination
                    }
                }
            }
            .listRowSeparator(.hidden)
        }
    }

    private var destinations: [InstallmentsPlanModel.PlanDestination] {
        var options: [InstallmentsPlanModel.PlanDestination] = (home.capabilities?.planProviders ?? []).map { .gateway($0) }
        if home.isHighLevelConnected {
            options.append(.ristak)
        }
        return options
    }

    private func destinationCopy(_ destination: InstallmentsPlanModel.PlanDestination) -> String {
        switch destination {
        case .gateway:
            return model.firstPaymentMethod.isOffline
                ? "Enviará domiciliación; al pagarse, guardará la tarjeta y activará el plan."
                : "La pasarela enviará el primer link; cuando se pague, guardará la tarjeta y activará los cobros futuros."
        case .ristak:
            return "Programa las parcialidades en Ristak/HighLevel y envía los cobros por los canales del contacto."
        }
    }

    private var confirmSection: some View {
        Section {
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
                    Text(model.isSubmitting ? "Procesando..." : "Crear parcialidades")
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isSubmitting || destinations.isEmpty)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())

            if destinations.isEmpty {
                Text("Conecta Stripe, Conekta, Rebill o HighLevel para crear planes de pago.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
            }
        }
    }
}
