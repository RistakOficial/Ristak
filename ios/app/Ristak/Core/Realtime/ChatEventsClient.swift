import Foundation

/// Payload del evento SSE `chat_message` (doc research/11 §2.3). Todos los
/// campos viajan como strings «limpiados»; `isNew` default `true`.
struct ChatMessageRealtimeEvent: Decodable, Sendable, Equatable {
    let type: String
    /// Siempre presente y no vacío en eventos válidos.
    let contactId: String
    let messageId: String
    let channel: String
    let provider: String
    let transport: String
    /// `inbound | outbound`.
    let direction: String
    let messageType: String
    let messageTimestamp: String
    /// `false` cuando es actualización de un mensaje existente.
    let isNew: Bool
    let receivedAt: String

    enum CodingKeys: String, CodingKey {
        case type, contactId, messageId, channel, provider, transport
        case direction, messageType, messageTimestamp, isNew, receivedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = container.flexibleString(forKey: .type) ?? ""
        contactId = container.flexibleString(forKey: .contactId) ?? ""
        messageId = container.flexibleString(forKey: .messageId) ?? ""
        channel = container.flexibleString(forKey: .channel) ?? ""
        provider = container.flexibleString(forKey: .provider) ?? ""
        transport = container.flexibleString(forKey: .transport) ?? ""
        direction = container.flexibleString(forKey: .direction) ?? ""
        messageType = container.flexibleString(forKey: .messageType) ?? ""
        messageTimestamp = container.flexibleString(forKey: .messageTimestamp) ?? ""
        isNew = container.flexibleBool(forKey: .isNew) ?? true
        receivedAt = container.flexibleString(forKey: .receivedAt) ?? ""
    }
}

/// Evento tipado del stream de chat.
enum ChatRealtimeEvent: Sendable {
    /// Evento inicial `connected` (`{ connected: true, serverTime }`).
    case connected(serverTime: String?)
    /// `chat_message` — es solo un «nudge»: NO trae texto; disparar refresh
    /// REST coalescido de bandeja/hilo (merge por id).
    case message(ChatMessageRealtimeEvent)

    /// Mapea un frame SSE crudo; frames desconocidos/incompletos → nil.
    init?(frame: RistakServerSentEvent) {
        switch frame.name {
        case "connected":
            let payload = try? JSONDecoder().decode(
                ChatConnectedFramePayload.self,
                from: Data(frame.data.utf8)
            )
            self = .connected(serverTime: payload?.serverTime)
        case "chat_message":
            guard
                let payload = try? JSONDecoder().decode(
                    ChatMessageRealtimeEvent.self,
                    from: Data(frame.data.utf8)
                ),
                payload.type == "chat_message",
                !payload.contactId.isEmpty
            else { return nil }
            self = .message(payload)
        default:
            return nil
        }
    }
}

/// Payload del evento `connected` de ambos streams SSE.
struct ChatConnectedFramePayload: Decodable, Sendable {
    let connected: Bool
    let serverTime: String?

    enum CodingKeys: String, CodingKey {
        case connected, serverTime
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connected = container.flexibleBool(forKey: .connected) ?? false
        serverTime = container.flexibleString(forKey: .serverTime)
    }
}

/// Cliente SSE de chat — `GET /api/chat-events/stream` (doc research/11 §2).
/// Requiere sesión + módulo `chat` (403 detiene el stream). Broadcast global:
/// avisa de TODOS los contactos; usarlo únicamente para disparar refresh.
/// El polling de reconciliación (12 s bandeja / 4 s hilo) NO es opcional:
/// los eventos perdidos en reconexión no se re-entregan.
final class ChatEventsClient: Sendable {
    private let engine = RistakSSEStreamEngine(path: "/api/chat-events/stream")

    init() {}

    /// Arranca (o reinicia) la conexión. Reconexión 1 s→15 s automática;
    /// se detiene sola ante 401/403.
    func start() async -> AsyncStream<ChatRealtimeEvent> {
        let frames = await engine.start()
        let (stream, continuation) = AsyncStream<ChatRealtimeEvent>.makeStream()
        let task = Task {
            for await frame in frames {
                if let event = ChatRealtimeEvent(frame: frame) {
                    continuation.yield(event)
                }
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    /// Corta la conexión (background/logout). Volver a llamar `start()` para
    /// reconectar en foreground.
    func stop() async {
        await engine.stop()
    }
}
