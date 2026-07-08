import Foundation

/// Parsing de booleanos guardados como string en `app_config`/`user_app_config`.
/// Regla exacta del cliente RN/web: `"1" | "true" | "yes" | "on"` (lowercase) → true;
/// `"0" | "false" | "no" | "off" | ""` → false; cualquier otra cosa → nil.
enum RistakStringBool {
    static func parse(_ value: String?) -> Bool? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "1", "true", "yes", "on":
            return true
        case "0", "false", "no", "off", "":
            return false
        default:
            return nil
        }
    }
}

// MARK: - Decodificación tolerante (string-o-número, string-bool, etc.)

/// Helpers para decodificar campos que el backend puede mandar como String o
/// número indistintamente (p. ej. `user.id` es Int en `serializeAuthUser` pero
/// String en `serializeMember`). Devuelven `nil` si la clave falta, es null o
/// no se puede interpretar.
extension KeyedDecodingContainer {
    func flexibleString(forKey key: Key) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return String(value) }
        if let value = try? decodeIfPresent(Double.self, forKey: key) {
            if value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
            return String(value)
        }
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value ? "true" : "false" }
        return nil
    }

    func flexibleInt(forKey key: Key) -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key), value.isFinite { return Int(value) }
        if let value = try? decodeIfPresent(String.self, forKey: key) {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if let int = Int(trimmed) { return int }
            if let double = Double(trimmed), double.isFinite { return Int(double) }
        }
        return nil
    }

    func flexibleDouble(forKey key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return Double(value) }
        if let value = try? decodeIfPresent(String.self, forKey: key) {
            return Double(value.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    /// Booleano tolerante: bool nativo, número (≠0 → true) o string "1/true/yes/on".
    func flexibleBool(forKey key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value != 0 }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value != 0 }
        if let value = try? decodeIfPresent(String.self, forKey: key) { return RistakStringBool.parse(value) }
        return nil
    }

    /// Mapa `{ clave: bool }` tolerante (los valores pueden llegar como bool,
    /// número o string). Claves con valores no interpretables se omiten.
    func flexibleBoolMap(forKey key: Key) -> [String: Bool]? {
        guard let raw = try? decodeIfPresent([String: RistakJSONValue].self, forKey: key) else { return nil }
        var result: [String: Bool] = [:]
        for (mapKey, value) in raw {
            if let bool = value.boolValue { result[mapKey] = bool }
        }
        return result
    }
}
