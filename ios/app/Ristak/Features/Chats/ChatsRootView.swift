import SwiftUI

/// Raíz del módulo Chats (doc research/03). Contenedor adaptativo:
/// - Compacto (iPhone): `NavigationStack` con la bandeja y push del hilo.
/// - Regular (iPad): `NavigationSplitView` — bandeja como sidebar (~380 pt) y
///   `ConversationScreen` en el detalle; `RistakEmptyState` sin selección.
/// Consume deep links de push (`NotificationRouter`) y saltos internos
/// (`ShellState.pendingChatContactID`).
struct ChatsRootView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(SessionStore.self) private var session
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access
    @Environment(ShellState.self) private var shell
    @Environment(NotificationRouter.self) private var router

    @State private var viewModel = InboxViewModel()
    /// Ruta del stack (iPhone).
    @State private var path: [ChatsRoute] = []
    /// Ruta del detalle (iPad).
    @State private var detailRoute: ChatsRoute?

    enum ChatsRoute: Hashable {
        case conversation(contactID: String)
        case assistant
    }

    var body: some View {
        // La cadena de modificadores se parte en dos propiedades para no reventar
        // el type-checker de Swift (SwiftUI infiere un tipo anidado por cada
        // `.onChange`; demasiados en una sola expresión lo tumban).
        realtimeWiredLayout
            .onChange(of: router.deepLinkVersion) {
                consumeChatDeepLink()
            }
            .onChange(of: shell.pendingChatContactID) { _, contactID in
                guard let contactID else { return }
                shell.pendingChatContactID = nil
                openConversation(contactID: contactID, resetStack: true)
            }
            .onChange(of: router.foregroundNudgeCount) {
                // Push en foreground = nudge: refresh inmediato de la bandeja.
                viewModel.requestSilentRefresh()
            }
    }

    /// `layout` + arranque + cableado de realtime (escena, cobertura por hilo,
    /// clase de tamaño). Ver nota en `body` sobre por qué se divide la cadena.
    private var realtimeWiredLayout: some View {
        bootstrappedLayout
            .onChange(of: path) { _, newPath in
                // Compacto (iPhone): un hilo abierto TAPA la bandeja → suspende su
                // realtime (evita SSE duplicado + re-bajar la bandeja detrás). En
                // iPad (regular) el sidebar sigue visible: nunca se suspende.
                guard horizontalSizeClass == .compact else { return }
                viewModel.setCoveredByThread(!newPath.isEmpty)
            }
            .onChange(of: horizontalSizeClass) { _, newClass in
                // Rotación/multitarea: al pasar a regular la bandeja vuelve a estar
                // visible, así que se destapa aunque el stack siga con un hilo.
                viewModel.setCoveredByThread(newClass == .compact && !path.isEmpty)
            }
    }

    /// SwiftUI genera un tipo nuevo por modificador. Mantener el arranque y el
    /// ciclo de vida en otro tramo evita que el type-checker se ahogue al sumar
    /// el callback de background al cableado que ya tenía esta raíz.
    private var bootstrappedLayout: some View {
        layout
            .task {
                await bootstrap()
            }
            .onChange(of: session.user?.id) {
                refreshIdentityNamespace()
            }
            .onChange(of: scenePhase) { _, phase in
                viewModel.setScenePaused(
                    phase != .active,
                    enteredBackground: phase == .background
                )
            }
    }

    /// Contenido raíz según acceso y clase de tamaño. Extraído del `body` para no
    /// reventar el type-checker de Swift al encadenarle todos los `.onChange`.
    @ViewBuilder
    private var layout: some View {
        if !access.canRead(module: .chat) {
            NavigationStack {
                RistakEmptyState(
                    icon: "lock",
                    title: "Sin acceso",
                    message: "No tienes acceso a esta sección."
                )
                .navigationTitle("Chats")
            }
        } else if horizontalSizeClass == .regular {
            splitLayout
        } else {
            stackLayout
        }
    }

    // MARK: - Arranque

    private func bootstrap() async {
        guard access.canRead(module: .chat) else { return }
        let namespace = ChatAccountNamespace.make(
            baseURL: session.baseURL,
            userID: session.user?.id
        )
        viewModel.configure(appConfig: appConfig, shell: shell, namespace: namespace)
        viewModel.startRealtime()

        consumeChatDeepLink()
        if let pending = shell.pendingChatContactID {
            shell.pendingChatContactID = nil
            openConversation(contactID: pending, resetStack: true)
        }

        let cache = RistakSnapshotCache.shared
        let alreadyPrepared = cache.value(Bool.self, for: ChatSnapshotKey.firstSyncCompleted) == true
            || cache.contains(ChatSnapshotKey.inbox)
        if alreadyPrepared {
            // Migra instalaciones que ya tenían bandeja cacheada antes de que
            // existiera la marca explícita del bootstrap.
            cache.store(true, for: ChatSnapshotKey.firstSyncCompleted)
        }
        // El shell siempre queda montado desde el primer frame. Sin snapshot se
        // muestra su estado vacío silencioso; con snapshot se ven los chats de
        // inmediato. La red revalida debajo y jamás vuelve a tapar la navegación.
        _ = await viewModel.initialLoad(markFirstSyncCompleted: !alreadyPrepared)
    }

    private func refreshIdentityNamespace() {
        viewModel.updateNamespace(
            ChatAccountNamespace.make(
                baseURL: session.baseURL,
                userID: session.user?.id
            )
        )
    }

    /// Consume SOLO deep links de chat; el resto de destinos los navega el
    /// shell/las otras secciones.
    private func consumeChatDeepLink() {
        guard case .chat(let contactID) = router.pendingDeepLink else { return }
        _ = router.consumePendingDeepLink()
        shell.navigate(to: .chats)
        if let contactID, !contactID.isEmpty {
            openConversation(contactID: contactID, resetStack: true)
        }
    }

    // MARK: - Navegación

    private func openConversation(contactID: String, resetStack: Bool = false) {
        viewModel.markOpened(contactID: contactID)
        let route = ChatsRoute.conversation(contactID: contactID)
        if horizontalSizeClass == .regular {
            detailRoute = route
        } else if resetStack {
            path = [route]
        } else if path.last != route {
            path.append(route)
        }
    }

    private func openAssistant() {
        if horizontalSizeClass == .regular {
            detailRoute = .assistant
        } else if path.last != .assistant {
            path.append(.assistant)
        }
    }

    private var detailContactID: String? {
        if case .conversation(let contactID)? = detailRoute { return contactID }
        return nil
    }

    // MARK: - Layout compacto (iPhone)

    private var stackLayout: some View {
        NavigationStack(path: $path) {
            inboxScreen
                .navigationDestination(for: ChatsRoute.self) { route in
                    destination(for: route)
                }
        }
    }

    // MARK: - Layout regular (iPad)

    private var splitLayout: some View {
        NavigationSplitView {
            inboxScreen
                .navigationSplitViewColumnWidth(min: 320, ideal: 380, max: 460)
        } detail: {
            switch detailRoute {
            case .conversation(let contactID):
                NavigationStack {
                    destination(for: .conversation(contactID: contactID))
                }
                // Reconstruir el detalle al cambiar de contacto.
                .id(contactID)
            case .assistant:
                NavigationStack {
                    PersonalAssistantChatScreen()
                }
            case nil:
                RistakEmptyState(
                    icon: "bubble.left.and.bubble.right",
                    title: "Elige una conversación",
                    message: "Selecciona un chat de la lista para verlo aquí."
                )
            }
        }
    }

    // MARK: - Piezas compartidas

    private var inboxScreen: some View {
        InboxScreen(
            viewModel: viewModel,
            selectedContactID: horizontalSizeClass == .regular ? detailContactID : nil,
            onOpenChat: { contact in
                openConversation(contactID: contact.id)
            },
            onOpenAssistant: {
                openAssistant()
            }
        )
    }

    @ViewBuilder
    private func destination(for route: ChatsRoute) -> some View {
        switch route {
        case .conversation(let contactID):
            ConversationScreen(
                contactID: contactID,
                seedContact: viewModel.row(for: contactID),
                onInboxActivity: { activity in
                    viewModel.applyActivity(activity)
                }
            )
        case .assistant:
            PersonalAssistantChatScreen()
        }
    }
}
