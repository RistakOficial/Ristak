import SwiftUI
import Observation

/// Hoja de cobro reutilizable presentada EN SITIO desde la cabecera del chat
/// (icono de dinero). Muestra los mismos tipos de cobro que `PaymentsRootView`
/// (registrar pago único / planes / suscripción / precios guardados) ya
/// acotados al contacto de la conversación y baja al formulario dentro de la
/// MISMA hoja, para que el usuario elija el tipo de cobro y llene el formulario
/// sin salir del chat.
///
/// Reutiliza los flujos ya existentes (`SinglePaymentFlowView`,
/// `InstallmentsFlowView`, `SubscriptionsFlowView`, `ProductsFlowView`) y crea
/// su propio `PaymentsHomeModel` porque ese modelo no vive en el entorno
/// global: nace dentro de `PaymentsRootView`. Aquí lo instanciamos e inyectamos
/// para que los flujos lean capacidades (pasarelas/licencia) y refresquen los
/// pagos recientes igual que en la pestaña de Pagos.
struct PaymentComposeSheet: View {
    let contact: PickedPaymentContact
    var onDone: () -> Void

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access
    @Environment(\.dismiss) private var dismiss

    @State private var home: PaymentsHomeModel?
    @State private var path: [PaymentsRoute] = []

    // MARK: - Inits (contrato del proxy del chat)

    /// Contacto ya resuelto (bloqueado: viene de la conversación).
    init(contact: PickedPaymentContact, onDone: @escaping () -> Void) {
        self.contact = contact
        self.onDone = onDone
    }

    /// Conveniencia para el chat: construye el `PickedPaymentContact` (bloqueado)
    /// a partir de los ids/datos que ya tiene la conversación, para no obligar al
    /// llamador a conocer el modelo interno de Pagos.
    init(
        contactID: String,
        contactName: String?,
        contactEmail: String?,
        contactPhone: String?,
        onDone: @escaping () -> Void
    ) {
        self.init(
            contact: PickedPaymentContact(
                id: contactID,
                name: contactName ?? "",
                email: contactEmail ?? "",
                phone: contactPhone ?? "",
                isLocked: true
            ),
            onDone: onDone
        )
    }

    // MARK: - Body

    var body: some View {
        Group {
            if let home {
                content(home: home)
                    .environment(home)
            } else {
                RistakLoadingView(message: "Cargando pagos…")
                    .onAppear {
                        let config = appConfig
                        home = PaymentsHomeModel(timeZoneProvider: { config.businessTimeZone })
                    }
            }
        }
    }

    private func content(home: PaymentsHomeModel) -> some View {
        NavigationStack(path: $path) {
            chooser(home: home)
                .navigationTitle("Cobrar")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cerrar") { dismiss() }
                    }
                }
                .navigationDestination(for: PaymentsRoute.self) { route in
                    flowView(for: route)
                }
        }
        .onAppear {
            home.startRealtime()
            Task { await home.loadIfNeeded() }
        }
        .onDisappear {
            home.stopRealtime()
        }
    }

    // MARK: - Selector de tipo de cobro (paridad `PaymentsChoiceList`)

    private func chooser(home: PaymentsHomeModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                SectionCard(title: "Cobro para") {
                    PaymentContactSummaryRow(contact: contact)
                }

                if access.canWrite(module: .payments) {
                    Text("Elige cómo quieres cobrar")
                        .font(.title3.bold())
                        .foregroundStyle(RistakTheme.textPrimary)

                    choices(home: home)
                } else {
                    Text("No tienes permisos para crear cobros.")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, RistakTheme.Spacing.md)
                }
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.top, RistakTheme.Spacing.xs)
            .padding(.bottom, RistakTheme.Spacing.xxl)
        }
        .background(RistakTheme.bgGrouped)
    }

    private func choices(home: PaymentsHomeModel) -> some View {
        VStack(spacing: RistakTheme.Spacing.xs) {
            PaymentChoiceCard(
                icon: "creditcard",
                title: "Registrar pago único",
                subtitle: "Cobro único: envía una liga de pago o registra un pago manual.",
                iconTint: RistakTheme.pos
            ) {
                path.append(PaymentsRoute(flow: .single, contact: contact))
            }

            if home.capabilities?.canUsePaymentPlans == true {
                PaymentChoiceCard(
                    icon: "calendar.badge.clock",
                    title: "Planes de pago",
                    subtitle: "Parcialidades automáticas con enganche y cobros recurrentes.",
                    iconTint: RistakTheme.accent
                ) {
                    path.append(PaymentsRoute(flow: .installments, contact: contact))
                }
            }

            if home.capabilities?.canUseSubscriptions == true {
                PaymentChoiceCard(
                    icon: "repeat",
                    title: "Suscripción",
                    subtitle: "Cobros recurrentes con Stripe, Conekta o Mercado Pago.",
                    iconTint: RistakTheme.info
                ) {
                    path.append(PaymentsRoute(flow: .subscription, contact: contact))
                }
            }

            PaymentChoiceCard(
                icon: "shippingbox",
                title: "Precios Guardados",
                subtitle: "Revisa, crea, modifica o elimina precios para cobrarlos desde el celular.",
                iconTint: RistakTheme.warn
            ) {
                path.append(PaymentsRoute(flow: .products, contact: nil))
            }
        }
    }

    // MARK: - Flujos (reutilizados tal cual)

    @ViewBuilder
    private func flowView(for route: PaymentsRoute) -> some View {
        switch route.flow {
        case .single:
            SinglePaymentFlowView(
                contact: route.contact ?? contact,
                onDone: finish
            )
        case .installments:
            let config = appConfig
            InstallmentsFlowView(
                contact: route.contact ?? contact,
                timeZoneProvider: { config.businessTimeZone },
                onDone: finish
            )
        case .subscription:
            SubscriptionsFlowView(contact: route.contact, onDone: finish)
        case .products:
            ProductsFlowView(onDone: finish)
        }
    }

    /// Un flujo terminó con éxito: avisa al llamador (chat) y cierra la hoja para
    /// regresar a la conversación.
    private func finish() {
        onDone()
        dismiss()
    }
}
