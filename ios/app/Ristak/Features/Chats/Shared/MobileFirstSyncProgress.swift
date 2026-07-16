import SwiftUI

enum MobileFirstSyncStage: Int, CaseIterable, Sendable {
    case account
    case settings
    case contacts
    case conversations
    case localCopy
    case complete

    var title: String {
        switch self {
        case .account: return "Conectando tu cuenta"
        case .settings: return "Cargando configuración"
        case .contacts: return "Preparando contactos"
        case .conversations: return "Preparando conversaciones"
        case .localCopy: return "Guardando copia rápida"
        case .complete: return "Todo listo"
        }
    }

    /// Avanza exclusivamente al completar trabajo real; no depende de timers.
    var fraction: Double {
        switch self {
        case .account: return 0.10
        case .settings: return 0.28
        case .contacts: return 0.50
        case .conversations: return 0.78
        case .localCopy: return 0.94
        case .complete: return 1
        }
    }
}

struct MobileFirstSyncProgress: Equatable, Sendable {
    var stage: MobileFirstSyncStage
    var detail: String
    var errorMessage: String?

    var fraction: Double { stage.fraction }
    var canRetry: Bool { errorMessage != nil }
}

/// Resultado de las dos lecturas que sí forman la ruta crítica de Chats. El
/// directorio permite abrir contactos aunque la bandeja falle; la bandeja pinta
/// conversaciones aunque el directorio tarde o no esté disponible.
struct MobileFirstSyncPrimaryResult<Directory> {
    let directory: Directory?
    let inboxLoaded: Bool
}

/// Ejecuta únicamente las fuentes primarias del primer arranque. Al estar
/// aisladas al `MainActor`, los dos closures pueden publicar estado con seguridad,
/// pero sus suspensiones de red se solapan mediante `async let` en vez de sumar
/// sus timeouts. Configuración, etiquetas y canales se lanzan después desde el
/// ViewModel y nunca forman parte de este presupuesto.
enum MobileFirstSyncCoordinator {
    @MainActor
    static func loadPrimaries<Directory>(
        directory: @escaping @MainActor () async -> Directory?,
        inbox: @escaping @MainActor () async -> Bool
    ) async -> MobileFirstSyncPrimaryResult<Directory> {
        async let directoryTask = directory()
        async let inboxTask = inbox()
        return await MobileFirstSyncPrimaryResult(
            directory: directoryTask,
            inboxLoaded: inboxTask
        )
    }
}

struct MobileFirstSyncProgressView: View {
    let progress: MobileFirstSyncProgress
    let onRetry: () -> Void

    private var visibleStages: [MobileFirstSyncStage] {
        MobileFirstSyncStage.allCases.filter { $0 != .complete }
    }

    var body: some View {
        ZStack {
            RistakTheme.bgGrouped.ignoresSafeArea()

            VStack(alignment: .leading, spacing: RistakTheme.Spacing.lg) {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                        .font(.system(size: 38))
                        .foregroundStyle(RistakTheme.accent)

                    Text("Preparando Ristak por primera vez")
                        .font(.title2.bold())
                        .foregroundStyle(RistakTheme.textPrimary)

                    Text("Mantén la app abierta. Este proceso solo aparece cuando todavía no existe una copia local de tu cuenta.")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                }

                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    ProgressView(value: progress.fraction)
                        .tint(RistakTheme.accent)
                        .accessibilityValue("\(Int(progress.fraction * 100)) por ciento")

                    HStack {
                        Text(progress.stage.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(RistakTheme.textPrimary)
                        Spacer()
                        Text("\(Int(progress.fraction * 100))%")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(RistakTheme.accent)
                    }

                    Text(progress.detail)
                        .font(.footnote)
                        .foregroundStyle(progress.errorMessage == nil ? RistakTheme.textDim : RistakTheme.neg)
                }

                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    ForEach(visibleStages, id: \.rawValue) { stage in
                        stageRow(stage)
                    }
                }

                if progress.canRetry {
                    Button("Reintentar", action: onRetry)
                        .buttonStyle(.borderedProminent)
                        .tint(RistakTheme.accent)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .padding(RistakTheme.Spacing.lg)
            .frame(maxWidth: 520)
        }
        .transition(.opacity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sincronización inicial de Ristak")
    }

    private func stageRow(_ stage: MobileFirstSyncStage) -> some View {
        let completed = progress.stage.rawValue > stage.rawValue || progress.stage == .complete
        let current = progress.stage == stage
        return HStack(spacing: RistakTheme.Spacing.sm) {
            Image(systemName: completed ? "checkmark.circle.fill" : current ? "circle.dotted" : "circle")
                .foregroundStyle(completed || current ? RistakTheme.accent : RistakTheme.textMute)
                .frame(width: 22)
            Text(stage.title)
                .font(.subheadline)
                .foregroundStyle(current ? RistakTheme.textPrimary : RistakTheme.textDim)
        }
    }
}
