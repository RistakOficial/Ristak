import Foundation
import Observation

/// Caché de snapshots stale-while-revalidate + precarga en memoria (Round 6 #4).
///
/// Generaliza el patrón de `ChatInboxDiskCache` a TODA la app: cada pantalla
/// guarda en disco lo último que el usuario vio y, en el arranque en frío,
/// TODO se precarga a memoria en UNA sola pasada ANTES de pintar la primera
/// pantalla. Así cada pantalla lee de memoria al instante (cero golpe a disco
/// por pantalla → cero "flash" de vacío) y luego revalida contra la red.
///
/// - Namespaceado por CUENTA (host del tenant + id de usuario): cambiar de app
///   o iniciar sesión en otro tenant nunca mezcla datos cacheados.
/// - Escrituras a disco DEBOUNCED y fuera del `@MainActor`: fallar al escribir
///   jamás bloquea ni tumba la UI.
///
/// ## Receta de uso (las 5 features la aplican por pantalla)
/// ```swift
/// // 1) Al aparecer: pinta al instante lo cacheado (sin spinner).
/// if let cached = RistakSnapshotCache.shared.value([Payment].self, for: key) {
///     self.payments = cached          // paint inmediato
/// }
/// // 2) Revalida contra la red.
/// let fresh = try await api.fetchPayments()
/// // 3) Al éxito: reemplaza en pantalla y actualiza la caché.
/// self.payments = fresh
/// RistakSnapshotCache.shared.store(fresh, for: key)   // memoria ya; disco debounced
/// ```
/// Para listas/históricos, CAPA el array ANTES de guardar (p. ej.
/// `Array(rows.prefix(300))`): la caché no infla el tamaño por ti.
///
/// ## Round-trip (importante)
/// `value(_:for:)` decodifica el `Data` guardado con el `init(from:)` del
/// modelo. Si guardas con `store(_ modelo)`, el modelo debe ser Codable
/// simétrico (round-trip). Si tu modelo tiene `init(from:)` tolerante pero no
/// `encode(to:)` simétrico, guarda el `Data` CRUDO de la respuesta con
/// `storeRaw(_:for:)`: así `value(Modelo.self, for:)` decodifica idéntico al
/// fetch en vivo.
@MainActor
@Observable
final class RistakSnapshotCache {
    /// Singleton global.
    static let shared = RistakSnapshotCache()

    /// Debounce por clave de la escritura a disco.
    private static let writeDebounce: Duration = .milliseconds(300)

    /// Versión del formato en disco (permite invalidar migrando la carpeta).
    private static let storeVersion = "v1"

    // MARK: Estado imperativo (no reactivo)

    /// Snapshot en memoria: clave original → `Data` JSON. Lectura instantánea.
    @ObservationIgnored private var memory: [String: Data] = [:]
    /// Namespace saneado activo (`nil` = sin configurar).
    @ObservationIgnored private var currentNamespace: String?
    /// Directorio de la cuenta activa en disco.
    @ObservationIgnored private var namespaceDir: URL?
    /// Escrituras pendientes por clave (para coalescer ráfagas).
    @ObservationIgnored private var pendingWrites: [String: Task<Void, Never>] = [:]

    private init() {}

    // MARK: - Namespace

    /// Namespace estable por cuenta: `"<host>.<userId>"` (paridad con
    /// `ChatAccountNamespace`). Se sanea al configurar.
    static func namespace(baseURL: URL?, userID: String?) -> String {
        let host = baseURL?.host ?? "sin-servidor"
        let user = (userID?.isEmpty == false) ? userID! : "sin-usuario"
        return "\(host).\(user)"
    }

    /// Apunta la caché a la cuenta activa. Si el namespace cambia, LIMPIA la
    /// memoria (evita mezclar tenants) y prepara el directorio en disco.
    /// Idempotente: reconfigurar al mismo namespace no hace nada.
    func configure(namespace rawNamespace: String) {
        let sanitized = Self.sanitize(rawNamespace)
        guard sanitized != currentNamespace else { return }

        currentNamespace = sanitized
        let dir = Self.rootDirectory().appendingPathComponent(sanitized, isDirectory: true)
        namespaceDir = dir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Namespace nuevo: descartar la memoria del anterior.
        cancelPendingWrites()
        memory.removeAll()
    }

    // MARK: - Precarga en memoria (arranque)

    /// Carga TODAS las entradas persistidas del namespace activo a memoria en
    /// UNA pasada (una lectura de directorio + lectura de cada archivo, fuera
    /// del `@MainActor`). Llamar en el arranque ANTES de pintar el shell.
    func preloadIntoMemory() async {
        guard let dir = namespaceDir else { return }

        let loaded: [String: Data] = await Task.detached(priority: .userInitiated) {
            var result: [String: Data] = [:]
            let fm = FileManager.default
            guard let files = try? fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            ) else { return result }

            for file in files where file.pathExtension == "json" {
                let encodedName = file.deletingPathExtension().lastPathComponent
                guard let key = Self.decodeKey(encodedName),
                      let data = try? Data(contentsOf: file) else { continue }
                result[key] = data
            }
            return result
        }.value

        // Preserva cualquier `store()` ocurrido durante la precarga: la memoria
        // fresca gana sobre lo leído de disco.
        for (key, data) in loaded where memory[key] == nil {
            memory[key] = data
        }
    }

    // MARK: - Lectura (instantánea, desde memoria)

    /// Decodifica el valor cacheado para `key`, o `nil` si no existe / no
    /// decodifica. Instantáneo (lee de memoria).
    func value<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        guard let data = memory[key] else { return nil }
        return try? Self.decoder.decode(T.self, from: data)
    }

    /// `Data` JSON crudo cacheado para `key` (para quien ya maneja `Data`).
    func rawData(for key: String) -> Data? {
        memory[key]
    }

    /// ¿Hay una entrada cacheada para `key`?
    func contains(_ key: String) -> Bool {
        memory[key] != nil
    }

    // MARK: - Escritura (memoria inmediata + disco debounced)

    /// Codifica y guarda `value`. Actualiza la memoria AL INSTANTE y programa
    /// la escritura a disco DEBOUNCED y no bloqueante. Fail-safe: un fallo de
    /// codificación/escritura no rompe nada.
    func store<T: Encodable>(_ value: T, for key: String) {
        guard let data = try? Self.encoder.encode(value) else { return }
        storeRaw(data, for: key)
    }

    /// Guarda `Data` JSON crudo (para quien ya tiene el `Data` de la respuesta).
    func storeRaw(_ data: Data, for key: String) {
        memory[key] = data
        scheduleWrite(key: key, data: data)
    }

    /// Borra una entrada (memoria + disco).
    func remove(_ key: String) {
        memory[key] = nil
        pendingWrites[key]?.cancel()
        pendingWrites[key] = nil
        guard let dir = namespaceDir else { return }
        let url = dir.appendingPathComponent(Self.encodeKey(key) + ".json")
        Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Limpieza (logout / cambio de cuenta)

    /// Limpieza total: memoria + escrituras pendientes + borra el directorio del
    /// namespace en disco. Llamar en logout / cambio de app.
    func reset() {
        cancelPendingWrites()
        memory.removeAll()
        if let dir = namespaceDir {
            let fm = FileManager.default
            // Renombra el directorio a un path ÚNICO antes de retornar (rename de
            // metadatos, barato y síncrono) y borra ESE en background. Así un
            // re-login a la MISMA cuenta que recrea el path canónico no puede ser
            // borrado por este `removeItem` tardío (carrera que perdía el snapshot
            // recién escrito de la nueva sesión).
            let graveyard = dir.deletingLastPathComponent()
                .appendingPathComponent(".deleting-\(UUID().uuidString)", isDirectory: true)
            let target = ((try? fm.moveItem(at: dir, to: graveyard)) != nil) ? graveyard : dir
            Task.detached(priority: .utility) {
                try? fm.removeItem(at: target)
            }
        }
        currentNamespace = nil
        namespaceDir = nil
    }

    /// Borra solo el disco del namespace activo (conserva memoria y config).
    /// Útil para un "Vaciar caché" sin desloguear.
    func clearDisk() {
        cancelPendingWrites()
        guard let dir = namespaceDir else { return }
        Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: dir)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    // MARK: - Escritura debounced

    private func scheduleWrite(key: String, data: Data) {
        pendingWrites[key]?.cancel()
        guard let dir = namespaceDir else { return }
        let url = dir.appendingPathComponent(Self.encodeKey(key) + ".json")

        pendingWrites[key] = Task { [weak self] in
            try? await Task.sleep(for: Self.writeDebounce)
            if Task.isCancelled { return }
            await Self.writeToDisk(url: url, data: data)
            self?.pendingWrites[key] = nil
        }
    }

    private func cancelPendingWrites() {
        for task in pendingWrites.values { task.cancel() }
        pendingWrites.removeAll()
    }

    /// Escritura atómica fuera del `@MainActor`. Best-effort.
    private static func writeToDisk(url: URL, data: Data) async {
        await Task.detached(priority: .utility) {
            let fm = FileManager.default
            try? fm.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: url, options: .atomic)
        }.value
    }

    // MARK: - Rutas y saneo

    /// `<Caches>/ristak-snapshot-cache-v1/`. Datos regenerables → Caches (no
    /// cuenta para el backup de iCloud); paridad con `ChatInboxDiskCache`.
    private static func rootDirectory() -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("ristak-snapshot-cache-\(storeVersion)", isDirectory: true)
    }

    private static func sanitize(_ value: String) -> String {
        let cleaned = value.unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-" || $0 == "_" ? String($0) : "-" }
            .joined()
        let trimmed = String(cleaned.prefix(120))
        return trimmed.isEmpty ? "default" : trimmed
    }

    // MARK: - Nombre de archivo reversible (base64url del key)

    /// El nombre de archivo codifica la clave completa de forma REVERSIBLE
    /// (base64url), así la precarga reconstruye la clave original sin manifiesto
    /// ni sobre-encapsulado del valor.
    nonisolated private static func encodeKey(_ key: String) -> String {
        Data(key.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    nonisolated private static func decodeKey(_ encoded: String) -> String? {
        var base64 = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder != 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: base64) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - Codecs

    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()
}

// MARK: - Claves canónicas de caché

/// Llaves canónicas para que las 5 features cacheen de forma consistente
/// (`tipo:params`). Usa estos builders para no colisionar entre pantallas y
/// para que el namespaceado por cuenta sea la ÚNICA dimensión de aislamiento.
///
/// Convención: `"<dominio>:<sub>:<param1>:<param2>"`. Params ya normalizados
/// (p. ej. rango `"30d"`, fuente `"all"`, mes `"2026-07"`).
enum RistakCacheKey {
    // Config global (lo escribe `AppConfigStore`; las features solo LEEN).
    static let appConfig = "config:app"
    static let userConfig = "config:user"
    static let timezone = "config:timezone"

    // Analíticas.
    static func analyticsFinancial(range: String, source: String) -> String {
        "analytics:financial:\(range):\(source)"
    }
    static func analyticsSeries(range: String, source: String) -> String {
        "analytics:series:\(range):\(source)"
    }

    // Pagos.
    static func paymentsRecent(range: String) -> String { "payments:recent:\(range)" }
    static let paymentsGateways = "capabilities:payments:gateways"

    // Calendario.
    static let calendarList = "calendar:list"
    static func calendarEvents(month: String) -> String { "calendar:events:\(month)" }

    // Chats (la bandeja ya cachea aparte en `ChatInboxDiskCache`; esto es para
    // metadatos/derivados que una pantalla quiera pintar al instante).
    static func chatConversation(contactID: String) -> String { "chat:conversation:\(contactID)" }

    // Agente conversacional (Hub del chat: activar/pausar/editar agentes).
    static let conversationalAgents = "conversational-agent:agents"
    static let conversationalAgentConfig = "conversational-agent:config"
    static let conversationalAgentAvailability = "capabilities:ai-agent:availability"

    // Señales de capacidad transversales (integraciones / features de plan).
    static let integrations = "capabilities:integrations"
}
