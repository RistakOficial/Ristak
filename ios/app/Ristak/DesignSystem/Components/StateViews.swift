import SwiftUI

// MARK: - Cargando

/// Estado de carga estándar (ProgressView + mensaje opcional).
struct RistakLoadingView: View {
    var message: String = "Cargando…"

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            ProgressView()
                .controlSize(.large)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

// MARK: - Vacío

/// Estado vacío estándar: icono en círculo suave + título + mensaje.
struct RistakEmptyState: View {
    /// SF Symbol.
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 32, weight: .medium))
                .foregroundStyle(RistakTheme.textDim)
                .frame(width: 76, height: 76)
                .background(Circle().fill(RistakTheme.controlRest))

            VStack(spacing: RistakTheme.Spacing.xxs) {
                Text(title)
                    .font(.title3.bold())
                    .foregroundStyle(RistakTheme.textPrimary)
                    .multilineTextAlignment(.center)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(RistakTheme.Spacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Error

/// Estado de error estándar con botón "Reintentar" opcional.
struct RistakErrorState: View {
    let message: String
    var retry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.md) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(RistakTheme.warn)
                .frame(width: 76, height: 76)
                .background(Circle().fill(RistakTheme.warnSoft))

            VStack(spacing: RistakTheme.Spacing.xxs) {
                Text("Algo salió mal")
                    .font(.title3.bold())
                    .foregroundStyle(RistakTheme.textPrimary)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .multilineTextAlignment(.center)
            }

            if let retry {
                Button("Reintentar", action: retry)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
            }
        }
        .padding(RistakTheme.Spacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
