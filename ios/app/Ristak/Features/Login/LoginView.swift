import SwiftUI

/// Pantalla de login (doc research/02 §10 con acentos corregidos):
/// correo + contraseña, resolución automática de tenant vía
/// `SessionStore.login`, errores inline en español y campo avanzado
/// "Servidor" para desarrollo. En iPad la tarjeta se centra a ~420 pt.
struct LoginView: View {
    @Environment(SessionStore.self) private var session

    @State private var viewModel = LoginViewModel()
    @FocusState private var focusedField: LoginField?

    private enum LoginField: Hashable {
        case email
        case password
        case server
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: RistakTheme.Spacing.xxl) {
                    wordmark
                        .padding(.top, RistakTheme.Spacing.xxl)

                    heading

                    fields

                    if let errorMessage = viewModel.errorMessage {
                        Text(errorMessage)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(RistakTheme.neg)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .transition(.opacity)
                    }

                    submitButton

                    advancedOptions
                }
                .frame(maxWidth: 420)
                .padding(.horizontal, RistakTheme.Spacing.xl)
                .padding(.bottom, RistakTheme.Spacing.xxl)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height * 0.9)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(RistakTheme.bg)
        .animation(.easeInOut(duration: 0.2), value: viewModel.errorMessage)
    }

    // MARK: - Marca

    /// Wordmark "Ristak" tipográfico + punto de acento (sin fuentes embebidas:
    /// la identidad va por color/forma).
    private var wordmark: some View {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text("Ristak")
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .foregroundStyle(RistakTheme.textPrimary)

            Circle()
                .fill(RistakTheme.accent)
                .frame(width: 9, height: 9)
                .alignmentGuide(.firstTextBaseline) { dimensions in
                    dimensions[.bottom]
                }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ristak")
    }

    private var heading: some View {
        VStack(spacing: RistakTheme.Spacing.xxs) {
            Text("Iniciar sesión")
                .font(.title2.bold())
                .foregroundStyle(RistakTheme.textPrimary)

            Text("Entra con el correo y la contraseña de tu cuenta.")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - Campos

    private var fields: some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            TextField("correo@negocio.com", text: $viewModel.email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .focused($focusedField, equals: .email)
                .onSubmit { focusedField = .password }
                .loginFieldStyle()

            SecureField("Contraseña", text: $viewModel.password)
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focusedField, equals: .password)
                .onSubmit { submit() }
                .loginFieldStyle()
        }
    }

    private var submitButton: some View {
        Button(action: submit) {
            ZStack {
                Text("Iniciar sesión")
                    .font(.headline)
                    .opacity(viewModel.isBusy ? 0 : 1)

                if viewModel.isBusy {
                    ProgressView()
                        .tint(RistakTheme.onAccent)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(!viewModel.canSubmit)
    }

    // MARK: - Opciones avanzadas

    private var advancedOptions: some View {
        DisclosureGroup("Opciones avanzadas", isExpanded: $viewModel.showAdvancedOptions) {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                TextField("Servidor (http://127.0.0.1:3001)", text: $viewModel.serverOverride)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .server)
                    .loginFieldStyle()

                Text("Conéctate directo a un servidor específico. Déjalo vacío para entrar con tu correo.")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textMute)
            }
            .padding(.top, RistakTheme.Spacing.xs)
        }
        .font(.subheadline.weight(.medium))
        .tint(RistakTheme.textDim)
    }

    // MARK: - Acciones

    private func submit() {
        guard viewModel.canSubmit else { return }
        focusedField = nil
        Task {
            await viewModel.submit(using: session)
        }
    }
}

// MARK: - Estilo de campo

private struct LoginFieldModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.body)
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(RistakTheme.controlBackground)
            )
    }
}

private extension View {
    func loginFieldStyle() -> some View {
        modifier(LoginFieldModifier())
    }
}
