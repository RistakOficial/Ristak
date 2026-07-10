import Foundation
import Observation

/// Archivados y silenciados de la bandeja. **Estado 100 % local por
/// dispositivo** (doc research/03 §1.7/§4.8: no existe endpoint backend; gap
/// documentado — multi-dispositivo no sincroniza). Persistencia en
/// `UserDefaults`, con clave namespaceada por cuenta (baseURL + userId) para
/// no mezclar tenants al cambiar de empresa.
@MainActor
@Observable
final class ChatLocalStateStore {
    private static let archivedKeyPrefix = "ristak.ios.chat.archivedIds.v1"
    private static let mutedKeyPrefix = "ristak.ios.chat.mutedIds.v1"

    private(set) var archivedIDs: Set<String> = []
    private(set) var mutedIDs: Set<String> = []

    private var namespace: String?
    private let defaults = UserDefaults.standard

    init() {}

    /// Configura el namespace de la cuenta activa y carga el estado guardado.
    func configure(namespace: String?) {
        guard self.namespace != namespace else { return }
        self.namespace = namespace
        guard namespace != nil else {
            archivedIDs = []
            mutedIDs = []
            return
        }
        archivedIDs = load(prefix: Self.archivedKeyPrefix)
        mutedIDs = load(prefix: Self.mutedKeyPrefix)
    }

    // MARK: - Archivados

    func isArchived(_ contactID: String) -> Bool {
        archivedIDs.contains(contactID)
    }

    func setArchived(_ archived: Bool, contactIDs: [String]) {
        guard !contactIDs.isEmpty else { return }
        if archived {
            archivedIDs.formUnion(contactIDs)
        } else {
            archivedIDs.subtract(contactIDs)
        }
        persist(archivedIDs, prefix: Self.archivedKeyPrefix)
    }

    // MARK: - Silenciados

    func isMuted(_ contactID: String) -> Bool {
        mutedIDs.contains(contactID)
    }

    func setMuted(_ muted: Bool, contactIDs: [String]) {
        guard !contactIDs.isEmpty else { return }
        if muted {
            mutedIDs.formUnion(contactIDs)
        } else {
            mutedIDs.subtract(contactIDs)
        }
        persist(mutedIDs, prefix: Self.mutedKeyPrefix)
    }

    // MARK: - Persistencia

    private func storageKey(prefix: String) -> String? {
        namespace.map { "\(prefix).\($0)" }
    }

    private func load(prefix: String) -> Set<String> {
        guard let key = storageKey(prefix: prefix) else { return [] }
        let stored = defaults.stringArray(forKey: key) ?? []
        return Set(stored)
    }

    private func persist(_ ids: Set<String>, prefix: String) {
        guard let key = storageKey(prefix: prefix) else { return }
        defaults.set(Array(ids).sorted(), forKey: key)
    }
}

/// Namespace estable por cuenta: host del tenant + id de usuario.
enum ChatAccountNamespace {
    static func make(baseURL: URL?, userID: String?) -> String? {
        guard let host = baseURL?.host, !host.isEmpty else { return nil }
        let user = userID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !user.isEmpty else { return nil }
        return "\(host)|\(user)"
    }
}
