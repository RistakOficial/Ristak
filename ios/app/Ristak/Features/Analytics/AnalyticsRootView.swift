import Network
import SwiftUI

/// Raíz del módulo Analíticas (doc research/09, paridad /movil PhoneAnalytics):
/// - Selector de periodo 30d/60d/180d/año/personalizado en el toolbar
///   (rango calculado en la zona horaria del NEGOCIO).
/// - 8 KPIs, gráfica, embudo y origen con recuperación independiente de red
///   y actualización manual por gesto.
/// - iPhone: pila de paneles (KPIs 2 col); iPad: grid ancho (KPIs 4 col,
///   embudo y origen lado a lado).
/// - 403 del módulo `dashboard` → estado «sin acceso» de pantalla completa.
struct AnalyticsRootView: View {
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(ShellState.self) private var shell
    @Environment(SessionStore.self) private var session
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase

    @State private var model = AnalyticsViewModel()
    @State private var showsCustomRange = false

    @State private var reconnectGeneration = 0

    private struct LoadContext: Equatable {
        let active: Bool
        let scope: AnalyticsCache?
        let waitingForInitialConfig: Bool
        let includeWeb: Bool
        let sessionGeneration: UInt64
        let userID: String?
        let reconnectGeneration: Int
    }

    private var isActive: Bool { scenePhase == .active && shell.selectedTab == .analytics && session.user != nil }

    private var loadContext: LoadContext {
        let includeWeb = RistakAccessRules.canReadWebAnalytics(session.user)
        let scope = AnalyticsCache(config: appConfig, includeWeb: includeWeb)
        return LoadContext(active: isActive, scope: scope,
                    waitingForInitialConfig: scope == nil && !appConfig.isLoaded, includeWeb: includeWeb,
                    sessionGeneration: session.sessionGeneration, userID: session.user?.id,
                    reconnectGeneration: reconnectGeneration)
    }

    private var isRegularWidth: Bool { horizontalSizeClass == .regular }

    var body: some View {
        NavigationStack {
            Group {
                if model.accessDenied {
                    AnalyticsAccessDeniedView {
                        Task { await model.reloadAll() }
                    }
                } else {
                    content
                }
            }
            .background(RistakTheme.bgGrouped)
            .navigationTitle("Analíticas")
            .navigationSubtitle(model.customRangeLabel ?? "")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    periodMenu
                }
            }
        }
        .task(id: loadContext) {
            guard isActive else { return }
            await model.start(config: appConfig, includeWeb: loadContext.includeWeb)
        }
        .task(id: isActive) {
            guard isActive else { return }
            let monitor = NWPathMonitor()
            defer { monitor.cancel() }
            var wasOffline = false
            for await path in monitor {
                guard !Task.isCancelled else { break }
                let online = path.status == .satisfied
                model.setNetworkAvailable(online)
                if online && wasOffline { reconnectGeneration += 1 }
                wasOffline = !online
            }
        }
        .onChange(of: isActive) { _, active in
            if !active { model.stop() }
        }
        .onDisappear { model.stop() }
        .sensoryFeedback(.selection, trigger: model.period)
    }

    // MARK: - Contenido

    private var content: some View {
        let formatters = appConfig.formatters
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                AnalyticsKPISection(
                    model: model,
                    formatters: formatters,
                    columns: isRegularWidth ? 4 : 2
                )

                if isRegularWidth {
                    AnalyticsChartPanel(model: model, formatters: formatters)

                    HStack(alignment: .top, spacing: RistakTheme.Spacing.lg) {
                        AnalyticsFunnelPanel(model: model, formatters: formatters)
                            .frame(maxWidth: .infinity)

                        VStack(spacing: RistakTheme.Spacing.lg) {
                            AnalyticsOriginPanel(model: model, formatters: formatters)

                            if model.showsWhatsAppPanel {
                                AnalyticsWhatsAppPanel(model: model, formatters: formatters)
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    AnalyticsChartPanel(model: model, formatters: formatters)
                    AnalyticsFunnelPanel(model: model, formatters: formatters)
                    AnalyticsOriginPanel(model: model, formatters: formatters)

                    if model.showsWhatsAppPanel {
                        AnalyticsWhatsAppPanel(model: model, formatters: formatters)
                    }
                }
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, RistakTheme.Spacing.md)
        }
        .refreshable {
            // Refresca TODOS los paneles en paralelo (async let en el VM).
            await model.reloadAll()
        }
        // Dock por dirección de scroll (#11). Solo compacto; en iPad el modifier
        // no oculta nada. Ver `ShellScrollTracking.swift`.
        .reportsShellScroll()
    }

    // MARK: - Selector de periodo

    private var periodMenu: some View {
        Menu {
            ForEach(AnalyticsPeriod.allCases, id: \.rawValue) { option in
                Button {
                    if option == .custom {
                        showsCustomRange = true
                    } else {
                        model.selectPeriod(option)
                    }
                } label: {
                    if model.period == option {
                        Label(model.menuLabel(for: option), systemImage: "checkmark")
                    } else {
                        Text(model.menuLabel(for: option))
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(model.period.chipLabel)
                    .font(.subheadline.weight(.medium))
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
        }
        .accessibilityLabel("Periodo: \(model.period.chipLabel)")
        // iPad: popover anclado al toolbar; iPhone: se adapta a sheet.
        .popover(isPresented: $showsCustomRange) {
            AnalyticsCustomRangeView(
                timeZone: appConfig.businessTimeZone,
                initialRange: model.customRange
            ) { start, end in
                model.applyCustomRange(start: start, end: end)
            }
            .presentationCompactAdaptation(.sheet)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }
}
