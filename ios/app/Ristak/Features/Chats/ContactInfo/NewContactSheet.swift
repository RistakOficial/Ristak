import SwiftUI
import UIKit

/// Contrato cross-agente: el contacto recién creado se entrega con la forma
/// "tipo lista" del backend (`POST /contacts` → 201 `data: <contacto tipo
/// lista>`, doc 06 §2.1), que es exactamente `ChatContact`.
typealias ContactRecord = ChatContact

/// Formulario reutilizable de creación de contacto (doc 06 §4.1 "Nuevo chat" /
/// ContactSearchInput de escritorio): Nombre* / Apellido / Correo electrónico /
/// Teléfono. Lo usan los flujos "Nuevo chat" y "Nueva cita".
///
/// Validaciones (copy exacto):
/// - "El nombre es requerido"
/// - "Debes ingresar al menos un correo o teléfono"
/// - "Correo inválido"
/// Duplicados: el 409 del backend ya llega con mensaje en español listo para
/// mostrar (doc 06 §6.15).
struct NewContactSheet: View {
    /// `source` del contacto (p. ej. `mobile_native_appointment_guest` para
    /// invitados de cita). `nil` = default del backend (`ristak_manual`).
    var source: String? = nil
    let onCreated: (ContactRecord) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var firstName = ""
    @State private var lastName = ""
    @State private var email = ""
    @State private var phone = ""

    @State private var isCreating = false
    @State private var errorMessage: String?
    @State private var successPulse = 0

    @FocusState private var focusedField: Field?

    private enum Field {
        case firstName, lastName, email, phone
    }

    private let contacts = ContactsService()

    init(source: String? = nil, onCreated: @escaping (ContactRecord) -> Void) {
        self.source = source
        self.onCreated = onCreated
    }

    var body: some View {
        SheetScaffold(title: "Crear contacto") {
            ScrollView {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.md) {
                    field(
                        label: "Nombre",
                        placeholder: "Nombre",
                        text: $firstName,
                        focus: .firstName,
                        capitalization: .words
                    )

                    field(
                        label: "Apellido",
                        placeholder: "Apellido",
                        text: $lastName,
                        focus: .lastName,
                        capitalization: .words
                    )

                    field(
                        label: "Correo electrónico",
                        placeholder: "correo@ejemplo.com",
                        text: $email,
                        focus: .email,
                        keyboard: .emailAddress
                    )

                    field(
                        label: "Teléfono",
                        placeholder: "+52...",
                        text: $phone,
                        focus: .phone,
                        keyboard: .phonePad
                    )

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.neg)
                    }

                    Button {
                        Task { await create() }
                    } label: {
                        Text(isCreating ? "Creando..." : "Crear contacto")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(isCreating)
                }
                .padding(.horizontal, RistakTheme.Spacing.lg)
                .padding(.bottom, RistakTheme.Spacing.lg)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .sensoryFeedback(.success, trigger: successPulse)
        .onAppear {
            focusedField = .firstName
        }
    }

    private func field(
        label: String,
        placeholder: String,
        text: Binding<String>,
        focus: Field,
        keyboard: UIKeyboardType = .default,
        capitalization: TextInputAutocapitalization = .never
    ) -> some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
            Text(label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)

            TextField(placeholder, text: text)
                .font(.body)
                .keyboardType(keyboard)
                .textInputAutocapitalization(capitalization)
                .autocorrectionDisabled()
                .focused($focusedField, equals: focus)
                .padding(RistakTheme.Spacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.controlBackground)
                )
        }
    }

    // MARK: - Crear

    private func create() async {
        errorMessage = nil

        let name = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let surname = lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let cleanPhone = phone.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !name.isEmpty else {
            errorMessage = "El nombre es requerido"
            return
        }
        guard !cleanEmail.isEmpty || !cleanPhone.isEmpty else {
            errorMessage = "Debes ingresar al menos un correo o teléfono"
            return
        }
        if !cleanEmail.isEmpty, !ContactInfoViewModel.isValidEmail(cleanEmail) {
            errorMessage = "Correo inválido"
            return
        }

        isCreating = true
        defer { isCreating = false }

        do {
            let request = ContactCreateRequest(
                firstName: name,
                lastName: surname.isEmpty ? nil : surname,
                email: cleanEmail.isEmpty ? nil : cleanEmail,
                phone: cleanPhone.isEmpty ? nil : cleanPhone,
                source: source
            )
            let created = try await contacts.createContact(request)
            successPulse += 1
            onCreated(created)
            dismiss()
        } catch let apiError as RistakAPIError {
            // 409 duplicado: mensaje del backend ya en español (doc 06 §2.1).
            errorMessage = apiError.message
        } catch {
            errorMessage = "No se creó el contacto"
        }
    }
}
