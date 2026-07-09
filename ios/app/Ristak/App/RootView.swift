import SwiftUI

/// Raíz de la app: conmuta splash (arranque) / login / shell según
/// `SessionStore.phase`, re-verifica sesión al volver a foreground, carga la
/// configuración de la cuenta al abrir sesión y aplica el tema preferido.
struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(ShellState.self) private var shell
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
            // Cada vez que se abre/reactiva la app: volver a Chats hasta arriba.
            if case .active = session.phase {
                shell.resetToChatsTop()
            }
        }
        .onChange(of: session.phase) { oldPhase, newPhase in
            switch newPhase {
            case .active:
                // Pinta tema/moneda/config con el último estado conocido de la
                // caché SWR (ya precargada en memoria durante el bootstrap)
                // ANTES de disparar el load de red, evitando el flash inicial.
                appConfig.hydrateFromCache()
                Task {
                    await appConfig.load()
                    // Re-registro silencioso del token APNs si el permiso ya
                    // fue concedido (la activación explícita vive en Ajustes).
                    // El filtro de calendarios solo aplica cuando el toggle de
                    // citas está encendido; apagado = [] (= todos), para no
                    // reimponer una selección vieja y perder pushes de otros
                    // tipos (p. ej. citas confirmadas) — paridad RN.
                    await PushRegistrar.shared.registerAfterLoginIfPossible(
                        calendarIDs: appConfig.calendarPushEnabled
                            ? appConfig.calendarPushCalendarIDs
                            : []
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

/// Splash de arranque (fase `.booting`, breve: lectura de Keychain + precarga
/// de caché en memoria). Marca estática, SIN spinner: el usuario nunca ve un
/// indicador de "cargando" al abrir la app — entra al shell con contenido
/// cacheado de inmediato (arranque instantáneo estilo WhatsApp).
private struct RistakBootSplashView: View {
    var body: some View {
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RistakTheme.bg)
    }
}
