import SwiftUI

// MARK: - Barra de progreso horizontal

/// Barra horizontal de los paneles Embudo/Origen: pista neutra + relleno de
/// color con ancho relativo al máximo del grupo.
struct AnalyticsBar: View {
    /// Fracción 0…1 del ancho total.
    let fraction: Double
    var color: Color = RistakTheme.accent

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(RistakTheme.controlRest)
                Capsule()
                    .fill(color)
                    .frame(width: max(0, min(1, fraction)) * geo.size.width)
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

// MARK: - Pill de encabezado

/// Pastilla tonal de los headers de panel (conversión total del embudo,
/// total de la tab de Origen).
struct AnalyticsHeaderPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(RistakTheme.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(RistakTheme.accentSoft))
    }
}

// MARK: - Estados por panel

/// Spinner centrado de un panel (paridad de los spinners por panel de /movil).
struct AnalyticsPanelLoadingView: View {
    /// Ej. «Cargando gráfica», «Cargando embudo», «Cargando origen».
    let accessibilityLabel: String

    var body: some View {
        ProgressView()
            .frame(maxWidth: .infinity)
            .padding(.vertical, RistakTheme.Spacing.xl)
            .accessibilityLabel(accessibilityLabel)
    }
}

/// Error inline de un panel con botón «Reintentar» (doc 09 §7.7).
struct AnalyticsPanelErrorView: View {
    let message: String
    var retry: () -> Void

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(RistakTheme.textDim)
                .multilineTextAlignment(.center)

            Button("Reintentar", action: retry)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RistakTheme.Spacing.lg)
    }
}

// MARK: - Sin acceso (403 del módulo dashboard)

/// Estado de pantalla completa cuando el backend responde 403
/// `read_access_required` en `/api/dashboard/*` (trampa doc 09/13: la pestaña
/// se gatea por `analytics` pero el backend valida `dashboard`).
struct AnalyticsAccessDeniedView: View {
    var retry: () -> Void

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.md) {
            Image(systemName: "lock.fill")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(RistakTheme.textDim)
                .frame(width: 76, height: 76)
                .background(Circle().fill(RistakTheme.controlRest))

            VStack(spacing: RistakTheme.Spacing.xxs) {
                Text("Sin acceso")
                    .font(.title3.bold())
                    .foregroundStyle(RistakTheme.textPrimary)

                Text("No tienes acceso a esta sección.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .multilineTextAlignment(.center)
            }

            Button("Reintentar", action: retry)
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
        }
        .padding(RistakTheme.Spacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
