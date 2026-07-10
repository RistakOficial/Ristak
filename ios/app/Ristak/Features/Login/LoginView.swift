import SwiftUI

/// Pantalla de login (doc research/02 §10 con acentos corregidos):
/// correo + contraseña, resolución automática de tenant vía
/// `SessionStore.login` y errores inline en español. En iPad la tarjeta se
/// centra a ~420 pt.
struct LoginView: View {
    @Environment(SessionStore.self) private var session

    @State private var viewModel = LoginViewModel()
    @FocusState private var focusedField: LoginField?

    private enum LoginField: Hashable {
        case email
        case password
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: RistakTheme.Spacing.xxl) {
                    brandHeader
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
        .accessibilityIdentifier("ristak-login-screen")
    }

    // MARK: - Marca

    private var brandHeader: some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            ZStack {
                Circle()
                    .fill(RistakTheme.accentSoft)
                    .frame(width: 100, height: 100)

                Image("LoginLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 72, height: 72)
            }
            .overlay {
                Circle()
                    .stroke(RistakTheme.accent.opacity(0.18), lineWidth: 1)
            }
            .shadow(color: RistakTheme.accent.opacity(0.18), radius: 18, y: 8)
            .accessibilityHidden(true)

            Text("Ristak")
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .foregroundStyle(RistakTheme.textPrimary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ristak")
    }

    private var heading: some View {
        VStack(spacing: RistakTheme.Spacing.xxs) {
            Text("Iniciar sesión")
                .font(.title2.bold())
                .foregroundStyle(RistakTheme.textPrimary)

            Text("Ristak detecta tu cuenta automáticamente con tu correo.")
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
                .accessibilityIdentifier("ristak-login-email")

            SecureField("Contraseña", text: $viewModel.password)
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focusedField, equals: .password)
                .onSubmit { submit() }
                .loginFieldStyle()
                .accessibilityIdentifier("ristak-login-password")
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
        .accessibilityIdentifier("ristak-login-submit")
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
