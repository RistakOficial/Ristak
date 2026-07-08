import SwiftUI

/// Panel "Pagos totales" (doc 06 §4.1 paneles secundarios): fila "Total pagado"
/// + lista de pagos embebidos del contacto; tocar un pago abre su detalle
/// (Monto / Fecha / Estado / Concepto). Solo lectura — el registro de pagos
/// vive en el módulo Pagos.
struct ContactPaymentsPanel: View {
    let contactName: String
    let payments: [ContactEmbeddedPayment]
    /// LTV del contacto (suma de pagos exitosos no-test, doc 06 §1.1).
    let totalPaid: Double
    let formatters: BusinessFormatters

    @State private var selectedPayment: ContactEmbeddedPayment?

    var body: some View {
        SheetScaffold(title: "Pagos totales", subtitle: contactName) {
            if payments.isEmpty {
                RistakEmptyState(
                    icon: "banknote",
                    title: "Sin pagos",
                    message: "Aún no hay pagos registrados para este contacto."
                )
            } else {
                ScrollView {
                    VStack(spacing: RistakTheme.Spacing.md) {
                        totalRow

                        VStack(spacing: 0) {
                            ForEach(payments) { payment in
                                paymentRow(payment)
                                if payment.id != payments.last?.id {
                                    Divider()
                                        .overlay(RistakTheme.border.opacity(0.5))
                                }
                            }
                        }
                        .padding(.horizontal, RistakTheme.Spacing.md)
                        .background(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                                .fill(RistakTheme.surface)
                        )
                    }
                    .padding(.horizontal, RistakTheme.Spacing.lg)
                    .padding(.bottom, RistakTheme.Spacing.lg)
                }
            }
        }
        .sheet(item: $selectedPayment) { payment in
            ContactPaymentDetailSheet(payment: payment, formatters: formatters)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    private var totalRow: some View {
        HStack {
            Text("Total pagado")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)

            Spacer()

            Text(formatters.currency(totalPaid))
                .font(.title3.bold())
                .monospacedDigit()
                .foregroundStyle(RistakTheme.pos)
        }
        .padding(RistakTheme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                .fill(RistakTheme.surface)
        )
    }

    private func paymentRow(_ payment: ContactEmbeddedPayment) -> some View {
        Button {
            selectedPayment = payment
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: RistakTheme.Spacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(formatters.currency(payment.amount, currencyOverride: payment.currency))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(RistakTheme.textPrimary)

                    Text(ContactInfoDates.dateTime(fromISO: payment.paymentDate ?? payment.createdAt, timeZone: formatters.timeZone))
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer()

                Text(ContactInfoPaymentStatus.label(payment.status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ContactInfoPaymentStatus.color(payment.status))

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(RistakTheme.textMute)
            }
            .padding(.vertical, RistakTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ver detalle de pago")
    }
}

/// Detalle de pago embebido: Monto / Fecha / Estado / Concepto.
private struct ContactPaymentDetailSheet: View {
    let payment: ContactEmbeddedPayment
    let formatters: BusinessFormatters

    var body: some View {
        SheetScaffold(title: "Detalle de pago") {
            ScrollView {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    ContactInfoRow(
                        label: "Monto",
                        value: formatters.currency(payment.amount, currencyOverride: payment.currency)
                    )
                    ContactInfoRow(
                        label: "Fecha",
                        value: ContactInfoDates.dateTime(fromISO: payment.paymentDate ?? payment.createdAt, timeZone: formatters.timeZone)
                    )

                    HStack(spacing: RistakTheme.Spacing.sm) {
                        Text("Estado")
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textDim)
                            .frame(width: 112, alignment: .leading)

                        Text(ContactInfoPaymentStatus.label(payment.status))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(ContactInfoPaymentStatus.color(payment.status))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(RistakTheme.controlRest))
                    }

                    ContactInfoRow(label: "Concepto", value: concept)
                }
                .padding(RistakTheme.Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                        .fill(RistakTheme.surface)
                )
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.bottom, RistakTheme.Spacing.lg)
            }
        }
    }

    private var concept: String {
        let candidates = [payment.title, payment.concept, payment.description]
        for candidate in candidates {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return "Pago"
    }
}
