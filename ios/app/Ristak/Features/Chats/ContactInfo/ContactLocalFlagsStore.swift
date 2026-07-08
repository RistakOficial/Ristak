import Foundation
import Observation

/// Estado LOCAL del dispositivo para chats: archivados y silenciados.
/// No existe endpoint backend (doc 03 §4.8 / doc 06 §6.8): se persiste en
/// UserDefaults por cuenta (paridad RN: `ristak.native.chat.archivedIds.v1` /
/// `ristak.native.chat.mutedIds.v1`, con sufijo de cuenta).
///
/// Punto único de coordinación entre la ficha del contacto y la bandeja:
/// ambos leen/escriben vía `ContactLocalFlagsStore.shared`. Además de la
/// observación directa (`@Observable`), cada cambio publica
/// `ContactLocalFlagsStore.didChangeNotification` para consumidores no-SwiftUI.
@MainActor
@Observable
final class ContactLocalFlagsStore {
    static let shared = ContactLocalFlagsStore()

    /// Notificación de cambio (userInfo: `contactId`, `flag`, `value`).
    static let didChangeNotification = Notification.Name("ristak.chat.localFlagsDidChange")

    private static let archivedKeyBase = "ristak.native.chat.archivedIds.v1"
    private static let mutedKeyBase = "ristak.native.chat.mutedIds.v1"

    private(set) var archivedIDs: Set<String> = []
    private(set) var mutedIDs: Set<String> = []

    /// Namespace de cuenta activo (host del tenant). `default` sin sesión.
    private(set) var accountKey: String = "default"

    private let defaults = UserDefaults.standard

    private init() {
        reload()
    }

    // MARK: - Configuración por cuenta

    /// Cambia el namespace al de la cuenta activa (p. ej. `session.baseURL?.host`)
    /// y recarga los sets. Idempotente.
    func configure(accountKey rawKey: String?) {
        let normalized = Self.normalizeAccountKey(rawKey)
        guard normalized != accountKey else { return }
        accountKey = normalized
        reload()
    }

    // MARK: - Lectura

    func isArchived(_ contactID: String) -> Bool {
        archivedIDs.contains(contactID)
    }

    func isMuted(_ contactID: String) -> Bool {
        mutedIDs.contains(contactID)
    }

    // MARK: - Escritura

    func setArchived(_ archived: Bool, for contactID: String) {
        guard !contactID.isEmpty, isArchived(contactID) != archived else { return }
        if archived {
            archivedIDs.insert(contactID)
        } else {
            archivedIDs.remove(contactID)
        }
        persist(archivedIDs, baseKey: Self.archivedKeyBase)
        notifyChange(contactID: contactID, flag: "archived", value: archived)
    }

    func setMuted(_ muted: Bool, for contactID: String) {
        guard !contactID.isEmpty, isMuted(contactID) != muted else { return }
        if muted {
            mutedIDs.insert(contactID)
        } else {
            mutedIDs.remove(contactID)
        }
        persist(mutedIDs, baseKey: Self.mutedKeyBase)
        notifyChange(contactID: contactID, flag: "muted", value: muted)
    }

    /// Limpia el estado local (logout / cambio de empresa).
    func resetForAccount() {
        archivedIDs = []
        mutedIDs = []
        defaults.removeObject(forKey: storageKey(Self.archivedKeyBase))
        defaults.removeObject(forKey: storageKey(Self.mutedKeyBase))
    }

    // MARK: - Internos

    private func reload() {
        archivedIDs = loadSet(baseKey: Self.archivedKeyBase)
        mutedIDs = loadSet(baseKey: Self.mutedKeyBase)
    }

    private func loadSet(baseKey: String) -> Set<String> {
        let stored = defaults.stringArray(forKey: storageKey(baseKey)) ?? []
        return Set(stored)
    }

    private func persist(_ set: Set<String>, baseKey: String) {
        defaults.set(Array(set).sorted(), forKey: storageKey(baseKey))
    }

    private func storageKey(_ baseKey: String) -> String {
        "\(baseKey).\(accountKey)"
    }

    private func notifyChange(contactID: String, flag: String, value: Bool) {
        NotificationCenter.default.post(
            name: Self.didChangeNotification,
            object: self,
            userInfo: ["contactId": contactID, "flag": flag, "value": value]
        )
    }

    private static func normalizeAccountKey(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? "default" : trimmed
    }
}
