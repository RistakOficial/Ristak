import Foundation

// Contrato exacto: docs/research/12-media.md (+ ARCHITECTURE.md §Media).
// Los envíos de chat viajan como data URL base64 en JSON — no hay multipart.

/// Tipo de media de chat.
enum ChatMediaKind: String, Sendable, CaseIterable {
    case image
    case video
    case audio
    case document

    /// Etiqueta humana en español (mensajes de validación estilo RN).
    var spanishLabel: String {
        switch self {
        case .image: return "La foto"
        case .video: return "El video"
        case .audio: return "El audio"
        case .document: return "El documento"
        }
    }
}

/// Límites de entrada por tipo (backend `whatsappApiService.js`, doc 12 §3):
/// imagen 25 MB (JPG/PNG/WebP), video 25 MB (MP4/MOV/WebM/3GP), audio 16 MB,
/// documento 20 MB. Máx 4 adjuntos por mensaje (paridad RN).
enum ChatMediaLimits {
    static let imageMaxBytes = 25 * 1024 * 1024
    static let videoMaxBytes = 25 * 1024 * 1024
    static let audioMaxBytes = 16 * 1024 * 1024
    static let documentMaxBytes = 20 * 1024 * 1024
    /// Tope acumulado del tray. Cuatro adjuntos al maximo del proveedor pueden
    /// superar 130 MB ya convertidos a base64 y provocar jetsam en un iPhone.
    static let draftTotalMaxBytes = 40 * 1024 * 1024
    /// `CONVERSATION_ATTACHMENT_LIMIT` de RN.
    static let maxDraftAttachments = 4
    /// Grabación de voz: duración mínima (RN: 600 ms).
    static let minVoiceNoteDurationMs: Double = 600

    static func maxBytes(for kind: ChatMediaKind) -> Int {
        switch kind {
        case .image: return imageMaxBytes
        case .video: return videoMaxBytes
        case .audio: return audioMaxBytes
        case .document: return documentMaxBytes
        }
    }

    /// MIME de imagen que el backend acepta SIN conversión (HEIC no está:
    /// convertir a JPEG antes).
    static let allowedImageMimeTypes: Set<String> = ["image/jpeg", "image/jpg", "image/png", "image/webp"]
    /// MIME de video aceptados.
    static let allowedVideoMimeTypes: Set<String> = ["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/3gp"]
    /// MIME de audio aceptados (`video/mp4` incluido: iOS envuelve grabaciones
    /// de micrófono en contenedor MP4 — el backend lo transcodifica).
    static let allowedAudioMimeTypes: Set<String> = [
        "audio/aac", "audio/amr", "audio/mp4", "audio/mpeg", "audio/ogg",
        "audio/webm", "audio/wav", "audio/x-wav", "video/mp4",
    ]
    /// MIME de documento aceptados.
    static let allowedDocumentMimeTypes: Set<String> = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/plain",
        "text/csv",
    ]
}

/// Resultado de codificar un archivo para enviarlo por chat.
struct EncodedChatMedia: Sendable {
    let kind: ChatMediaKind
    /// `data:<mime>;base64,<...>` — listo para `imageDataUrl`/`videoDataUrl`/etc.
    let dataUrl: String
    let mimeType: String
    let filename: String
    /// Bytes del binario original (sin overhead base64).
    let sizeBytes: Int
    /// Solo audio: duración medida por el cliente.
    let durationMs: Double?
}

/// Errores de preparación de media, con los mensajes EXACTOS en español del
/// backend (doc 12 §3) para validación local equivalente.
enum MediaEncodingError: LocalizedError, Sendable {
    case imageInvalidFormat
    case imageEmpty
    case imageTooLarge
    case videoInvalidFormat
    case videoTooLarge
    case audioInvalidFormat
    case audioTooLarge
    case documentInvalidFormat
    case documentTooLarge
    case unreadableFile(label: String)

    var errorDescription: String? {
        switch self {
        case .imageInvalidFormat:
            return "La foto debe ser JPG, PNG o WebP."
        case .imageEmpty:
            return "La foto está vacía."
        case .imageTooLarge:
            return "La foto pesa demasiado. Toma otra foto más ligera o recórtala antes de enviarla."
        case .videoInvalidFormat:
            return "El video debe ser MP4, MOV, WebM o 3GP para poder prepararlo para WhatsApp."
        case .videoTooLarge:
            return "El video pesa demasiado. Graba uno más corto para poder comprimirlo y enviarlo por WhatsApp."
        case .audioInvalidFormat:
            return "WhatsApp no acepta este formato de audio. Graba otra vez o usa un audio compatible."
        case .audioTooLarge:
            return "El audio pesa demasiado. Graba uno más corto para poder enviarlo por WhatsApp."
        case .documentInvalidFormat:
            return "El archivo debe ser PDF, Word, Excel, PowerPoint, TXT, CSV, audio o video compatible."
        case .documentTooLarge:
            return "El documento pesa demasiado. Elige uno de menos de 20 MB para poder enviarlo por WhatsApp."
        case .unreadableFile(let label):
            return "No pude validar el tamaño de \(label). Intenta con otro archivo."
        }
    }
}
