import Foundation

/// Valor JSON arbitrario, tolerante a los tipos mixtos que devuelve el backend
/// (strings, números, booleanos, objetos, arrays y null).
enum RistakJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: RistakJSONValue])
    case array([RistakJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: RistakJSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([RistakJSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Valor JSON no soportado"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    /// String directo si el valor es string.
    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// Número como Double (acepta string numérico).
    var doubleValue: Double? {
        switch self {
        case .number(let value): return value
        case .string(let value): return Double(value)
        case .bool(let value): return value ? 1 : 0
        default: return nil
        }
    }

    var intValue: Int? {
        guard let value = doubleValue, value.isFinite else { return nil }
        return Int(value)
    }

    /// Booleano tolerante: bool nativo, números (≠0) o strings tipo "1/true/yes/on".
    var boolValue: Bool? {
        switch self {
        case .bool(let value): return value
        case .number(let value): return value != 0
        case .string(let value): return RistakStringBool.parse(value)
        default: return nil
        }
    }

    /// Representación string para almacenar en config: strings tal cual,
    /// números/bools serializados, contenedores como JSON compacto, null → nil.
    var configStringValue: String? {
        switch self {
        case .null:
            return nil
        case .string(let value):
            return value
        case .bool(let value):
            return value ? "true" : "false"
        case .number(let value):
            if value == value.rounded(), abs(value) < 1e15 {
                return String(Int64(value))
            }
            return String(value)
        case .object, .array:
            guard let data = try? JSONEncoder().encode(self) else { return nil }
            return String(data: data, encoding: .utf8)
        }
    }
}
