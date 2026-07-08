import Foundation

/// Envelope dominante del backend: `{ "success": true, "data": <payload> }`.
struct DataEnvelope<T: Decodable>: Decodable {
    let success: Bool?
    let data: T

    enum CodingKeys: String, CodingKey {
        case success, data
    }
}

/// Respuesta vacía / cuerpo irrelevante (204, acks). Decodifica desde cualquier JSON.
struct APINoContent: Decodable, Sendable {
    init() {}
    init(from decoder: Decoder) throws {}
}

/// Ack genérico `{ success, message, ... }` tolerante a campos extra
/// (p. ej. `socialHistoryBackfill` en `POST /api/config`).
struct APIAcknowledgment: Decodable, Sendable {
    let success: Bool?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case success, message
    }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        success = container?.flexibleBool(forKey: .success)
        message = container?.flexibleString(forKey: .message)
    }
}

/// Clave dinámica para envelopes con clave propia (`{ success, config: … }`,
/// `{ success, timezone: … }`, `{ products: … }`, etc.).
struct RistakDynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }

    init(_ key: String) {
        self.stringValue = key
        self.intValue = nil
    }
}

/// Implementación de la REGLA DE ENVELOPE (ver ARCHITECTURE.md §Núcleo de red):
/// desenvolver `{ success, data }` SOLO si el objeto raíz tiene AMBAS claves;
/// en cualquier otro caso decodificar el payload tal cual (formas con clave
/// propia, arrays pelados, objetos planos).
enum RistakEnvelopeDecoder {
    /// Decodifica `T` aplicando la regla de envelope.
    static func unwrap<T: Decodable>(_ data: Data, decoder: JSONDecoder) throws -> T {
        if hasSuccessAndDataKeys(data) {
            return try decoder.decode(DataEnvelope<T>.self, from: data).data
        }
        return try decoder.decode(T.self, from: data)
    }

    /// Decodifica `T` desde un envelope con clave propia `{ success, <key>: T }`.
    static func keyed<T: Decodable>(_ key: String, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.userInfo[RistakKeyedEnvelopeBox<T>.keyUserInfoKey] = key
        let box = try decoder.decode(RistakKeyedEnvelopeBox<T>.self, from: data)
        guard let value = box.value else {
            throw DecodingError.keyNotFound(
                RistakDynamicCodingKey(key),
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "La respuesta no contiene la clave \(key)"
                )
            )
        }
        return value
    }

    /// ¿El JSON raíz es un objeto con ambas claves `success` y `data`?
    static func hasSuccessAndDataKeys(_ data: Data) -> Bool {
        guard
            let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
            let dictionary = object as? [String: Any]
        else { return false }
        return dictionary.keys.contains("success") && dictionary.keys.contains("data")
    }
}

/// Caja interna para decodificar envelopes con clave dinámica; la clave viaja
/// en el `userInfo` del decoder.
private struct RistakKeyedEnvelopeBox<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        guard let key = decoder.userInfo[RistakKeyedEnvelopeBox.keyUserInfoKey] as? String else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "Falta la clave del envelope en userInfo"
                )
            )
        }
        let container = try decoder.container(keyedBy: RistakDynamicCodingKey.self)
        value = try container.decodeIfPresent(T.self, forKey: RistakDynamicCodingKey(key))
    }

    static var keyUserInfoKey: CodingUserInfoKey {
        CodingUserInfoKey(rawValue: "ristak.keyedEnvelope.key")!
    }
}
