import SwiftUI
import Observation

// MARK: - Tabs tipadas

/// Tabs del shell en su orden canónico: Chats, Calendarios, Pagos,
/// Analíticas, Ajustes (ARCHITECTURE.md §Navegación).
enum RistakTab: String, CaseIterable, Identifiable, Hashable, Sendable {
    case chats
    case calendars
    case payments
    case analytics
    case settings

    var id: String { rawValue }

    /// Sección de permisos equivalente (`AccessStore`).
    var section: PhoneSection {
        switch self {
        case .chats: return .chat
        case .calendars: return .calendar
        case .payments: return .payments
        case .analytics: return .analytics
        case .settings: return .settings
        }
    }

    init(section: PhoneSection) {
        switch section {
        case .chat: self = .chats
        case .calendar: self = .calendars
        case .payments: self = .payments
        case .analytics: self = .analytics
        case .settings: self = .settings
        }
    }

    var title: String {
        switch self {
        case .chats: return "Chats"
        case .calendars: return "Calendarios"
        case .payments: return "Pagos"
        case .analytics: return "Analíticas"
        case .settings: return "Ajustes"
        }
    }

    /// Glifo BASE (sin `.fill`) para el `Tab`. iOS 18/26 muestra este contorno
    /// cuando la tab está INACTIVA y sustituye automáticamente por su variante
    /// `.fill` cuando está SELECCIONADA (no hay que forzar el swap a mano ni
    /// tocar `symbolVariants` — hacerlo rompe ese comportamiento nativo).
    /// `calendar` no tiene `.fill`, así que en selección se tiñe de acento
    /// manteniendo el contorno (no existe `calendar.fill`).
    var systemImage: String {
        switch self {
        case .chats: return "message"
        case .calendars: return "calendar"
        case .payments: return "cart"
        case .analytics: return "cellularbars"
        case .settings: return "gear"
        }
    }
}

// MARK: - Estado del shell

/// Estado observable del shell: tab seleccionada, badge de no leídos y hooks
/// de navegación programática (deep links de push, saltos entre módulos).
@MainActor
@Observable
final class ShellState {
    /// Tab activa (Chats por defecto, paridad RN).
    var selectedTab: RistakTab = .chats

    /// No leídos de la bandeja (badge de la tab Chats). Lo alimenta el módulo
    /// de Chats; 0 = sin badge.
    var chatUnreadCount: Int = 0

    /// Señal para llevar la bandeja de chats hasta arriba. Se incrementa cada
    /// vez que la app pasa a primer plano (o arranca): el módulo Chats la observa
    /// y hace scroll al tope. Siempre que se abra la app volvemos a Chats arriba.
    var chatsScrollTopSignal: Int = 0

    /// Vuelve a Chats y pide scroll al tope (al abrir/reactivar la app).
    func resetToChatsTop() {
        selectedTab = .chats
        chatsScrollTopSignal &+= 1
    }

    /// Deep link pendiente hacia un hilo de chat (`contactId` de push o de
    /// "abrir chat" desde otro módulo). El módulo Chats lo consume y lo limpia.
    var pendingChatContactID: String?

    /// Contacto precargado para el flujo de cobro (salto Chats → Pagos).
    var pendingPaymentContactID: String?

    /// Contacto precargado para agendar cita (salto Chats → Calendarios).
    var pendingAppointmentContactID: String?

    /// Dock (tab bar compacto) oculto por dirección de scroll. Lo maneja
    /// `ReportsShellScrollModifier` (`.reportsShellScroll()`) desde el scroll
    /// principal de cada tab: bajar oculta, subir muestra. Nunca se activa en
    /// ancho regular (iPad usa sidebar adaptable). Ver `MainShell`.
    var tabBarHidden: Bool = false

    /// Navegación programática simple.
    func navigate(to tab: RistakTab) {
        selectedTab = tab
    }

    /// Abre (o deja pendiente) el hilo de chat de un contacto.
    func openChat(contactID: String) {
        pendingChatContactID = contactID
        selectedTab = .chats
    }

    /// Salta a Pagos con el contacto precargado.
    func openPayments(contactID: String? = nil) {
        pendingPaymentContactID = contactID
        selectedTab = .payments
    }

    /// Salta a Calendarios con el contacto precargado.
    func openCalendars(contactID: String? = nil) {
        pendingAppointmentContactID = contactID
        selectedTab = .calendars
    }
}

// MARK: - Estilo de tab adaptativo

private extension View {
    /// Aplica `.sidebarAdaptable` solo en iPad (ancho regular). En iPhone deja el
    /// tab bar por defecto para que los iconos inactivos se vean de contorno.
    @ViewBuilder
    func adaptiveSidebarTabStyle(enabled: Bool) -> some View {
        if enabled {
            self.tabViewStyle(.sidebarAdaptable)
        } else {
            self
        }
    }
}

// MARK: - Shell principal

/// TabView adaptativa del shell: tab bar inferior en iPhone (minimizable al
/// hacer scroll), sidebar adaptable en iPad. Secciones filtradas por
/// `AccessStore.visibleSections()` (fail-open con usuario cargando; si el
/// filtro dejara 0, se muestran todas — nunca un dock vacío).
struct MainShell: View {
    @Environment(AccessStore.self) private var access
    @Environment(ShellState.self) private var shell
    @Environment(NotificationRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var visibleTabs: [RistakTab] {
        access.visibleSections().map(RistakTab.init(section:))
    }

    var body: some View {
        @Bindable var shell = shell
        let tabs = visibleTabs
        let isRegular = horizontalSizeClass == .regular
        // El dock solo se minimiza en ancho compacto (iPhone). En iPad (sidebar)
        // jamás se oculta.
        let hideTabBar = horizontalSizeClass == .compact && shell.tabBarHidden

        TabView(selection: $shell.selectedTab) {
            if tabs.contains(.chats) {
                Tab(RistakTab.chats.title, systemImage: RistakTab.chats.systemImage, value: RistakTab.chats) {
                    ChatsRootView()
                }
                .badge(shell.chatUnreadCount)
            }

            if tabs.contains(.calendars) {
                Tab(RistakTab.calendars.title, systemImage: RistakTab.calendars.systemImage, value: RistakTab.calendars) {
                    CalendarsRootView()
                }
            }

            if tabs.contains(.payments) {
                Tab(RistakTab.payments.title, systemImage: RistakTab.payments.systemImage, value: RistakTab.payments) {
                    PaymentsRootView()
                }
            }

            if tabs.contains(.analytics) {
                Tab(RistakTab.analytics.title, systemImage: RistakTab.analytics.systemImage, value: RistakTab.analytics) {
                    AnalyticsRootView()
                }
            }

            if tabs.contains(.settings) {
                Tab(RistakTab.settings.title, systemImage: RistakTab.settings.systemImage, value: RistakTab.settings) {
                    SettingsRootView()
                }
            }
        }
        // Estilo del TabView SOLO en iPad (ancho regular): sidebar adaptable. En
        // iPhone se deja el tab bar por DEFECTO — `.sidebarAdaptable` en compacto
        // forzaba la variante `.fill` de TODOS los iconos (el usuario los veía
        // negros/rellenos); el tab bar por defecto sí muestra contorno en las
        // inactivas y rellena solo la seleccionada. No se toca `symbolVariants`.
        .adaptiveSidebarTabStyle(enabled: isRegular)
        // Dock minimizable por DIRECCIÓN de scroll, DETERMINISTA (ver
        // `ShellScrollTracking.swift`): bajar oculta, subir muestra al instante.
        .toolbar(hideTabBar ? .hidden : .visible, for: .tabBar)
        .animation(.smooth(duration: 0.28), value: hideTabBar)
        .onChange(of: tabs) { _, newTabs in
            // Si la sección activa deja de estar permitida, saltar a la
            // primera permitida (paridad RN `App.tsx:1289-1297`).
            guard !newTabs.contains(shell.selectedTab), let first = newTabs.first else { return }
            shell.selectedTab = first
        }
        // Deep links de push que NO son de chat (cita/pago/analíticas/ajustes):
        // el shell es el único componente montado siempre, así que enruta AQUÍ a
        // la pestaña correcta. Los de chat los sigue consumiendo `ChatsRootView`
        // (cada quien consume SOLO su tipo → sin carrera de consumo). En tap con
        // la app viva usa el `onChange`; en cold start la `task` inicial.
        .onChange(of: router.deepLinkVersion) {
            routePendingNonChatDeepLink()
        }
        .task {
            routePendingNonChatDeepLink()
        }
    }

    /// Enruta a su pestaña los deep links de push que no son de chat, consumiendo
    /// SOLO esos tipos (deja `.chat` intacto para `ChatsRootView`).
    private func routePendingNonChatDeepLink() {
        switch router.pendingDeepLink {
        case .appointment:
            _ = router.consumePendingDeepLink()
            shell.navigate(to: .calendars)
        case .payments:
            _ = router.consumePendingDeepLink()
            shell.navigate(to: .payments)
        case .analytics:
            _ = router.consumePendingDeepLink()
            shell.navigate(to: .analytics)
        case .settings:
            _ = router.consumePendingDeepLink()
            shell.navigate(to: .settings)
        case .chat, .none:
            break
        }
    }
}
