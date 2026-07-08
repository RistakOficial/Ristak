import SwiftUI

/// Avatar de contacto: foto vía `AsyncImage` con fallback de iniciales sobre
/// color determinístico, y slot opcional de badge de canal (esquina inferior
/// derecha, separado con aro del color de fondo).
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
                        .padding(1.5)
                        .background(Circle().fill(RistakTheme.bg))
                        .offset(x: size * 0.08, y: size * 0.08)
                }
            }
            .accessibilityLabel(name.isEmpty ? "Contacto" : name)
    }

    private var badgeSize: CGFloat {
        max(14, size * 0.38)
    }

    @ViewBuilder
    private var avatarContent: some View {
        if let photoURL {
            AsyncImage(url: photoURL) { phase in
                if let image = phase.image {
                    image
                        .resizable()
                        .scaledToFill()
                } else {
                    initialsFallback
                }
            }
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
