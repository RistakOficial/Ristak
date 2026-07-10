import Foundation

/// Llaves y helpers de decodificación para el patrón instantáneo SWR (Round 6
/// #4) aplicado a Chats sobre `RistakSnapshotCache`.
///
/// El `RistakSnapshotCache` ya está namespaceado por cuenta y se precarga a
/// memoria en el arranque (SessionStore), así que estas pantallas solo tienen
/// que leer/escribir bajo estas llaves para pintar al instante lo último visto.
enum ChatSnapshotKey {
    /// Bandeja completa (vista por defecto, sin búsqueda ni filtro de número).
    static let inbox = "chat:inbox"

    /// Últimos mensajes del hilo de un contacto.
    static func thread(_ contactID: String) -> String { "chat:thread:\(contactID)" }

    /// Markers de actividad (pagos/citas) del hilo de un contacto. Se cachean
    /// aparte de los mensajes para que el primer pintado ya los incluya y no haya
    /// una segunda pasada de red que reacomode el hilo al entrar.
    static func threadMarkers(_ contactID: String) -> String { "chat:thread:markers:\(contactID)" }

    /// Estado del agente conversacional del hilo (RAW, sin filtrar phantoms).
    /// Permite pintar el robot del header AL INSTANTE, sin esperar el fetch en
    /// frío (~10 s) de `GET states/:contactId?includeAll=1`.
    static func threadAgentStates(_ contactID: String) -> String { "chat:thread:agents:\(contactID)" }

    /// Ficha (detalle) de un contacto.
    static func contactDetail(_ contactID: String) -> String { "chat:contact:\(contactID)" }

    /// Viaje de cliente (journey) de un contacto.
    static func contactJourney(_ contactID: String) -> String { "chat:contact:journey:\(contactID)" }
}

/// Decodificación de snapshots crudos aplicando LA MISMA regla de envelope que
/// la tubería viva (`RistakEnvelopeDecoder`). Guardamos el `Data` crudo de la
/// respuesta (o un array recortado) y lo re-decodificamos idéntico al fetch en
/// vivo, sin conformar `Encodable` en modelos de Core.
enum ChatSnapshotDecoding {
    /// Decodifica `T` desde `Data` crudo (con o sin envelope `{success,data}`).
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
        try? RistakEnvelopeDecoder.unwrap(data, decoder: JSONDecoder())
    }
}
