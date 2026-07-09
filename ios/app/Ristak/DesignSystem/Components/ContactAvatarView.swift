import SwiftUI
import UIKit

/// Avatar de contacto: foto vía `RistakImageLoader` (caché compartida) con
/// fallback de iniciales sobre
/// color determinístico. El avatar es circular; el badge de canal (esquina
/// inferior derecha) se pinta como ícono libre vía `ChannelBadgeView` — SIN aro
/// ni fondo alrededor (paridad mobile/: badge transparente que sobresale un
/// poco del círculo).
struct ContactAvatarView: View {
    let name: String
    var photoURL: URL? = nil
    var size: CGFloat = 44
    var channel: RistakChatChannel? = nil

    var body: some View {
        avatarContent
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay(alignment: .bottomTrailing) {
                if let channel {
                    ChannelBadgeView(channel: channel, size: badgeSize)
                        // Sobresale ligeramente del círculo, como en mobile/
                        // (`avatarChannelBadge`: right -4, bottom -3).
                        .offset(x: size * 0.07, y: size * 0.05)
                }
            }
            .accessibilityLabel(name.isEmpty ? "Contacto" : name)
    }

    /// Badge ≈0.38 del avatar (mobile/: 22pt sobre 58pt), mínimo 18pt.
    private var badgeSize: CGFloat {
        max(18, size * 0.38)
    }

    @ViewBuilder
    private var avatarContent: some View {
        if let photoURL {
            RemoteAvatarImage(url: photoURL) { initialsFallback }
        } else {
            initialsFallback
        }
    }

    private var initialsFallback: some View {
        ZStack {
            LinearGradient(
                colors: [fallbackColor, fallbackColor.opacity(0.78)],
                startPoint: .top,
                endPoint: .bottom
            )
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
        }
    }

    // MARK: - Iniciales

    private var initials: String {
        let words = name
            .split(separator: " ")
            .filter { !$0.isEmpty }
        let letters = words.prefix(2).compactMap { $0.first }
        guard !letters.isEmpty else { return "•" }
        return String(letters).uppercased()
    }

    // MARK: - Color determinístico

    /// Paleta desaturada de fallback (tonos calmados, sin verdes WhatsApp).
    private static let fallbackPalette: [Color] = [
        Color(red: 0.36, green: 0.51, blue: 0.85), // azul
        Color(red: 0.49, green: 0.44, blue: 0.83), // violeta
        Color(red: 0.71, green: 0.41, blue: 0.68), // malva
        Color(red: 0.82, green: 0.47, blue: 0.40), // terracota
        Color(red: 0.75, green: 0.57, blue: 0.29), // ocre
        Color(red: 0.34, green: 0.60, blue: 0.63), // petróleo
        Color(red: 0.55, green: 0.55, blue: 0.60), // gris
        Color(red: 0.45, green: 0.58, blue: 0.44), // salvia
    ]

    private var fallbackColor: Color {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Self.fallbackPalette[6] }
        let index = Int(Self.stableHash(trimmed) % UInt64(Self.fallbackPalette.count))
        return Self.fallbackPalette[index]
    }

    /// FNV-1a: estable entre lanzamientos (a diferencia de `hashValue`).
    private static func stableHash(_ value: String) -> UInt64 {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return hash
    }
}

// MARK: - Foto de avatar con caché compartida

/// Foto de avatar servida por `RistakImageLoader` (NSCache en memoria + URLCache
/// en disco, con dedup de peticiones en vuelo). A diferencia de `AsyncImage` —que
/// mantenía su propia caché aislada y re-descargaba/re-decodificaba en cada
/// reciclaje de fila— aquí:
/// - Se PINTA SÍNCRONO desde memoria en el primer frame si la foto ya se cargó
///   antes (cero parpadeo a iniciales al hacer scroll o cambiar de pantalla).
/// - El `.task` solo cubre el fallo de caché (descarga tolerante, sin error).
/// Salida visual idéntica al `AsyncImage` anterior (misma imagen `scaledToFill`,
/// mismo fallback de iniciales).
private struct RemoteAvatarImage<Fallback: View>: View {
    let url: URL
    @ViewBuilder let fallback: () -> Fallback
    @State private var image: UIImage?

    init(url: URL, @ViewBuilder fallback: @escaping () -> Fallback) {
        self.url = url
        self.fallback = fallback
        _image = State(initialValue: RistakImageLoader.shared.cachedImage(for: url))
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                fallback()
            }
        }
        .task(id: url) {
            // Reciclaje a otra URL: re-siembra de memoria (instantáneo si está
            // cacheada); si no, descarga tolerante en segundo plano.
            if let cached = RistakImageLoader.shared.cachedImage(for: url) {
                if image !== cached { image = cached }
                return
            }
            if image != nil { image = nil }
            image = await RistakImageLoader.shared.imageIfAvailable(for: url)
        }
    }
}
