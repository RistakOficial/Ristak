import Foundation
import CryptoKit

/// Caché local de notas de voz PROPIAS (salientes).
///
/// El backend guarda las notas de voz enviadas transcodificadas a OGG/Opus
/// (formato que WhatsApp exige), y ese es el `media_url` que llega en el journey.
/// iOS/AVPlayer NO decodifica Opus (los navegadores sí — por eso el problema
/// solo se veía en la app), así que las notas de voz que enviamos no se podían
/// reproducir tras refrescar el hilo.
///
/// Solución: al enviar, guardamos aquí el `m4a` ORIGINAL que grabó el teléfono
/// (que iOS sí reproduce), indexado por la URL remota (opus) que el servidor le
/// asigna. Al pintar la burbuja saliente, el reproductor busca ese m4a local y
/// reproduce ESE en vez del opus. Persistente en `Caches/` → sobrevive reinicios.
enum VoiceNoteLocalStore {
    private static let folderName = "ristak-voice-notes-v1"

    private static func folder() -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        let dir = caches.appendingPathComponent(folderName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Clave estable a partir de la URL remota (SHA-256 hex).
    private static func key(for remoteURL: String) -> String {
        let normalized = normalize(remoteURL)
        let digest = SHA256.hash(data: Data(normalized.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Ignora query/fragment para tolerar diferencias menores entre la URL del
    /// eco de envío y la del journey (ambas derivan del mismo asset público).
    private static func normalize(_ raw: String) -> String {
        if let comps = URLComponents(string: raw), let host = comps.host {
            return "\(comps.scheme ?? "https")://\(host)\(comps.path)"
        }
        return raw
    }

    /// Guarda el m4a original indexado por la URL remota que asignó el servidor.
    static func store(m4aData: Data, forRemoteURL remoteURL: String?) {
        guard let remoteURL, !remoteURL.isEmpty, !m4aData.isEmpty, let folder = folder() else { return }
        let file = folder.appendingPathComponent("\(key(for: remoteURL)).m4a")
        try? m4aData.write(to: file, options: .atomic)
    }

    /// Devuelve el m4a local para esa URL remota, si existe.
    static func localFileURL(forRemoteURL remoteURL: String?) -> URL? {
        guard let remoteURL, !remoteURL.isEmpty, let folder = folder() else { return nil }
        let file = folder.appendingPathComponent("\(key(for: remoteURL)).m4a")
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    /// Borra todas las notas de voz locales (logout): son audio real grabado por
    /// el usuario (PII) y no deben cruzar de una cuenta a otra en el mismo equipo.
    static func removeAll() {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return
        }
        try? FileManager.default.removeItem(at: caches.appendingPathComponent(folderName, isDirectory: true))
    }

    /// Decodifica el payload base64 de una data URL (`data:...;base64,XXXX`).
    static func decodeBase64DataURL(_ dataURL: String) -> Data? {
        guard let range = dataURL.range(of: ";base64,") else { return nil }
        let base64 = String(dataURL[range.upperBound...])
        return Data(base64Encoded: base64)
    }
}
