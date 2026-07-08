import Foundation
import UIKit

/// Cargador de imágenes remotas del chat (fotos de perfil, media del CDN
/// público de Bunny, previews) con caché en MEMORIA (NSCache) y DISCO
/// (URLCache propio). Las URLs de media de mensajes son públicas y cacheables
/// para siempre (doc 12 §1); no requieren headers de auth.
actor RistakImageLoader {
    static let shared = RistakImageLoader()

    private let memoryCache: NSCache<NSURL, UIImage>
    private let diskCache: URLCache
    private let session: URLSession
    private var inFlight: [URL: Task<UIImage, Error>] = [:]

    enum LoadFailure: LocalizedError {
        case invalidImageData
        case badStatus(Int)

        var errorDescription: String? {
            switch self {
            case .invalidImageData:
                return "No se pudo leer la imagen descargada."
            case .badStatus(let status):
                return "No se pudo descargar la imagen (HTTP \(status))."
            }
        }
    }

    init() {
        let cache = NSCache<NSURL, UIImage>()
        cache.countLimit = 400
        // Costo aproximado en bytes decodificados (~64 MB).
        cache.totalCostLimit = 64 * 1024 * 1024
        memoryCache = cache

        diskCache = URLCache(
            memoryCapacity: 16 * 1024 * 1024,
            diskCapacity: 256 * 1024 * 1024,
            diskPath: "ristak-chat-images"
        )
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = diskCache
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.timeoutIntervalForRequest = 30
        configuration.httpMaximumConnectionsPerHost = 6
        session = URLSession(configuration: configuration)
    }

    /// Imagen ya cacheada en memoria (sin red), para pintado síncrono.
    func cachedImage(for url: URL) -> UIImage? {
        memoryCache.object(forKey: url as NSURL)
    }

    /// Descarga (o lee de caché) la imagen. Deduplica peticiones en vuelo a
    /// la misma URL.
    func image(for url: URL) async throws -> UIImage {
        if let cached = memoryCache.object(forKey: url as NSURL) {
            return cached
        }
        if let existing = inFlight[url] {
            return try await existing.value
        }

        let task = Task<UIImage, Error> { [session] in
            var request = URLRequest(url: url)
            request.cachePolicy = .returnCacheDataElseLoad
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw LoadFailure.badStatus(http.statusCode)
            }
            guard let image = UIImage(data: data) else {
                throw LoadFailure.invalidImageData
            }
            return image
        }
        inFlight[url] = task
        defer { inFlight[url] = nil }

        do {
            let image = try await task.value
            let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
            memoryCache.setObject(image, forKey: url as NSURL, cost: cost)
            return image
        } catch {
            throw error
        }
    }

    /// Variante tolerante: nil en lugar de error (para avatares opcionales).
    func imageIfAvailable(for url: URL) async -> UIImage? {
        try? await image(for: url)
    }

    /// Pre-calienta la caché (p. ej. avatares de la primera página de la bandeja).
    func prefetch(_ urls: [URL]) {
        for url in urls {
            guard memoryCache.object(forKey: url as NSURL) == nil, inFlight[url] == nil else { continue }
            Task { _ = await self.imageIfAvailable(for: url) }
        }
    }

    /// Limpia ambas cachés (logout).
    func removeAll() {
        memoryCache.removeAllObjects()
        diskCache.removeAllCachedResponses()
        inFlight.removeAll()
    }
}
