import Foundation

/// Frame SSE crudo: nombre del evento + `data` (múltiples líneas `data:` se
/// unen con `\n`, como manda el protocolo).
struct RistakServerSentEvent: Sendable {
    let name: String?
    let data: String
}

/// Parser incremental del protocolo SSE (doc research/11 §2.2):
/// - Campos `event:` / `data:`; líneas comentario `:` (heartbeats) se ignoran.
/// - `id:` / `retry:` se ignoran (el backend no soporta replay).
/// - El frame se despacha en la línea en blanco.
struct RistakSSEFrameParser {
    private var lineBuffer: [UInt8] = []
    private var eventName: String?
    private var dataLines: [String] = []

    /// Consume un byte del stream; devuelve un evento completo si el byte
    /// cierra un frame.
    mutating func consume(_ byte: UInt8) -> RistakServerSentEvent? {
        guard byte == 0x0A else { // \n
            lineBuffer.append(byte)
            return nil
        }
        var line = String(decoding: lineBuffer, as: UTF8.self)
        lineBuffer.removeAll(keepingCapacity: true)
        if line.hasSuffix("\r") { line.removeLast() }
        return handle(line: line)
    }

    private mutating func handle(line: String) -> RistakServerSentEvent? {
        if line.isEmpty {
            defer {
                eventName = nil
                dataLines = []
            }
            guard !dataLines.isEmpty || eventName != nil else { return nil }
            return RistakServerSentEvent(name: eventName, data: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") {
            // Comentario/heartbeat (`: heartbeat <epoch>`): solo actividad.
            return nil
        }
        if let value = fieldValue(of: "event", in: line) {
            eventName = value
            return nil
        }
        if let value = fieldValue(of: "data", in: line) {
            dataLines.append(value)
            return nil
        }
        // `id:`, `retry:` u otros campos: ignorar.
        return nil
    }

    private func fieldValue(of field: String, in line: String) -> String? {
        guard line.hasPrefix("\(field):") else {
            return line == field ? "" : nil
        }
        var value = String(line.dropFirst(field.count + 1))
        if value.hasPrefix(" ") { value.removeFirst() }
        return value
    }
}

/// Motor SSE genérico sobre `URLSession.bytes` (doc research/11 §2):
/// - Request autenticado del `APIClient` (`Authorization: Bearer`,
///   `Accept: text/event-stream`).
/// - Reconexión con backoff exponencial 1 s → 15 s; reset al conectar.
/// - Watchdog implícito: timeout de request 60 s (heartbeats cada 25 s lo
///   resetean; conexión muerta ⇒ error ⇒ reconexión).
/// - 401/403 detienen el stream permanentemente (sesión/permiso inválidos).
/// - El `id` del backend NO permite replay: eventos perdidos se recuperan por
///   el polling de reconciliación, no aquí.
actor RistakSSEStreamEngine {
    private static let initialReconnectDelay: TimeInterval = 1
    private static let maxReconnectDelay: TimeInterval = 15

    /// `URLSession` COMPARTIDO entre todos los engines. Antes cada engine creaba
    /// el suyo y `stop()` solo cancelaba la tarea (nunca `invalidate`), así que
    /// abrir muchos chats iba dejando `URLSession` sin liberar (fuga lenta). No se
    /// puede invalidar en `stop()` porque el mismo engine hace start/stop en cada
    /// cambio de escena; compartir uno estable elimina la fuga sin romper el
    /// reinicio. Sin delegate → seguro de compartir.
    private nonisolated static let sharedSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    private let path: String
    private let session: URLSession
    private var activeTask: Task<Void, Never>?
    private var isStopped = false

    init(path: String) {
        self.path = path
        session = Self.sharedSession
    }

    /// Arranca (o reinicia) la conexión y devuelve el stream de frames.
    /// Un solo consumidor por stream; cancelar el consumo corta la conexión.
    func start() -> AsyncStream<RistakServerSentEvent> {
        activeTask?.cancel()
        isStopped = false

        let (stream, continuation) = AsyncStream<RistakServerSentEvent>.makeStream()
        let task = Task { await run(continuation: continuation) }
        activeTask = task
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    /// Detiene la conexión y la reconexión.
    func stop() {
        isStopped = true
        activeTask?.cancel()
        activeTask = nil
    }

    private func run(continuation: AsyncStream<RistakServerSentEvent>.Continuation) async {
        defer { continuation.finish() }
        var delay = Self.initialReconnectDelay

        while !Task.isCancelled && !isStopped {
            do {
                let request = try await APIClient.shared.authorizedRequest(
                    for: path,
                    accept: "text/event-stream",
                    timeout: 60
                )
                let (bytes, response) = try await session.bytes(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if http.statusCode == 401 || http.statusCode == 403 {
                    // Sesión inválida o sin permiso de módulo: no reintentar.
                    return
                }
                guard http.statusCode == 200 else {
                    throw URLError(.badServerResponse)
                }

                // Conexión abierta: resetear backoff.
                delay = Self.initialReconnectDelay

                var parser = RistakSSEFrameParser()
                for try await byte in bytes {
                    if Task.isCancelled || isStopped { return }
                    if let event = parser.consume(byte) {
                        continuation.yield(event)
                    }
                }
                // Fin del stream sin error: reconectar tras el backoff.
            } catch is CancellationError {
                return
            } catch {
                // Error de red/timeout: caer al backoff.
            }

            if Task.isCancelled || isStopped { return }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            delay = min(delay * 2, Self.maxReconnectDelay)
        }
    }
}
