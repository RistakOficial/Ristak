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

    /// Glifo de CONTORNO (sin `.fill`) — estado NO seleccionado. Paridad con los
    /// iconos lineales de la app RN (`MessageCircle`/`CalendarDays`/
    /// `CircleDollarSign`/`BarChart3`/`Settings`).
    var outlineSystemImage: String {
        switch self {
        case .chats: return "bubble.left.and.bubble.right"
        case .calendars: return "calendar"
        case .payments: return "dollarsign.circle"
        case .analytics: return "chart.bar"
        case .settings: return "gearshape"
        }
    }

    /// Glifo RELLENO (`.fill`) — estado SELECCIONADO (efecto de selección).
    /// `calendar` no tiene variante `.fill`, así que se mantiene el mismo glifo
    /// (no existe `calendar.fill`; inventarlo rompería el render).
    var filledSystemImage: String {
        switch self {
        case .chats: return "bubble.left.and.bubble.right.fill"
        case .calendars: return "calendar"
        case .payments: return "dollarsign.circle.fill"
        case .analytics: return "chart.bar.fill"
        case .settings: return "gearshape.fill"
        }
    }

    /// Glifo según selección: contorno cuando la tab está inactiva, relleno
    /// cuando está activa. Se pasa como nombre EXPLÍCITO a cada `Tab`, de modo
    /// que `symbolVariants(.none)` en el `TabView` impida el auto-relleno de los
    /// iconos de contorno sin afectar a los `.fill` explícitos del seleccionado.
    func systemImage(selected: Bool) -> String {
        selected ? filledSystemImage : outlineSystemImage
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

// MARK: - Shell principal

/// TabView adaptativa del shell: tab bar inferior en iPhone (minimizable al
/// hacer scroll), sidebar adaptable en iPad. Secciones filtradas por
/// `AccessStore.visibleSections()` (fail-open con usuario cargando; si el
/// filtro dejara 0, se muestran todas — nunca un dock vacío).
struct MainShell: View {
    @Environment(AccessStore.self) private var access
    @Environment(ShellState.self) private var shell
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var visibleTabs: [RistakTab] {
        access.visibleSections().map(RistakTab.init(section:))
    }

    var body: some View {
        @Bindable var shell = shell
        let tabs = visibleTabs
        // El dock solo se minimiza en ancho compacto (iPhone). En iPad el
        // TabView es sidebar adaptable y jamás se oculta.
        let hideTabBar = horizontalSizeClass == .compact && shell.tabBarHidden

        // Selección actual, leída EXPLÍCITAMENTE para que `body` recompute los
        // nombres de icono (contorno ↔ relleno) cada vez que cambia la tab.
        let selected = shell.selectedTab

        TabView(selection: $shell.selectedTab) {
            if tabs.contains(.chats) {
                Tab(RistakTab.chats.title, systemImage: RistakTab.chats.systemImage(selected: selected == .chats), value: RistakTab.chats) {
                    ChatsRootView()
                }
                .badge(shell.chatUnreadCount)
            }

            if tabs.contains(.calendars) {
                Tab(RistakTab.calendars.title, systemImage: RistakTab.calendars.systemImage(selected: selected == .calendars), value: RistakTab.calendars) {
                    CalendarsRootView()
                }
            }

            if tabs.contains(.payments) {
                Tab(RistakTab.payments.title, systemImage: RistakTab.payments.systemImage(selected: selected == .payments), value: RistakTab.payments) {
                    PaymentsRootView()
                }
            }

            if tabs.contains(.analytics) {
                Tab(RistakTab.analytics.title, systemImage: RistakTab.analytics.systemImage(selected: selected == .analytics), value: RistakTab.analytics) {
                    AnalyticsRootView()
                }
            }

            if tabs.contains(.settings) {
                Tab(RistakTab.settings.title, systemImage: RistakTab.settings.systemImage(selected: selected == .settings), value: RistakTab.settings) {
                    SettingsRootView()
                }
            }
        }
        // Desactiva la sustitución automática de `.fill` del tab bar de iOS 26:
        // los iconos NO seleccionados quedan de CONTORNO (nombre sin `.fill`) y
        // solo el seleccionado se rellena (nombre `.fill` EXPLÍCITO, inmune a
        // `symbolVariants`). No afecta al contenido: los iconos de cada pantalla
        // usan nombres explícitos (`.fill`/contorno) — que `symbolVariants` no
        // altera — y sus nav bars/toolbars aplican su propio `.fill` más abajo en
        // el árbol, que gana sobre este `.none` ancestro.
        .environment(\.symbolVariants, .none)
        // iPad: sidebar adaptable (sin tab bar inferior → el dock minimizable no
        // aplica, sidebar intacto). iPhone: tab bar inferior.
        .tabViewStyle(.sidebarAdaptable)
        // Dock minimizable por DIRECCIÓN de scroll, DETERMINISTA: no dependemos
        // de `.tabBarMinimizeBehavior(.onScrollDown)` (el usuario reportó que el
        // minimizado nativo «solo se expandía al llegar arriba»). En su lugar,
        // cada tab reporta su dirección de scroll con `.reportsShellScroll()`
        // (ver `ShellScrollTracking.swift`), que alterna `shell.tabBarHidden`:
        // bajar → oculta, subir → muestra de inmediato. Aquí solo aplicamos esa
        // visibilidad explícita al tab bar y animamos el cambio.
        .toolbar(hideTabBar ? .hidden : .visible, for: .tabBar)
        .animation(.smooth(duration: 0.28), value: hideTabBar)
        .onChange(of: tabs) { _, newTabs in
            // Si la sección activa deja de estar permitida, saltar a la
            // primera permitida (paridad RN `App.tsx:1289-1297`).
            guard !newTabs.contains(shell.selectedTab), let first = newTabs.first else { return }
            shell.selectedTab = first
        }
    }
}
