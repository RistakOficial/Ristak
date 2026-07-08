import SwiftUI
import Observation

// MARK: - Modelo de suscripciones (doc 08 §4 y §6.4)

@MainActor
@Observable
final class SubscriptionsModel {
    /// Frecuencias del formulario (doc 08 §6.4).
    enum Interval: String, CaseIterable, Identifiable {
        case daily
        case weekly
        case monthly
        case yearly

        var id: String { rawValue }

        var label: String {
            switch self {
            case .daily: return "Diaria"
            case .weekly: return "Semanal"
            case .monthly: return "Mensual"
            case .yearly: return "Anual"
            }
        }
    }

    // Lista.
    private(set) var subscriptions: [PaymentSubscription] = []
    private(set) var summary: SubscriptionsSummary?
    private(set) var isLoadingList = false
    private(set) var listError: RistakAPIError?
    private(set) var accessDenied = false
    /// Ids de suscripciones con acción en vuelo (deshabilitar sus botones).
    private(set) var busyIDs: Set<String> = []

    // Formulario.
    var contact: PickedPaymentContact?
    var name = ""
    var amountText = ""
    var interval: Interval = .monthly
    var intervalCountText = "1"
    var startDate = Date()
    var notes = ""
    var selectedGateway: PaymentGateway?

    // Envío.
    private(set) var isSubmitting = false
    var validationMessage: String?
    var linkResult: PaymentLinkReadyPayload?
    var successMessage: String?

    // MARK: Lista

    func loadList() async {
        isLoadingList = subscriptions.isEmpty
        listError = nil
        defer { isLoadingList = false }
        do {
            let result = try await SubscriptionsService.subscriptions(status: "all")
            subscriptions = result.subscriptions
            summary = result.summary
            accessDenied = false
        } catch let error as RistakAPIError {
            if error.isAccessDenied {
                accessDenied = true
            } else if error.kind == .featureUnavailable {
                // Silencioso en cargas: lista vacía.
                subscriptions = []
            } else if subscriptions.isEmpty {
                listError = error
            }
        } catch {
            if subscriptions.isEmpty {
                listError = RistakAPIError(kind: .server, status: 0, message: "No se pudieron cargar las suscripciones.", underlying: error)
            }
        }
    }

    /// Acciones documentadas (doc 08 §4): pause / activate / cancel — se
    /// propagan a la pasarela.
    func perform(action: PaymentSubscriptionAction, on subscription: PaymentSubscription) async {
        guard !busyIDs.contains(subscription.id) else { return }
        busyIDs.insert(subscription.id)
        defer { busyIDs.remove(subscription.id) }
        do {
            let updated = try await SubscriptionsService.performAction(id: subscription.id, action: action)
            if let index = subscriptions.firstIndex(where: { $0.id == updated.id }) {
                subscriptions[index] = updated
            }
            await loadList()
        } catch let error as RistakAPIError {
            validationMessage = error.message
        } catch {
            validationMessage = "No se pudo completar la acción."
        }
    }

    // MARK: Formulario

    var amount: Double? {
        PaymentsAmountParser.amount(from: amountText)
    }

    var intervalCount: Int {
        max(1, Int(intervalCountText.trimmingCharacters(in: .whitespaces)) ?? 1)
    }

    /// Pasarelas disponibles que soportan la frecuencia elegida.
    func gatewaysSupporting(interval: Interval, capabilities: PaymentCapabilities?) -> [PaymentGateway] {
        (capabilities?.subscriptionProviders ?? []).filter {
            $0.supportedSubscriptionIntervals.contains(interval.rawValue)
        }
    }

    /// `paymentMethod` por pasarela (paridad `PhoneSubscriptionForm`, doc 08 §4).
    private func paymentMethod(for gateway: PaymentGateway) -> String? {
        switch gateway {
        case .stripe: return "stripe_saved_card"
        case .conekta: return "conekta_subscription"
        case .mercadopago: return "mercadopago_subscription"
        case .rebill: return "rebill_subscription"
        case .clip: return nil
        }
    }

    func validate(capabilities: PaymentCapabilities?) -> Bool {
        guard let gateway = selectedGateway else {
            validationMessage = "Pasarela no conectada"
            return false
        }
        guard capabilities?.subscriptionProviders.contains(gateway) == true else {
            validationMessage = "Pasarela no conectada"
            return false
        }
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            validationMessage = "Falta el nombre"
            return false
        }
        guard let amount, amount > 0 else {
            validationMessage = "Falta el monto"
            return false
        }
        // Stripe/Conekta necesitan contacto guardado; MP/Rebill piden email.
        switch gateway {
        case .stripe, .conekta:
            guard contact != nil, contact?.id.isEmpty == false else {
                validationMessage = "Falta el contacto"
                return false
            }
        case .mercadopago, .rebill:
            guard let contact, !contact.email.isEmpty else {
                validationMessage = "Falta el email"
                return false
            }
        case .clip:
            validationMessage = "Pasarela no conectada"
            return false
        }
        guard gateway.supportedSubscriptionIntervals.contains(interval.rawValue) else {
            validationMessage = "Frecuencia no soportada"
            return false
        }
        return true
    }

    func submit(appConfig: AppConfigStore, capabilities: PaymentCapabilities?) async -> Bool {
        guard !isSubmitting else { return false }
        guard validate(capabilities: capabilities) else { return false }
        guard let gateway = selectedGateway, let amount else { return false }

        guard let accountCurrency = appConfig.accountCurrency else {
            validationMessage = "No se pudo leer la moneda de la cuenta. Reintenta cuando haya conexión."
            return false
        }

        isSubmitting = true
        defer { isSubmitting = false }

        let timeZone = appConfig.businessTimeZone
        let startString = PaymentsDateMath.dateString(startDate, timeZone: timeZone)
        // MP/Rebill quedan `incomplete` con `nextRunAt` null hasta autorizar.
        let needsAuthorization = gateway == .mercadopago || gateway == .rebill

        let payload = SubscriptionPayload(
            contactId: contact?.id,
            contactName: contact?.name.isEmpty == false ? contact?.name : nil,
            contactEmail: contact?.email.isEmpty == false ? contact?.email : nil,
            contactPhone: contact?.phone.isEmpty == false ? contact?.phone : nil,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: notes.isEmpty ? nil : notes,
            status: needsAuthorization ? "incomplete" : "active",
            amount: amount,
            currency: accountCurrency,
            intervalType: interval.rawValue,
            intervalCount: intervalCount,
            startDate: startString,
            nextRunAt: needsAuthorization ? nil : startString,
            paymentMethod: paymentMethod(for: gateway),
            paymentProvider: gateway.rawValue,
            source: "ios_native_payments_subscription"
        )

        do {
            let created = try await SubscriptionsService.createSubscription(payload)
            if let link = created.activationLink, !link.isEmpty {
                linkResult = PaymentLinkReadyPayload(
                    kind: .subscription,
                    url: link,
                    gatewayName: gateway.displayName,
                    contactName: contact?.displayName,
                    amountLabel: appConfig.formatters.currency(amount),
                    contactID: (contact?.id.isEmpty == false) ? contact?.id : nil,
                    contactPhone: (contact?.phone.isEmpty == false) ? contact?.phone : nil
                )
            } else {
                successMessage = "\(created.name.isEmpty ? "La suscripción" : created.name) quedó guardada."
            }
            await loadList()
            return true
        } catch let error as RistakAPIError {
            validationMessage = error.message
            return false
        } catch {
            validationMessage = "No se pudo crear la suscripción."
            return false
        }
    }

    func resetForm(keeping contact: PickedPaymentContact?) {
        self.contact = contact
        name = ""
        amountText = ""
        interval = .monthly
        intervalCountText = "1"
        startDate = Date()
        notes = ""
    }
}

// MARK: - Vista: lista + formulario

struct SubscriptionsFlowView: View {
    @State private var model = SubscriptionsModel()
    let initialContact: PickedPaymentContact?
    var onDone: () -> Void

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(PaymentsHomeModel.self) private var home

    @State private var showForm = false
    @State private var showContactPicker = false
    @State private var successHaptic = false

    init(contact: PickedPaymentContact?, onDone: @escaping () -> Void) {
        self.initialContact = contact
        self.onDone = onDone
    }

    var body: some View {
        Group {
            if model.accessDenied {
                PaymentsNoAccessView()
            } else {
                list
            }
        }
        .navigationTitle("Suscripciones")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model.contact == nil {
                model.contact = initialContact
                if initialContact != nil {
                    showForm = true
                }
            }
            await model.loadList()
        }
        .onChange(of: home.subscriptionsRefreshTick) {
            Task { await model.loadList() }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.resetForm(keeping: initialContact)
                    showForm = true
                } label: {
                    Label("Nueva suscripción", systemImage: "plus")
                }
                .accessibilityLabel("Nueva suscripción")
            }
        }
        .navigationDestination(isPresented: $showForm) {
            SubscriptionFormView(model: model, onDone: onDone)
        }
        .alert(
            "Suscripciones",
            isPresented: Binding(
                get: { model.validationMessage != nil },
                set: { if !$0 { model.validationMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { model.validationMessage = nil }
        } message: {
            Text(model.validationMessage ?? "")
        }
    }

    @ViewBuilder
    private var list: some View {
        if model.isLoadingList && model.subscriptions.isEmpty {
            RistakLoadingView(message: "Cargando suscripciones…")
        } else if let error = model.listError, model.subscriptions.isEmpty {
            RistakErrorState(message: error.message) {
                Task { await model.loadList() }
            }
        } else if model.subscriptions.isEmpty {
            ScrollView {
                RistakEmptyState(
                    icon: "repeat",
                    title: "Sin suscripciones",
                    message: "Crea un cobro recurrente con Stripe, Conekta, Mercado Pago o Rebill."
                )
                .padding(.top, RistakTheme.Spacing.xxl)
            }
            .refreshable { await model.loadList() }
        } else {
            List {
                if let summary = model.summary {
                    Section {
                        HStack(spacing: RistakTheme.Spacing.md) {
                            summaryItem(label: "Activas", value: "\(summary.active)", tint: RistakTheme.pos)
                            summaryItem(label: "Pausadas", value: "\(summary.paused)", tint: RistakTheme.warn)
                            summaryItem(label: "Vencidas", value: "\(summary.pastDue)", tint: RistakTheme.neg)
                        }
                        .listRowSeparator(.hidden)
                    }
                }

                Section {
                    ForEach(model.subscriptions) { subscription in
                        subscriptionRow(subscription)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await model.loadList() }
        }
    }

    private func summaryItem(label: String, value: String, tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title3.bold())
                .monospacedDigit()
                .foregroundStyle(tint)
            Text(label)
                .font(.caption)
                .foregroundStyle(RistakTheme.textDim)
        }
        .frame(maxWidth: .infinity)
    }

    private func subscriptionRow(_ subscription: PaymentSubscription) -> some View {
        let formatters = appConfig.formatters
        let status = subscription.subscriptionStatus
        let isBusy = model.busyIDs.contains(subscription.id)

        return VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(subscription.name.isEmpty ? "Suscripción" : subscription.name)
                        .font(.body.weight(.semibold))

                    if let contactName = subscription.contactName, !contactName.isEmpty {
                        Text(contactName)
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }

                Spacer()

                subscriptionStatusBadge(status)
            }

            HStack {
                Text(formatters.currency(subscription.amount, currencyOverride: subscription.currency))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()

                Text("· \(intervalLabel(subscription))")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)

                Spacer()

                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    actionsMenu(subscription, status: status)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func subscriptionStatusBadge(_ status: PaymentSubscriptionStatus?) -> some View {
        let tint: Color = {
            switch status {
            case .active, .trialing: return RistakTheme.pos
            case .paused, .incomplete, .draft: return RistakTheme.warn
            case .pastDue, .cancelled: return RistakTheme.neg
            case nil: return RistakTheme.info
            }
        }()

        return Text(status?.displayLabel ?? "—")
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.14)))
    }

    @ViewBuilder
    private func actionsMenu(_ subscription: PaymentSubscription, status: PaymentSubscriptionStatus?) -> some View {
        Menu {
            if status?.countsAsActive == true {
                Button {
                    Task { await model.perform(action: .pause, on: subscription) }
                } label: {
                    Label("Pausar", systemImage: "pause.circle")
                }
            }

            if status == .paused {
                Button {
                    Task { await model.perform(action: .activate, on: subscription) }
                } label: {
                    Label("Activar", systemImage: "play.circle")
                }
            }

            if let link = subscription.activationLink, !link.isEmpty {
                ShareLink(item: link) {
                    Label("Compartir link de activación", systemImage: "square.and.arrow.up")
                }
            }

            if status != .cancelled {
                Button(role: .destructive) {
                    Task { await model.perform(action: .cancel, on: subscription) }
                } label: {
                    Label("Cancelar suscripción", systemImage: "xmark.circle")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.body)
                .foregroundStyle(RistakTheme.textDim)
        }
        .accessibilityLabel("Acciones de la suscripción")
    }

    private func intervalLabel(_ subscription: PaymentSubscription) -> String {
        let unit: String
        switch subscription.intervalType {
        case "daily": unit = subscription.intervalCount == 1 ? "día" : "días"
        case "weekly": unit = subscription.intervalCount == 1 ? "semana" : "semanas"
        case "yearly": unit = subscription.intervalCount == 1 ? "año" : "años"
        default: unit = subscription.intervalCount == 1 ? "mes" : "meses"
        }
        return subscription.intervalCount == 1 ? "Cada \(unit)" : "Cada \(subscription.intervalCount) \(unit)"
    }
}

// MARK: - Formulario «Nueva suscripción» (doc 08 §6.4)

struct SubscriptionFormView: View {
    @Bindable var model: SubscriptionsModel
    var onDone: () -> Void

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(PaymentsHomeModel.self) private var home
    @Environment(\.dismiss) private var dismiss

    @State private var showContactPicker = false
    @State private var successHaptic = false

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
        .navigationTitle("Nueva suscripción")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: successHaptic)
        .sheet(isPresented: $showContactPicker) {
            PaymentsContactPickerSheet { picked in
                model.contact = picked
            }
            .presentationDetents([.medium, .large])
        }
        .alert(
            "Revisa la suscripción",
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
            "Suscripción creada",
            isPresented: Binding(
                get: { model.successMessage != nil },
                set: { if !$0 { model.successMessage = nil } }
            )
        ) {
            Button("Listo") {
                model.successMessage = nil
                dismiss()
            }
        } message: {
            Text(model.successMessage ?? "")
        }
        .sheet(item: $model.linkResult) { payload in
            PaymentLinkReadySheet(payload: payload)
                .presentationDetents([.medium, .large])
                .onDisappear {
                    dismiss()
                }
        }
    }

    private var form: some View {
        Form {
            Section("Cliente") {
                if let contact = model.contact {
                    PaymentContactSummaryRow(contact: contact) {
                        model.contact = nil
                    }
                } else {
                    Button {
                        showContactPicker = true
                    } label: {
                        Label("Seleccionar contacto", systemImage: "person.crop.circle.badge.plus")
                    }
                }

                if let gateway = model.selectedGateway, gateway == .stripe || gateway == .conekta {
                    Text("\(gateway.displayName) necesita un contacto guardado.")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textMute)
                }
            }

            Section("Cobro recurrente") {
                TextField("Ej. Membresía mensual", text: $model.name)

                LabeledContent("Monto (\(appConfig.displayCurrencyCode))") {
                    TextField("0.00", text: $model.amountText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                }

                Picker("Frecuencia", selection: $model.interval) {
                    ForEach(SubscriptionsModel.Interval.allCases) { interval in
                        Text(interval.label).tag(interval)
                    }
                }

                LabeledContent("Cada") {
                    TextField("1", text: $model.intervalCountText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                }

                DatePicker(
                    "Inicio",
                    selection: $model.startDate,
                    in: PaymentsDateMath.startOfToday(timeZone: appConfig.businessTimeZone)...,
                    displayedComponents: .date
                )
                .environment(\.timeZone, appConfig.businessTimeZone)

                TextField("Notas internas de esta suscripción.", text: $model.notes, axis: .vertical)
                    .lineLimit(2...4)
            }

            gatewaySection
            confirmSection
        }
        .paymentsKeyboardDismissable()
    }

    private var gatewaySection: some View {
        let gateways = model.gatewaysSupporting(interval: model.interval, capabilities: home.capabilities)

        return Section {
            if gateways.isEmpty {
                Text("Ninguna pasarela conectada soporta esta frecuencia.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.warn)
            } else {
                VStack(spacing: RistakTheme.Spacing.xs) {
                    ForEach(gateways, id: \.rawValue) { gateway in
                        PaymentOptionRow(
                            title: gateway.displayName,
                            subtitle: gatewayCopy(gateway),
                            isSelected: model.selectedGateway == gateway
                        ) {
                            model.selectedGateway = gateway
                        }
                    }
                }
                .listRowSeparator(.hidden)
            }
        } header: {
            Text("Elige pasarela")
        } footer: {
            Text("Selecciona dónde quieres crear el enlace o autorización de la suscripción.")
        }
    }

    private func gatewayCopy(_ gateway: PaymentGateway) -> String {
        switch gateway {
        case .stripe: return "Suscripciones con Stripe."
        case .conekta: return "Domiciliación con tarjeta guardada."
        case .mercadopago: return "Autorización por enlace de Mercado Pago."
        case .rebill: return "Autorización por checkout hospedado de Rebill."
        case .clip: return ""
        }
    }

    private var confirmSection: some View {
        Section {
            Button {
                Task {
                    let finished = await model.submit(appConfig: appConfig, capabilities: home.capabilities)
                    if finished { successHaptic.toggle() }
                }
            } label: {
                HStack {
                    if model.isSubmitting {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(model.isSubmitting ? "Procesando..." : "Crear enlace de pago")
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isSubmitting)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
    }
}
