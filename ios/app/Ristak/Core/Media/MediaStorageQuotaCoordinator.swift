import Foundation
import Observation

struct MediaStorageQuotaPreflightRequest: Encodable, Sendable {
    let requestedBytes: Int
}

struct MediaStorageQuotaPreflight: Decodable, Sendable, Equatable {
    let allowed: Bool
    let warningRequired: Bool
    let warningThresholdPercent: Double
    let quotaBytes: Int?
    let usedBytes: Int
    let reservedBytes: Int
    let requestedBytes: Int
    let projectedBytes: Int
    let usagePercent: Double?
    let projectedUsagePercent: Double?
    let connectPath: String

    private enum CodingKeys: String, CodingKey {
        case allowed
        case warningRequired = "warning_required"
        case warningThresholdPercent = "warning_threshold_percent"
        case quotaBytes = "quota_bytes"
        case usedBytes = "used_bytes"
        case reservedBytes = "reserved_bytes"
        case requestedBytes = "requested_bytes"
        case projectedBytes = "projected_bytes"
        case usagePercent = "usage_percent"
        case projectedUsagePercent = "projected_usage_percent"
        case connectPath = "connect_path"
    }
}

enum MediaStorageQuotaDecision: Sendable {
    case continueUpload
    case connectBunny
    case cancel
}

struct MediaStorageQuotaPromptState: Identifiable, Sendable {
    let id = UUID()
    let preflight: MediaStorageQuotaPreflight

    var isBlocked: Bool { !preflight.allowed }

    var displayPercent: Int {
        let current = preflight.usagePercent ?? 0
        let projected = preflight.projectedUsagePercent ?? current
        return max(0, Int(max(current, projected).rounded()))
    }

    var message: String {
        if isBlocked {
            return "Esta subida ya no cabe dentro del GB incluido. Conecta una cuenta de Bunny.net para seguir subiendo archivos."
        }
        let projected = preflight.projectedUsagePercent.map { Int($0.rounded()) }
        let projection = projected.map { " Esta subida llevaría el uso al \($0)%." } ?? ""
        return "Tu almacenamiento administrado ya está en el último 10%.\(projection) Este aviso aparecerá en cada intento de subida. Puedes continuar mientras todavía quede espacio o conectar Bunny.net."
    }
}

/// Cola global para que toda subida nativa use el mismo aviso y ninguna alerta
/// simultánea tape a otra. No conserva una preferencia de “no volver a mostrar”.
@MainActor
@Observable
final class MediaStorageQuotaCoordinator {
    static let shared = MediaStorageQuotaCoordinator()

    private struct PendingPrompt {
        let state: MediaStorageQuotaPromptState
        let continuation: CheckedContinuation<MediaStorageQuotaDecision, Never>
    }

    private var pending: [PendingPrompt] = []
    private var active: PendingPrompt?
    private var isTransitioning = false

    private(set) var activePrompt: MediaStorageQuotaPromptState?

    func requestDecision(for preflight: MediaStorageQuotaPreflight) async -> MediaStorageQuotaDecision {
        await withCheckedContinuation { continuation in
            pending.append(PendingPrompt(
                state: MediaStorageQuotaPromptState(preflight: preflight),
                continuation: continuation
            ))
            presentNextIfNeeded()
        }
    }

    func resolve(_ decision: MediaStorageQuotaDecision) {
        guard let current = active else { return }
        active = nil
        activePrompt = nil
        current.continuation.resume(returning: decision)
        isTransitioning = true
        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self else { return }
            self.isTransitioning = false
            self.presentNextIfNeeded()
        }
    }

    func cancelAll() {
        if let current = active {
            current.continuation.resume(returning: .cancel)
        }
        for queued in pending {
            queued.continuation.resume(returning: .cancel)
        }
        active = nil
        pending.removeAll()
        activePrompt = nil
        isTransitioning = false
    }

    private func presentNextIfNeeded() {
        guard active == nil, !isTransitioning, !pending.isEmpty else { return }
        let next = pending.removeFirst()
        active = next
        activePrompt = next.state
    }
}

enum MediaStorageQuotaGateError: LocalizedError, Sendable, Equatable {
    case blocked
    case connectionRequested

    var errorDescription: String? {
        switch self {
        case .blocked:
            return "Ya no hay espacio en el GB incluido. Conecta Bunny.net para seguir subiendo."
        case .connectionRequested:
            return "La subida quedó pausada mientras conectas Bunny.net."
        }
    }
}
