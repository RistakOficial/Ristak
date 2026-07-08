import SwiftUI
import UIKit

/// Variantes del panel «link listo» (doc 08 §6.3.3-6.3.4 y §6.4).
enum PaymentLinkKind: Sendable, Equatable {
    /// Link de pago único.
    case payment
    /// Link de domiciliación de un plan (`cardSetupLink`).
    case cardSetup
    /// Primer pago de un plan (`firstPaymentLink`).
    case firstPayment
    /// Autorización de suscripción.
    case subscription

    var title: String {
        switch self {
        case .payment: return "Enlace de pago listo"
        case .cardSetup: return "Enlace de domiciliación listo"
        case .firstPayment: return "Primer pago listo"
        case .subscription: return "Suscripción lista"
        }
    }

    var subtitle: String {
        switch self {
        case .payment:
            return "Comparte este enlace con el cliente para completar el pago."
        case .cardSetup:
            return "Comparte este enlace para que el cliente domicilie su tarjeta. El plan se activa cuando pague y guarde la tarjeta."
        case .firstPayment:
            return "Comparte este enlace para cobrar el primer pago. Al pagarlo se guarda la tarjeta y se activan los siguientes cobros programados."
        case .subscription:
            return "Envíale el link al cliente para que active la suscripción."
        }
    }
}

/// Datos del link creado.
struct PaymentLinkReadyPayload: Identifiable, Sendable, Equatable {
    let id = UUID()
    let kind: PaymentLinkKind
    let url: String
    let gatewayName: String?
    let contactName: String?
    /// Monto ya formateado (con la moneda de la cuenta).
    let amountLabel: String?
    /// Contacto destino para saltar al chat con el link listo para enviar.
    var contactID: String?
    var contactPhone: String?
}

/// Sheet «link listo»: acción principal «Enviar por WhatsApp» (abre el chat del
/// contacto con el mensaje listo para pegar y enviar) + Copiar (portapapeles +
/// haptic) + Compartir (`ShareLink`) + Abrir (Safari). Los links SIEMPRE se
/// mandan manualmente (regla doc 08 §7.12: nunca auto-enviar).
struct PaymentLinkReadySheet: View {
    let payload: PaymentLinkReadyPayload

    @State private var copied = false
    @Environment(\.dismiss) private var dismiss
    @Environment(ShellState.self) private var shell

    /// Puede saltar al chat del contacto (hay `contactID`).
    private var canOpenChat: Bool {
        (payload.contactID?.isEmpty == false)
    }

    private var shareText: String {
        let name = (payload.contactName?.isEmpty == false) ? payload.contactName! : "cliente"
        if let amount = payload.amountLabel, !amount.isEmpty {
            return "Hola \(name), te comparto tu enlace de pago por \(amount):\n\(payload.url)"
        }
        return "Hola \(name), te comparto tu enlace de pago:\n\(payload.url)"
    }

    /// Deja el mensaje en el portapapeles y abre el chat del contacto. Como
    /// `ShellState` aún no tiene un campo de borrador prellenado, el fallback es
    /// copiar el texto para que el usuario solo lo pegue y envíe (ver notas).
    private func sendByWhatsApp() {
        UIPasteboard.general.string = shareText
        copied.toggle()
        if let contactID = payload.contactID, !contactID.isEmpty {
            shell.openChat(contactID: contactID)
        }
        dismiss()
    }

    var body: some View {
        SheetScaffold(title: payload.kind.title) {
            ScrollView {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                    Text(payload.kind.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)

                    if payload.kind == .subscription {
                        HStack(alignment: .top, spacing: RistakTheme.Spacing.sm) {
                            Image(systemName: "clock.badge.checkmark")
                                .font(.body)
                                .foregroundStyle(RistakTheme.warn)

                            VStack(alignment: .leading, spacing: 2) {
                                Text("Autorización pendiente")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(RistakTheme.textPrimary)
                                Text("Cuando el cliente complete el enlace, la suscripción quedará activa.")
                                    .font(.caption)
                                    .foregroundStyle(RistakTheme.textDim)
                            }
                        }
                        .padding(RistakTheme.Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                                .fill(RistakTheme.warnSoft)
                        )
                    }

                    summary

                    linkBox

                    if canOpenChat {
                        Button {
                            sendByWhatsApp()
                        } label: {
                            Label("Enviar por WhatsApp", systemImage: "paperplane.fill")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)

                        Text("Se copia el mensaje y se abre el chat del contacto para que solo lo pegues y lo envíes.")
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textMute)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }

                    actions

                    // Con CTA de WhatsApp arriba, «Listo» queda secundario; sin
                    // ella es la acción principal.
                    if canOpenChat {
                        Button { dismiss() } label: {
                            Text("Listo")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    } else {
                        Button { dismiss() } label: {
                            Text("Listo")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                }
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.bottom, RistakTheme.Spacing.xl)
            }
        }
        .sensoryFeedback(.success, trigger: copied)
    }

    @ViewBuilder
    private var summary: some View {
        VStack(spacing: RistakTheme.Spacing.xs) {
            if let contact = payload.contactName, !contact.isEmpty {
                summaryRow(label: "Cliente", value: contact)
            }
            if let amount = payload.amountLabel, !amount.isEmpty {
                summaryRow(label: "Monto", value: amount)
            }
            if let gateway = payload.gatewayName, !gateway.isEmpty {
                summaryRow(label: "Pasarela", value: gateway)
            }
        }
    }

    private func summaryRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(RistakTheme.textPrimary)
                .multilineTextAlignment(.trailing)
        }
    }

    private var linkBox: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
            Text("Enlace público de pago")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(RistakTheme.textDim)
                .textCase(.uppercase)

            Text(payload.url)
                .font(.footnote.monospaced())
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(RistakTheme.Spacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.controlBackground)
                )
                .textSelection(.enabled)
        }
    }

    private var actions: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Button {
                UIPasteboard.general.string = payload.url
                copied.toggle()
            } label: {
                Label("Copiar", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            ShareLink(item: shareText) {
                Label("Compartir", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            if let url = URL(string: payload.url) {
                Link(destination: url) {
                    Label("Abrir", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
    }
}
