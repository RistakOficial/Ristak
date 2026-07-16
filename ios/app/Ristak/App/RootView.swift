import SwiftUI

/// Raíz de la app: conmuta splash (arranque) / login / shell según
/// `SessionStore.phase`, re-verifica sesión al volver a foreground, carga la
/// configuración de la cuenta al abrir sesión y aplica el tema preferido.
struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(ShellState.self) private var shell
    @Environment(NotificationRouter.self) private var notificationRouter
    @Environment(\.scenePhase) private var scenePhase

    /// True solo si la app estuvo en background REAL (no una interrupción
    /// transitoria). Distingue "el usuario salió y volvió" de "bajó el Centro de
    /// Control / la cortina de notificaciones / apareció un diálogo del sistema"
    /// —esas solo llevan la escena a `.inactive`, nunca a `.background`—.
    @State private var wasBackgrounded = false
    /// Version observada al entrar a background. Aunque MainShell consuma el
    /// deep link antes del retorno, el cambio de version evita resetear a Chats.
    @State private var deepLinkVersionAtBackground = 0

    var body: some View {
        ZStack {
            switch session.phase {
            case .booting:
                RistakBootSplashView()
                    .transition(.opacity)
                    .accessibilityIdentifier("ristak-boot-splash")

            case .loggedOut:
                LoginView()
                    .transition(.opacity)
                    .accessibilityIdentifier("ristak-login-root")
                    .reportsRistakUIReady()

            case .active:
                MainShell()
                    .transition(.opacity)
                    .accessibilityIdentifier("ristak-main-root")
                    .reportsRistakUIReady()
            }
        }
        .animation(.easeInOut(duration: 0.28), value: session.phase)
        .preferredColorScheme(appConfig.preferredColorScheme)
        .task {
            await session.bootstrap()
        }
        .onChange(of: scenePhase) { _, newPhase in
            // Marca el background real y no hagas nada más hasta volver a `.active`.
            if newPhase == .background {
                wasBackgrounded = true
                deepLinkVersionAtBackground = notificationRouter.deepLinkVersion
                return
            }
            guard newPhase == .active else { return }
            let returningFromBackground = wasBackgrounded
            let expectedGeneration = session.sessionGeneration
            // «Volver a Chats hasta arriba» SOLO tras un regreso desde background
            // real. Antes se disparaba en cada `.inactive → .active` (Centro de
            // Control, notificaciones, app-switcher, diálogos), lo que aventaba la
            // bandeja al tope sola —el scroll fantasma reportado—.
            if returningFromBackground, case .active = session.phase {
                // Un tap de push tiene prioridad. Sin este gate, el reset podia
                // ganarle por carrera al deep link de cita/pago/chat y mandar al
                // usuario a Chats aunque hubiera tocado otro destino.
                let receivedDeepLinkWhileAway = notificationRouter.deepLinkVersion
                    != deepLinkVersionAtBackground
                if !receivedDeepLinkWhileAway, notificationRouter.pendingDeepLink == nil {
                    shell.resetToChatsTop()
                }
            }
            Task {
                await session.verifyOnForeground()
                guard session.isCurrentActiveSession(expectedGeneration) else { return }
                PushRegistrar.shared.beginSession(generation: expectedGeneration)
                if returningFromBackground {
                    await PushRegistrar.shared.reconcileOnForeground(
                        calendarIDs: appConfig.calendarPushEnabled
                            ? appConfig.calendarPushCalendarIDs
                            : []
                    )
                }
            }
            wasBackgrounded = false
        }
        .onChange(of: session.phase) { oldPhase, newPhase in
            switch newPhase {
            case .active:
                let expectedGeneration = session.sessionGeneration
                PushRegistrar.shared.beginSession(generation: expectedGeneration)
                // Pinta tema/moneda/config con el último estado conocido de la
                // caché SWR (ya precargada en memoria durante el bootstrap)
                // ANTES de disparar el load de red, evitando el flash inicial.
                appConfig.hydrateFromCache()
                let cachedCalendarIDs = appConfig.calendarPushEnabled
                    ? appConfig.calendarPushCalendarIDs
                    : []
                Task {
                    // Push y AppConfig arrancan juntos. Antes, tres GET de config
                    // podían retrasar hasta 15 s el enlace APNs -> backend.
                    async let configLoad: Void = appConfig.load()
                    async let cachedPushRegistration: Void = PushRegistrar.shared
                        .registerAfterLoginIfPossible(calendarIDs: cachedCalendarIDs)

                    await configLoad
                    // Esperar la activación cacheada evita que dos registros con
                    // filtros distintos se fusionen dentro del mismo activationTask.
                    await cachedPushRegistration
                    guard session.isCurrentActiveSession(expectedGeneration) else { return }

                    // Si la revalidación cambió el filtro de calendarios, registrar
                    // una segunda vez con el valor autoritativo. Apagado = []
                    // (= todos), para no perder pushes de otros tipos.
                    let refreshedCalendarIDs = appConfig.calendarPushEnabled
                        ? appConfig.calendarPushCalendarIDs
                        : []
                    if refreshedCalendarIDs != cachedCalendarIDs {
                        await PushRegistrar.shared.registerAfterLoginIfPossible(
                            calendarIDs: refreshedCalendarIDs
                        )
                    }
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
        Image("LoginLogo")
            .resizable()
            .scaledToFit()
            .frame(width: 128, height: 128)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Ristak")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RistakTheme.bg)
    }
}
