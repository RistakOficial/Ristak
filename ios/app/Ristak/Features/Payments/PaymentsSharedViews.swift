import SwiftUI

// MARK: - Teclado de los formularios de Pagos (#13)

extension View {
    /// Garantiza que el teclado de un formulario de Pagos siempre se pueda
    /// cerrar: arrastrar hacia abajo para ocultarlo + botón «Listo» sobre el
    /// teclado. Indispensable porque los teclados numéricos
    /// (`decimalPad`/`numberPad`) no traen tecla de retorno y, sin esto, quedan
    /// atrapados al capturar montos o cantidades al crear un cobro.
    func paymentsKeyboardDismissable() -> some View {
        modifier(PaymentsKeyboardDismissable())
    }
}

private struct PaymentsKeyboardDismissable: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Listo") {
                        KeyboardDismisser.dismiss()
                    }
                    .font(.body.weight(.semibold))
                }
            }
    }
}

// MARK: - Tarjeta de elección del home (doc 08 §6.1)

struct PaymentChoiceCard: View {
    let icon: String
    let title: String
    let subtitle: String
    var iconTint: Color = RistakTheme.accent
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: RistakTheme.Spacing.md) {
                Image(systemName: icon)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(iconTint)
                    .frame(width: 44, height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                            .fill(iconTint.opacity(0.14))
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(RistakTheme.textPrimary)

                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(RistakTheme.textMute)
            }
            .padding(RistakTheme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                    .fill(RistakTheme.surface)
            )
            .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Badge de estado de pago

struct PaymentStatusBadge: View {
    let status: PaymentTransactionStatus?

    private var label: String {
        status?.displayLabel ?? "—"
    }

    private var tint: Color {
        switch status {
        case .paid, .partial: return RistakTheme.pos
        case .refunded, .failed, .void, .deleted, .overdue: return RistakTheme.neg
        case .pending, .sent, .scheduled, .draft: return RistakTheme.warn
        case nil: return RistakTheme.info
        }
    }

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.14)))
    }
}

// MARK: - Fila de pago reciente (doc 08 §6.1)

struct PaymentTransactionRow: View {
    let transaction: PaymentTransaction
    let formatters: BusinessFormatters
    let timeZone: TimeZone

    var body: some View {
        HStack(alignment: .center, spacing: RistakTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 3) {
                Text(formatters.currency(transaction.amount, currencyOverride: transaction.currency.isEmpty ? nil : transaction.currency))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textPrimary)

                Text(transaction.contactDisplayLabel)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)

                Text("\(PaymentMethodDisplay.label(for: transaction.method)) · \(transaction.transactionStatus?.displayLabel ?? transaction.status)")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            VStack(alignment: .trailing, spacing: 4) {
                Text(PaymentsDateMath.paymentDateLabel(iso: transaction.date ?? transaction.createdAt, timeZone: timeZone))
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)

                PaymentStatusBadge(status: transaction.transactionStatus)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

// MARK: - Fila resumen del contacto elegido

struct PaymentContactSummaryRow: View {
    let contact: PickedPaymentContact
    /// Acción de cambiar/quitar (oculta si el contacto está bloqueado).
    var onClear: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            ContactAvatarView(name: contact.displayName, photoURL: contact.photoURL, size: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(contact.displayName)
                    .font(.body.weight(.medium))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)

                if !contact.secondaryLabel.isEmpty {
                    Text(contact.secondaryLabel)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            if contact.isLocked {
                Image(systemName: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
                    .accessibilityLabel("Contacto fijo")
            } else if let onClear {
                Button {
                    onClear()
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

// MARK: - Sin acceso (403 read_access_required)

struct PaymentsNoAccessView: View {
    var message: String = "No tienes acceso a esta sección."

    var body: some View {
        RistakEmptyState(
            icon: "lock.fill",
            title: "Sin acceso",
            message: message
        )
    }
}

// MARK: - Guard de moneda de cuenta (regla dura doc 01 §10 / doc 14 §11.9)

/// Bloquea la creación de registros de dinero cuando `account_currency` no se
/// pudo leer: mejor no crear el cobro que etiquetarlo con la moneda equivocada.
struct PaymentsCurrencyGuardView: View {
    var retry: () -> Void

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.md) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(RistakTheme.warn)
                .frame(width: 76, height: 76)
                .background(Circle().fill(RistakTheme.warnSoft))

            VStack(spacing: RistakTheme.Spacing.xxs) {
                Text("Falta la moneda de la cuenta")
                    .font(.title3.bold())
                    .foregroundStyle(RistakTheme.textPrimary)

                Text("No se pudo leer la moneda configurada del negocio. Para evitar registrar cobros con la moneda equivocada, vuelve a intentar cuando haya conexión.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .multilineTextAlignment(.center)
            }

            Button("Reintentar", action: retry)
                .buttonStyle(.borderedProminent)
        }
        .padding(RistakTheme.Spacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Fila de opción seleccionable (radio de wizard)

/// Fila de elección de método/pasarela. Selección = relleno sólido de acento +
/// texto blanco (regla de selección de ARCHITECTURE.md, sin glass).
struct PaymentOptionRow: View {
    let title: String
    var subtitle: String? = nil
    var isSelected: Bool = false
    var isDisabled: Bool = false
    var disabledReason: String? = nil
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textPrimary)

                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(isSelected ? RistakTheme.onAccent.opacity(0.85) : RistakTheme.textDim)
                        .multilineTextAlignment(.leading)
                }

                if isDisabled, let disabledReason, !disabledReason.isEmpty {
                    Text(disabledReason)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.warn)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(RistakTheme.Spacing.sm)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(isSelected ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
            )
            .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.55 : 1)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
