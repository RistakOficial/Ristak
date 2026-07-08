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

    var systemImage: String {
        switch self {
        case .chats: return "bubble.left.and.bubble.right.fill"
        case .calendars: return "calendar"
        case .payments: return "dollarsign.circle.fill"
        case .analytics: return "chart.bar.fill"
        case .settings: return "gearshape.fill"
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

    /// Deep link pendiente hacia un hilo de chat (`contactId` de push o de
    /// "abrir chat" desde otro módulo). El módulo Chats lo consume y lo limpia.
    var pendingChatContactID: String?

    /// Contacto precargado para el flujo de cobro (salto Chats → Pagos).
    var pendingPaymentContactID: String?

    /// Contacto precargado para agendar cita (salto Chats → Calendarios).
    var pendingAppointmentContactID: String?

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

    private var visibleTabs: [RistakTab] {
        access.visibleSections().map(RistakTab.init(section:))
    }

    var body: some View {
        @Bindable var shell = shell
        let tabs = visibleTabs

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
        .tabViewStyle(.sidebarAdaptable)
        .tabBarMinimizeBehavior(.onScrollDown)
        .onChange(of: tabs) { _, newTabs in
            // Si la sección activa deja de estar permitida, saltar a la
            // primera permitida (paridad RN `App.tsx:1289-1297`).
            guard !newTabs.contains(shell.selectedTab), let first = newTabs.first else { return }
            shell.selectedTab = first
        }
    }
}
