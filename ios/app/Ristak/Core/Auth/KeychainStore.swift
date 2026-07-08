import Foundation
import Security

/// Persistencia segura de la sesión (equivalente a `expo-secure-store` en RN).
/// Servicio `com.ristak.ios`, `kSecClassGenericPassword`, accesible tras el
/// primer desbloqueo (los pushes/refetches en background necesitan el token).
struct KeychainStore: Sendable {
    enum Key: String, CaseIterable, Sendable {
        /// Base URL (origin) de la instalación del tenant.
        case baseURL = "ristak.native.apiBaseUrl.v1"
        /// JWT de sesión (30 días).
        case token = "ristak.native.authToken.v1"
        /// Snapshot JSON del usuario autenticado (arranque optimista offline).
        case cachedUser = "ristak.native.cachedUser.v1"
    }

    static let service = "com.ristak.ios"

    init() {}

    // MARK: - Lectura

    func data(for key: Key) -> Data? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = kCFBooleanTrue as Any
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    func string(for key: Key) -> String? {
        guard let data = data(for: key) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - Escritura

    /// Guarda `data` bajo la clave; `nil` borra la entrada.
    @discardableResult
    func set(_ data: Data?, for key: Key) -> Bool {
        guard let data else { return remove(key) }

        var query = baseQuery(for: key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock as String,
        ]

        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            for (attributeKey, attributeValue) in attributes {
                query[attributeKey] = attributeValue
            }
            status = SecItemAdd(query as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    @discardableResult
    func setString(_ value: String?, for key: Key) -> Bool {
        set(value.map { Data($0.utf8) }, for: key)
    }

    @discardableResult
    func remove(_ key: Key) -> Bool {
        let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    /// Borra todas las claves de sesión (cambio de empresa).
    func removeAll() {
        for key in Key.allCases {
            remove(key)
        }
    }

    // MARK: - Internos

    private func baseQuery(for key: Key) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: key.rawValue,
        ]
    }
}
