import Foundation
import SwiftUI

// Modelos de estado del composer (doc research/05 §7).

// MARK: - Canal de envío

/// Canal activo del composer (doc 05 §7.1). WhatsApp lleva el número de
/// negocio elegido; Messenger/Instagram son Meta nativo (texto y audio);
/// SMS sale por HighLevel (`sms_qr`).
enum ComposerChannel: Hashable, Identifiable, Sendable {
    case whatsapp(phoneNumberId: String)
    case messenger
    case instagram
    case sms

    var id: String {
        switch self {
        case .whatsapp(let phoneId): return "whatsapp-\(phoneId)"
        case .messenger: return "messenger"
        case .instagram: return "instagram"
        case .sms: return "sms"
        }
    }

    var isWhatsApp: Bool {
        if case .whatsapp = self { return true }
        return false
    }

    var isMetaSocial: Bool {
        self == .messenger || self == .instagram
    }

    var metaPlatform: MetaSocialPlatform? {
        switch self {
        case .messenger: return .messenger
        case .instagram: return .instagram
        default: return nil
        }
    }

    /// Badge visual del canal para el botón del composer.
    var badgeChannel: RistakChatChannel {
        switch self {
        case .whatsapp: return .whatsapp
        case .messenger: return .messenger
        case .instagram: return .instagram
        case .sms: return .whatsapp
        }
    }
}

/// Opción del sheet «Elegir canal de envío» con razón de deshabilitado.
struct ComposerChannelOption: Identifiable {
    let channel: ComposerChannel
    let title: String
    let subtitle: String
    /// nil = habilitada; texto = razón exacta de deshabilitado (doc 05 §7.1).
    let disabledReason: String?

    var id: String { channel.id }
}

// MARK: - Borradores de adjuntos

/// Adjunto preparado en el tray del composer (límite 4, doc 12 §7).
struct ComposerAttachmentDraft: Identifiable, Sendable {
    let id: String
    let media: EncodedChatMedia
    /// Miniatura local (solo imágenes/videos con preview disponible).
    let previewImage: UIImage?

    var kind: ChatMediaKind { media.kind }
    var filename: String { media.filename }
}

// MARK: - Alertas / sheets

/// Alerta simple del módulo (título + mensaje del backend/copys exactos).
struct ConversationAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

/// Estado del sheet «Programar mensaje» (crear o editar — upsert por id).
struct ScheduleSheetState: Identifiable {
    let id = UUID()
    /// Presente = editando una programación existente.
    var editingId: String?
    var externalId: String?
    var text: String
    var date: Date

    /// Envoltura del mensaje ORIGINAL cuando se edita: se conserva tal cual
    /// para no corromper plantillas / HighLevel al reprogramar (un edit no debe
    /// convertir en `whatsapp_api` + `text` un mensaje que era template o GHL).
    /// `nil` al crear (se usan los valores por defecto de WhatsApp API texto).
    var origin: Origin?

    struct Origin {
        var provider: String
        var channel: String
        var transport: String
        var messageType: String
        var templateId: String
        var templateName: String
        var templateLanguage: String
        var templateComponents: RistakJSONValue?
        var templateVariables: RistakJSONValue?
        // Enrutamiento original: al editar solo cambian texto y hora; los
        // teléfonos y el número de negocio se reutilizan tal cual.
        var toPhone: String
        var fromPhone: String
        var businessPhoneNumberId: String
    }
}

/// Capacidad de reacción por canal (doc 04 §5).
enum ReactionCapability {
    /// WhatsApp API/QR: los 5 emojis.
    case whatsapp
    /// Messenger/Instagram: SOLO ❤️.
    case metaHeartOnly
    /// Canal sin reacción (comentarios, HighLevel, email) o sin id remoto.
    case blocked(title: String, message: String)

    /// Tira de emojis del picker (doc 04 §5).
    static let whatsappEmojis = ["❤️", "👍", "😂", "😮", "🙏"]

    var emojis: [String] {
        switch self {
        case .whatsapp: return Self.whatsappEmojis
        case .metaHeartOnly: return ["❤️"]
        case .blocked: return []
        }
    }
}
