import SwiftUI

/// Raíz del módulo Analíticas (doc research/09, paridad /movil PhoneAnalytics):
/// - Selector de periodo 30d/60d/180d/año/personalizado en el toolbar
///   (rango calculado en la zona horaria del NEGOCIO).
/// - 8 KPIs, gráfica principal, embudo y origen; cargas por panel con error
///   inline + «Reintentar» y pull-to-refresh global.
/// - iPhone: pila de paneles (KPIs 2 col); iPad: grid ancho (KPIs 4 col,
///   embudo y origen lado a lado).
/// - 403 del módulo `dashboard` → estado «sin acceso» de pantalla completa.
struct AnalyticsRootView: View {
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase

    @State private var model = AnalyticsViewModel()
    @State private var showsCustomRange = false

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
        // Recalcula el rango si cambia la zona horaria del negocio (la carga
        // de config puede resolverse después del primer render).
        .task(id: appConfig.businessTimeZone) {
            await model.start(config: appConfig)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.reloadAll() }
        }
        .onDisappear {
            model.stopOriginPhoneBreakdown()
        }
        .sensoryFeedback(.selection, trigger: model.period)
    }

    // MARK: - Contenido

    private var content: some View {
        let formatters = appConfig.formatters
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                if model.lastRefreshFailed {
                    Label(
                        "No se pudo actualizar todo. Se conservan los últimos datos disponibles.",
                        systemImage: "wifi.exclamationmark"
                    )
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.warn)
                }
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
