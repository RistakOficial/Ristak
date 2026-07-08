import SwiftUI
import UIKit
import Observation

/// Detalle de una transacción (`GET /api/transactions/:id`). Solo lectura +
/// acciones de link (copiar/compartir/abrir): /movil no expone refund/void en
/// móvil (doc 08 gap 2), así que las operaciones de estado viven en escritorio.
@MainActor
@Observable
final class PaymentDetailModel {
    let transactionID: String
    /// Fila de la lista para pintar al instante mientras carga el detalle.
    private(set) var transaction: PaymentTransaction?
    private(set) var isLoading = false
    private(set) var error: RistakAPIError?
    private(set) var resolvedLink: String?

    init(transactionID: String, preview: PaymentTransaction? = nil) {
        self.transactionID = transactionID
        self.transaction = preview
    }

    func load() async {
        isLoading = transaction == nil
        error = nil
        defer { isLoading = false }
        do {
            let detail = try await PaymentsService.transaction(id: transactionID)
            transaction = detail
            if let url = detail.paymentUrl, !url.isEmpty {
                resolvedLink = url
            } else if detail.publicPaymentId != nil || detail.invoiceId != nil {
                // `GET /:id/payment-link` — 400 si no tiene enlace (silencioso).
                resolvedLink = try? await PaymentsService.paymentLink(id: transactionID)
            }
        } catch let apiError as RistakAPIError {
            if transaction == nil { error = apiError }
        } catch {
            if transaction == nil {
                self.error = RistakAPIError(kind: .server, status: 0, message: "No se pudo cargar el pago.", underlying: error)
            }
        }
    }
}

struct PaymentDetailView: View {
    @State private var model: PaymentDetailModel
    @Environment(AppConfigStore.self) private var appConfig

    @State private var copied = false

    init(transactionID: String, preview: PaymentTransaction? = nil) {
        _model = State(initialValue: PaymentDetailModel(transactionID: transactionID, preview: preview))
    }

    var body: some View {
        Group {
            if let transaction = model.transaction {
                detail(for: transaction)
            } else if model.isLoading {
                RistakLoadingView(message: "Cargando pago…")
            } else if let error = model.error {
                if error.isAccessDenied {
                    PaymentsNoAccessView(message: error.message)
                } else {
                    RistakErrorState(message: error.message) {
                        Task { await model.load() }
                    }
                }
            }
        }
        .navigationTitle("Detalle de pago")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.transactionID) {
            await model.load()
        }
        .sensoryFeedback(.success, trigger: copied)
    }

    private func detail(for transaction: PaymentTransaction) -> some View {
        let formatters = appConfig.formatters
        let timeZone = appConfig.businessTimeZone

        return List {
            Section {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    Text(formatters.currency(
                        transaction.amount,
                        currencyOverride: transaction.currency.isEmpty ? nil : transaction.currency
                    ))
                    .font(.largeTitle.bold())
                    .monospacedDigit()

                    HStack(spacing: RistakTheme.Spacing.xs) {
                        PaymentStatusBadge(status: transaction.transactionStatus)

                        if transaction.paymentMode == "test" {
                            Text("Prueba")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(RistakTheme.warn)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(RistakTheme.warnSoft))
                        }
                    }
                }
                .padding(.vertical, RistakTheme.Spacing.xxs)
                .listRowSeparator(.hidden)
            }

            Section("Cliente") {
                infoRow("Contacto", transaction.contactDisplayLabel)
                if !transaction.email.isEmpty { infoRow("Correo", transaction.email) }
                if !transaction.phone.isEmpty { infoRow("Teléfono", transaction.phone) }
                if let source = transaction.contactSource, !source.isEmpty {
                    infoRow("Origen", source)
                }
                if let adName = transaction.attributionAdName, !adName.isEmpty {
                    infoRow("Anuncio", adName)
                }
            }

            Section("Cobro") {
                infoRow("Concepto", transaction.title)
                if let description = transaction.description, !description.isEmpty {
                    infoRow("Descripción", description)
                }
                infoRow("Método", PaymentMethodDisplay.label(for: transaction.method))
                infoRow("Pasarela", providerLabel(transaction.paymentProvider))
                infoRow("Fecha", PaymentsDateMath.paymentDateLabel(iso: transaction.date ?? transaction.createdAt, timeZone: timeZone))
                if let paidAt = transaction.paidAt, !paidAt.isEmpty {
                    infoRow("Pagado el", PaymentsDateMath.paymentDateLabel(iso: paidAt, timeZone: timeZone))
                }
                if let dueDate = transaction.dueDate, !dueDate.isEmpty {
                    infoRow("Vence", PaymentsDateMath.paymentDateLabel(iso: dueDate, timeZone: timeZone))
                }
                if let reference = transaction.reference, !reference.isEmpty {
                    infoRow("Referencia", reference)
                }
                if let invoiceNumber = transaction.invoiceNumber, !invoiceNumber.isEmpty {
                    infoRow("Factura", invoiceNumber)
                }
            }

            if let link = model.resolvedLink, !link.isEmpty {
                Section("Enlace de pago") {
                    Text(link)
                        .font(.footnote.monospaced())
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(3)
                        .textSelection(.enabled)

                    Button {
                        UIPasteboard.general.string = link
                        copied.toggle()
                    } label: {
                        Label("Copiar enlace", systemImage: "doc.on.doc")
                    }

                    ShareLink(item: link) {
                        Label("Compartir enlace", systemImage: "square.and.arrow.up")
                    }

                    if let url = URL(string: link) {
                        Link(destination: url) {
                            Label("Abrir enlace", systemImage: "safari")
                        }
                    }
                }
            }

            Section {
                Text("Los reembolsos, anulaciones y cambios de estado se gestionan desde Ristak en escritorio.")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textMute)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await model.load()
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
            Spacer(minLength: RistakTheme.Spacing.sm)
            Text(value.isEmpty ? "—" : value)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)
                .multilineTextAlignment(.trailing)
        }
    }

    private func providerLabel(_ provider: String) -> String {
        switch provider.lowercased() {
        case "manual": return "Manual"
        case "highlevel": return "HighLevel"
        case "stripe": return "Stripe"
        case "conekta": return "Conekta"
        case "mercadopago": return "Mercado Pago"
        case "clip": return "CLIP"
        case "rebill": return "Rebill"
        case "gigstack": return "Gigstack"
        default: return provider.isEmpty ? "—" : provider
        }
    }
}
