import SwiftUI
import UIKit

/// Canal de mensajería con badge visual (assets WebP rellenos 72×72 en
/// `Resources/channel-badges/`). Regla de marca (doc 14 §2.4): el color social
/// del contacto vive SOLO en este badge, nunca como aro/relleno del avatar.
enum RistakChatChannel: String, CaseIterable, Sendable {
    case whatsapp
    case facebook
    case messenger
    case instagram
    case gmail

    /// Mapea el identificador crudo del backend (`whatsapp`, `instagram`,
    /// `facebook_comment`, `email`…) al badge correspondiente.
    init?(raw: String?) {
        guard let raw else { return nil }
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return nil }

        if normalized.contains("whatsapp") || normalized == "wa" {
            self = .whatsapp
        } else if normalized.contains("messenger") {
            self = .messenger
        } else if normalized.contains("instagram") || normalized == "ig" {
            self = .instagram
        } else if normalized.contains("facebook") || normalized == "fb" {
            self = .facebook
        } else if normalized.contains("mail") || normalized == "email" || normalized == "gmail" {
            self = .gmail
        } else {
            return nil
        }
    }

    /// Nombre del archivo WebP (sin extensión) dentro de `channel-badges/`.
    var assetFileName: String { rawValue }
}

/// Badge del canal (WhatsApp/Facebook/Messenger/Instagram/Gmail) como ícono
/// libre: se pinta el WebP crudo tal cual, SIN contenedor circular, aro, borde,
/// fondo ni recorte. Los assets ya traen su forma propia (p. ej. la colita del
/// globo de WhatsApp) — cualquier `clipShape` la mutilaría. Paridad con mobile/
/// (`ChannelAvatarBadgeIcon`, `resizeMode="contain"`).
///
/// Carga los WebP del bundle vía `UIImage(contentsOfFile:)` con caché estática.
/// Se usa igual en filas de bandeja, header de conversación e info de contacto.
struct ChannelBadgeView: View {
    let channel: RistakChatChannel
    var size: CGFloat = 22

    var body: some View {
        if let image = Self.badgeImage(for: channel) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }

    // MARK: - Carga y caché

    @MainActor private static var cache: [RistakChatChannel: UIImage] = [:]

    @MainActor
    static func badgeImage(for channel: RistakChatChannel) -> UIImage? {
        if let cached = cache[channel] { return cached }
        guard let path = badgePath(fileName: channel.assetFileName),
              let image = UIImage(contentsOfFile: path) else {
            return nil
        }
        cache[channel] = image
        return image
    }

    /// Los grupos sincronizados pueden copiar los recursos con o sin la
    /// jerarquía de carpetas; probamos las rutas conocidas.
    private static func badgePath(fileName: String) -> String? {
        let bundle = Bundle.main
        let candidates = [
            bundle.path(forResource: fileName, ofType: "webp", inDirectory: "channel-badges"),
            bundle.path(forResource: fileName, ofType: "webp", inDirectory: "Resources/channel-badges"),
            bundle.path(forResource: fileName, ofType: "webp"),
        ]
        return candidates.compactMap { $0 }.first
    }
}
