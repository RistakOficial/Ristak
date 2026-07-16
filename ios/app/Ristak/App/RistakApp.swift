import SwiftUI

/// Punto de entrada. Crea los stores raíz una sola vez y los inyecta por
/// Environment (Observation): sesión, config de cuenta/usuario, permisos y
/// estado del shell.
@main
struct RistakApp: App {
    @UIApplicationDelegateAdaptor(RistakAppDelegate.self) private var appDelegate

    @State private var session: SessionStore
    @State private var appConfig: AppConfigStore
    @State private var access: AccessStore
    @State private var shellState: ShellState

    init() {
        RistakObservability.bootstrap()

        let session = SessionStore()
        session.pushUnregisterHandler = {
            await PushRegistrar.shared.unregisterForLogout()
        }
        session.pushLocalResetHandler = {
            PushRegistrar.shared.clearLocalRegistration()
        }
        _session = State(initialValue: session)
        _appConfig = State(initialValue: AppConfigStore())
        _access = State(initialValue: AccessStore(session: session))
        _shellState = State(initialValue: ShellState())
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if let testConfiguration = RistakUITestConfiguration.current {
                    if testConfiguration.showsActivityMarkers {
                        RistakActivityMarkersUITestHarnessView()
                            .reportsRistakUIReady()
                    } else if testConfiguration.showsPersonalAssistantChat {
                        RistakPersonalAssistantChatUITestHarnessView()
                            .reportsRistakUIReady()
                    } else if testConfiguration.showsRealInboxPresentation {
                        RistakInboxPresentationUITestHarnessView()
                            .reportsRistakUIReady()
                    } else {
                        RistakUITestHarnessView(configuration: testConfiguration)
                            .reportsRistakUIReady()
                    }
                } else {
                    RootView()
                }
                #else
                RootView()
                #endif
            }
                .environment(session)
                .environment(appConfig)
                .environment(access)
                .environment(shellState)
                .environment(NotificationRouter.shared)
        }
    }
}
