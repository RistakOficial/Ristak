import SwiftUI
import UIKit

/// Fondo del hilo de conversación (paridad mobile/ `ChatWallpaper`):
/// una capa base sólida + el patrón `chat-wallpaper.webp` renderizado como
/// silueta monocroma tintada (igual que `tintColor` en React Native), a media
/// opacidad para que las burbujas sigan legibles.
///
/// - Base: `chatWallpaperBase` (#f5f5f7 claro / #050506 oscuro).
/// - Tinte: `chatWallpaperTint` (#6e6e73 / #c7c7cc), opacidad 0.82 claro / 0.5 oscuro.
/// - `scaledToFill` + `clipped` + `ignoresSafeArea` (full-bleed).
/// - Respeta *Reducir transparencia*: oculta el patrón y deja la base sólida.
struct ChatWallpaperBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        RistakTheme.chatWallpaperBase
            .overlay {
                if !reduceTransparency, let image = Self.wallpaperImage {
                    Image(uiImage: image)
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .foregroundStyle(RistakTheme.chatWallpaperTint)
                        .opacity(colorScheme == .dark ? 0.5 : 0.82)
                        .clipped()
                        .allowsHitTesting(false)
                }
            }
            .clipped()
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }

    // MARK: - Carga y caché

    @MainActor private static var cached: UIImage?

    @MainActor
    static var wallpaperImage: UIImage? {
        if let cached { return cached }
        guard let path = wallpaperPath(),
              let image = UIImage(contentsOfFile: path) else {
            return nil
        }
        cached = image
        return image
    }

    /// Los grupos sincronizados pueden copiar el recurso con o sin la carpeta
    /// `Resources/`; probamos las rutas conocidas del bundle.
    private static func wallpaperPath() -> String? {
        let bundle = Bundle.main
        let candidates = [
            bundle.path(forResource: "chat-wallpaper", ofType: "webp"),
            bundle.path(forResource: "chat-wallpaper", ofType: "webp", inDirectory: "Resources"),
        ]
        return candidates.compactMap { $0 }.first
    }
}
