import SwiftUI
import Observation

/// Raíz del módulo Pagos (doc research/08):
/// - Compacto (iPhone): `NavigationStack` con home (tarjetas de tipo de cobro
///   + últimos pagos) y detalle de pago como sheet.
/// - Regular (iPad): `NavigationSplitView` — izquierda tipos + pagos
///   recientes; derecha el flujo o el detalle seleccionado.
struct PaymentsRootView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access
    @Environment(ShellState.self) private var shell

    @State private var home: PaymentsHomeModel?

    // Navegación compacta.
    @State private var path: [PaymentsRoute] = []
    @State private var presentedTransaction: PaymentTransaction?

    // Detalle en iPad.
    @State private var iPadDetail: PaymentsDetail?

    // Contact-first.
    @State private var pendingFlow: PaymentsFlow?
    @State private var showContactPicker = false
    /// Contacto precargado desde el chat («Cobro para ‹nombre›», bloqueado).
    @State private var pinnedContact: PickedPaymentContact?

    enum PaymentsDetail: Hashable {
        case route(PaymentsRoute)
        case transaction(String)
    }

    var body: some View {
        Group {
            if let home {
                content(home: home)
                    .environment(home)
            } else {
                // Sin loader de pantalla completa al abrir (estilo WhatsApp): el
                // modelo hidrata su caché al instante en `init`, así que basta un
                // fondo neutro de un frame mientras se crea. Cero spinner: el
                // contenido cacheado aparece de inmediato.
                RistakTheme.bgGrouped
                    .ignoresSafeArea()
                    .onAppear {
                        let config = appConfig
                        home = PaymentsHomeModel(timeZoneProvider: { config.businessTimeZone })
                    }
            }
        }
    }

    // MARK: - Contenido adaptativo

    @ViewBuilder
    private func content(home: PaymentsHomeModel) -> some View {
        Group {
            if horizontalSizeClass == .regular {
                splitLayout(home: home)
            } else {
                compactLayout(home: home)
            }
        }
        .onAppear {
            home.startRealtime()
            Task { await home.loadIfNeeded() }
        }
        .onDisappear {
            home.stopRealtime()
        }
        .task(id: shell.pendingPaymentContactID) {
            await consumePendingContact()
        }
        .sheet(isPresented: $showContactPicker) {
            PaymentsContactPickerSheet { picked in
                guard let flow = pendingFlow else { return }
                pendingFlow = nil
                open(PaymentsRoute(flow: flow, contact: picked))
            }
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: iPhone

    private func compactLayout(home: PaymentsHomeModel) -> some View {
        NavigationStack(path: $path) {
            PaymentsHomeView(
                pinnedContact: pinnedContact,
                onUnpinContact: { pinnedContact = nil },
                onStartFlow: { startFlow($0) },
                onOpenTransaction: { presentedTransaction = $0 }
            )
            .navigationTitle("Pagos")
            .navigationDestination(for: PaymentsRoute.self) { route in
                flowView(for: route)
            }
        }
        .sheet(item: $presentedTransaction) { transaction in
            NavigationStack {
                PaymentDetailView(transactionID: transaction.id, preview: transaction)
            }
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: iPad

    private func splitLayout(home: PaymentsHomeModel) -> some View {
        NavigationSplitView {
            PaymentsSidebarView(
                pinnedContact: pinnedContact,
                onUnpinContact: { pinnedContact = nil },
                selectedDetail: iPadDetail,
                onStartFlow: { startFlow($0) },
                onOpenTransaction: { iPadDetail = .transaction($0.id) }
            )
            .navigationTitle("Pagos")
        } detail: {
            NavigationStack {
                switch iPadDetail {
                case .route(let route):
                    flowView(for: route)
                case .transaction(let id):
                    PaymentDetailView(transactionID: id)
                case nil:
                    RistakEmptyState(
                        icon: "dollarsign.circle",
                        title: "Pagos",
                        message: "Elige cómo quieres cobrar o revisa un pago reciente."
                    )
                }
            }
            .id(iPadDetail)
        }
    }

    // MARK: - Flujos

    @ViewBuilder
    private func flowView(for route: PaymentsRoute) -> some View {
        switch route.flow {
        case .single:
            SinglePaymentFlowView(
                contact: route.contact ?? PickedPaymentContact(id: "", name: "", email: "", phone: ""),
                onDone: closeFlows
            )
        case .installments:
            let config = appConfig
            InstallmentsFlowView(
                contact: route.contact ?? PickedPaymentContact(id: "", name: "", email: "", phone: ""),
                timeZoneProvider: { config.businessTimeZone },
                onDone: closeFlows
            )
        case .subscription:
            SubscriptionsFlowView(contact: route.contact, onDone: closeFlows)
        case .products:
            ProductsFlowView(onDone: closeFlows)
        }
    }

    /// Contact-first (doc 08 §6.3.1): pago único y plan piden contacto antes
    /// de configurar; productos no; suscripción trae su propio picker.
    private func startFlow(_ flow: PaymentsFlow) {
        switch flow {
        case .products, .subscription:
            open(PaymentsRoute(flow: flow, contact: pinnedContact))
        case .single, .installments:
            if let pinnedContact {
                open(PaymentsRoute(flow: flow, contact: pinnedContact))
            } else {
                pendingFlow = flow
                showContactPicker = true
            }
        }
    }

    private func open(_ route: PaymentsRoute) {
        if horizontalSizeClass == .regular {
            iPadDetail = .route(route)
        } else {
            path.append(route)
        }
    }

    private func closeFlows() {
        if horizontalSizeClass == .regular {
            iPadDetail = nil
        } else {
            path = []
        }
    }

    // MARK: - Contacto precargado desde el chat

    private func consumePendingContact() async {
        guard let contactID = shell.pendingPaymentContactID, !contactID.isEmpty else { return }
        shell.pendingPaymentContactID = nil
        if let detail = try? await ContactsService().fetchContact(
            id: contactID,
            warmProfilePictures: false,
            refreshExternalAppointments: false
        ) {
            pinnedContact = PickedPaymentContact(detail: detail, isLocked: true)
        }
    }
}

// MARK: - Home compacto (iPhone)

private struct PaymentsHomeView: View {
    let pinnedContact: PickedPaymentContact?
    var onUnpinContact: () -> Void
    var onStartFlow: (PaymentsFlow) -> Void
    var onOpenTransaction: (PaymentTransaction) -> Void

    @Environment(PaymentsHomeModel.self) private var home
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                if let pinnedContact {
                    pinnedContactCard(pinnedContact)
                }

                if access.canWrite(module: .payments) {
                    Text("Elige cómo quieres pagar")
                        .font(.title3.bold())
                        .foregroundStyle(RistakTheme.textPrimary)

                    PaymentsChoiceList(onStartFlow: onStartFlow)
                }

                RecentPaymentsSection(onOpenTransaction: onOpenTransaction)
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.top, RistakTheme.Spacing.xs)
            .padding(.bottom, RistakTheme.Spacing.xxl)
        }
        .background(RistakTheme.bgGrouped)
        .refreshable {
            await home.refreshAll()
        }
        // Dock por dirección de scroll (#11) sobre el home compacto de Pagos.
        // Solo compacto; ver `ShellScrollTracking.swift`.
        .reportsShellScroll()
    }

    private func pinnedContactCard(_ contact: PickedPaymentContact) -> some View {
        SectionCard(title: "Cobro para") {
            HStack(spacing: RistakTheme.Spacing.sm) {
                ContactAvatarView(name: contact.displayName, photoURL: contact.photoURL, size: 42)

                VStack(alignment: .leading, spacing: 2) {
                    Text(contact.displayName)
                        .font(.body.weight(.semibold))
                    if !contact.secondaryLabel.isEmpty {
                        Text(contact.secondaryLabel)
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }

                Spacer()

                Button {
                    onUnpinContact()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(RistakTheme.textMute)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Quitar contacto")
            }
        }
    }
}

// MARK: - Sidebar (iPad)

private struct PaymentsSidebarView: View {
    let pinnedContact: PickedPaymentContact?
    var onUnpinContact: () -> Void
    var selectedDetail: PaymentsRootView.PaymentsDetail?
    var onStartFlow: (PaymentsFlow) -> Void
    var onOpenTransaction: (PaymentTransaction) -> Void

    @Environment(PaymentsHomeModel.self) private var home
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                if let pinnedContact {
                    SectionCard(title: "Cobro para") {
                        PaymentContactSummaryRow(contact: pinnedContact, onClear: onUnpinContact)
                    }
                }

                if access.canWrite(module: .payments) {
                    Text("Elige cómo quieres pagar")
                        .font(.headline)
                        .foregroundStyle(RistakTheme.textPrimary)

                    PaymentsChoiceList(onStartFlow: onStartFlow)
                }

                RecentPaymentsSection(onOpenTransaction: onOpenTransaction)
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.bottom, RistakTheme.Spacing.xxl)
        }
        .background(RistakTheme.bgGrouped)
        .refreshable {
            await home.refreshAll()
        }
    }
}

// MARK: - Tarjetas de tipo de cobro (doc 08 §6.1)

private struct PaymentsChoiceList: View {
    var onStartFlow: (PaymentsFlow) -> Void

    @Environment(PaymentsHomeModel.self) private var home

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.xs) {
            PaymentChoiceCard(
                icon: "creditcard",
                title: "Registrar pago único",
                subtitle: "Cobro único: envía una liga de pago o registra un pago manual.",
                iconTint: RistakTheme.pos
            ) {
                onStartFlow(.single)
            }

            if home.capabilities?.canUsePaymentPlans == true {
                PaymentChoiceCard(
                    icon: "calendar.badge.clock",
                    title: "Planes de pago",
                    subtitle: "Parcialidades automáticas con enganche y cobros recurrentes.",
                    iconTint: RistakTheme.accent
                ) {
                    onStartFlow(.installments)
                }
            }

            if home.capabilities?.canUseSubscriptions == true {
                PaymentChoiceCard(
                    icon: "repeat",
                    title: "Suscripción",
                    subtitle: "Cobros recurrentes con Stripe, Conekta o Mercado Pago.",
                    iconTint: RistakTheme.info
                ) {
                    onStartFlow(.subscription)
                }
            }

            PaymentChoiceCard(
                icon: "shippingbox",
                title: "Precios Guardados",
                subtitle: "Revisa, crea, modifica o elimina precios para cobrarlos desde el celular.",
                iconTint: RistakTheme.warn
            ) {
                onStartFlow(.products)
            }
        }
    }
}

// MARK: - Últimos pagos (doc 08 §6.1)

private struct RecentPaymentsSection: View {
    var onOpenTransaction: (PaymentTransaction) -> Void

    @Environment(PaymentsHomeModel.self) private var home
    @Environment(AppConfigStore.self) private var appConfig

    var body: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            Text("Últimos pagos")
                .font(.title3.bold())
                .foregroundStyle(RistakTheme.textPrimary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ForEach(RecentPaymentsPeriod.allCases) { period in
                        RistakFilterChip(
                            title: period.label,
                            isSelected: home.period == period
                        ) {
                            home.period = period
                        }
                    }
                }
            }
            .ristakEdgeToEdgeChips(horizontalInset: RistakTheme.Spacing.md)
            .padding(.horizontal, -RistakTheme.Spacing.md)

            content
        }
    }

    @ViewBuilder
    private var content: some View {
        if home.accessDenied {
            SectionCard {
                Text("No tienes acceso a esta sección.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, RistakTheme.Spacing.md)
            }
        } else if !home.recentPayments.isEmpty {
            // SWR: si hay datos (cacheados o frescos) SIEMPRE mostramos la lista.
            // Nunca la ocultamos por spinner ni por un error de revalidación.
            paymentsList
        } else if let error = home.recentError {
            // Error SOLO cuando no hay nada que mostrar (primera carga sin caché
            // fallida). Con datos visibles jamás llegamos aquí.
            SectionCard {
                VStack(spacing: RistakTheme.Spacing.sm) {
                    Text(error.message)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .multilineTextAlignment(.center)

                    Button("Reintentar") {
                        Task { await home.loadRecentPayments(reset: true) }
                    }
                    .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, RistakTheme.Spacing.sm)
            }
        } else if home.isLoadingRecent {
            // Primera carga sin caché: mantenemos el chrome (título + chips) y NO
            // mostramos spinner ni un falso «no hay pagos». La lista se llena sola
            // en cuanto llega la respuesta.
            EmptyView()
        } else {
            SectionCard {
                Text("No hay pagos recibidos en este periodo.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, RistakTheme.Spacing.md)
            }
        }
    }

    private var paymentsList: some View {
        Group {
            SectionCard {
                LazyVStack(spacing: 0) {
                    ForEach(home.recentPayments) { transaction in
                        Button {
                            onOpenTransaction(transaction)
                        } label: {
                            PaymentTransactionRow(
                                transaction: transaction,
                                formatters: appConfig.formatters,
                                timeZone: appConfig.businessTimeZone
                            )
                        }
                        .buttonStyle(.plain)
                        .onAppear {
                            home.loadMoreIfNeeded(current: transaction)
                        }

                        if transaction.id != home.recentPayments.last?.id {
                            Divider()
                        }
                    }

                    if home.isLoadingMore {
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, RistakTheme.Spacing.sm)
                    }
                }
            }
        }
    }
}
