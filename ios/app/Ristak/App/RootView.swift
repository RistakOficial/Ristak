import SwiftUI

/// Raíz de la app: conmuta splash (arranque) / login / shell según
/// `SessionStore.phase`, re-verifica sesión al volver a foreground, carga la
/// configuración de la cuenta al abrir sesión y aplica el tema preferido.
struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            switch session.phase {
            case .booting:
                RistakBootSplashView()
                    .transition(.opacity)

            case .loggedOut:
                LoginView()
                    .transition(.opacity)

            case .active:
                MainShell()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.28), value: session.phase)
        .preferredColorScheme(appConfig.preferredColorScheme)
        .task {
            await session.bootstrap()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            Task { await session.verifyOnForeground() }
        }
        .onChange(of: session.phase) { oldPhase, newPhase in
            switch newPhase {
            case .active:
                Task {
                    await appConfig.load()
                    // Re-registro silencioso del token APNs si el permiso ya
                    // fue concedido (la activación explícita vive en Ajustes).
                    await PushRegistrar.shared.registerAfterLoginIfPossible(
                        calendarIDs: appConfig.calendarPushCalendarIDs
                    )
                }
            case .loggedOut where oldPhase == .active:
                appConfig.reset()
            default:
                break
            }
        }
        .alert(
            "Licencia suspendida",
            isPresented: licenseAlertBinding
        ) {
            Button("Entendido", role: .cancel) {
                session.clearLicenseBlockedAlert()
            }
        } message: {
            Text(session.licenseBlockedAlertMessage ?? "")
        }
    }

    /// Alerta única de licencia bloqueada (doc research/13 §6.2).
    private var licenseAlertBinding: Binding<Bool> {
        Binding(
            get: { session.licenseBlockedAlertMessage != nil },
            set: { isPresented in
                if !isPresented {
                    session.clearLicenseBlockedAlert()
                }
            }
        )
    }
}

// MARK: - Splash de arranque

/// Splash mostrado mientras se lee el Keychain (fase `.booting`): wordmark +
/// indicador de carga (paridad BootScreen RN).
private struct RistakBootSplashView: View {
    var body: some View {
        VStack(spacing: RistakTheme.Spacing.xl) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("Ristak")
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(RistakTheme.textPrimary)

                Circle()
                    .fill(RistakTheme.accent)
                    .frame(width: 10, height: 10)
                    .alignmentGuide(.firstTextBaseline) { dimensions in
                        dimensions[.bottom]
                    }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Ristak")

            ProgressView()
                .controlSize(.regular)
                .accessibilityLabel("Cargando")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RistakTheme.bg)
    }
}
