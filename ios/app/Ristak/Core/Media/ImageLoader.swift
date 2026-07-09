import Foundation
import ImageIO
import UIKit

/// Cargador de imágenes remotas del chat (fotos de perfil, media del CDN
/// público de Bunny, previews) con caché en MEMORIA (NSCache) y DISCO
/// (URLCache propio). Las URLs de media de mensajes son públicas y cacheables
/// para siempre (doc 12 §1); no requieren headers de auth.
actor RistakImageLoader {
    static let shared = RistakImageLoader()

    /// `nonisolated`: NSCache es thread-safe, así que la lectura de memoria no
    /// necesita cruzar al actor. Esto permite que una vista SwiftUI siembre su
    /// `@State` de forma SÍNCRONA en el primer frame (cero parpadeo si ya está
    /// cacheada). Las mutaciones (`setObject`) siguen ocurriendo solo desde
    /// métodos aislados del actor, así que no hay carrera de escritura.
    /// `nonisolated(unsafe)` porque `NSCache` está sincronizado internamente
    /// (thread-safe) pero no está marcado `Sendable` en el SDK.
    private nonisolated(unsafe) let memoryCache: NSCache<NSURL, UIImage>
    /// Caché aparte (pequeña) para la resolución NATIVA del visor con zoom: así el
    /// full-res no compite con las miniaturas por el presupuesto de memoria.
    private nonisolated(unsafe) let fullResCache: NSCache<NSURL, UIImage>
    private let diskCache: URLCache
    private let session: URLSession
    private var inFlight: [URL: Task<UIImage, Error>] = [:]
    private var fullResInFlight: [URL: Task<UIImage, Error>] = [:]

    /// Lado máximo (px) al que se reduce la imagen para burbujas/avatares. Muy por
    /// encima del tamaño de presentación (burbuja ~318 pt, avatar ~54 pt), así que
    /// la calidad es perfecta pero una foto de 12 MP deja de ocupar ~48 MB en RAM.
    private static let displayMaxPixelSize = 1536

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

        let fullCache = NSCache<NSURL, UIImage>()
        fullCache.countLimit = 6
        fullCache.totalCostLimit = 96 * 1024 * 1024
        fullResCache = fullCache

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

    /// Imagen ya cacheada en memoria (sin red), para pintado síncrono. `nonisolated`
    /// para poder leerse sin `await` desde el `init`/`body` de una vista SwiftUI.
    nonisolated func cachedImage(for url: URL) -> UIImage? {
        memoryCache.object(forKey: url as NSURL)
    }

    /// Descarga (o lee de caché) la imagen ya REDUCIDA a un tamaño de presentación
    /// y DECODIFICADA fuera del hilo principal — antes `UIImage(data:)` conservaba
    /// los bytes comprimidos y decodificaba PEREZOSAMENTE en el commit de render
    /// (main) al dibujarse, causando el hitch de scroll; y cacheaba a resolución
    /// nativa, así que 1-2 fotos grandes reventaban el presupuesto y evictaban los
    /// avatares. Deduplica peticiones en vuelo a la misma URL.
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
            // Decode + downsample en el executor del actor (background), NO en main.
            guard let image = Self.downsampledImage(from: data, maxPixelSize: Self.displayMaxPixelSize) else {
                throw LoadFailure.invalidImageData
            }
            return image
        }
        inFlight[url] = task
        defer { inFlight[url] = nil }

        let image = try await task.value
        // Coste = bytes REALES del bitmap reducido (no el nativo), para que el
        // presupuesto de 64 MB no evicte los avatares al cargar fotos grandes.
        memoryCache.setObject(image, forKey: url as NSURL, cost: Self.bitmapCost(image))
        return image
    }

    /// Variante tolerante: nil en lugar de error (para avatares opcionales).
    func imageIfAvailable(for url: URL) async -> UIImage? {
        try? await image(for: url)
    }

    /// Imagen a RESOLUCIÓN NATIVA para el visor con zoom (no se reduce). Se
    /// descomprime fuera de main con `preparingForDisplay()` y se cachea en una
    /// NSCache pequeña aparte para no competir con las miniaturas.
    func fullImage(for url: URL) async throws -> UIImage {
        if let cached = fullResCache.object(forKey: url as NSURL) {
            return cached
        }
        if let existing = fullResInFlight[url] {
            return try await existing.value
        }

        let task = Task<UIImage, Error> { [session] in
            var request = URLRequest(url: url)
            request.cachePolicy = .returnCacheDataElseLoad
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw LoadFailure.badStatus(http.statusCode)
            }
            guard let raw = UIImage(data: data) else {
                throw LoadFailure.invalidImageData
            }
            return raw.preparingForDisplay() ?? raw
        }
        fullResInFlight[url] = task
        defer { fullResInFlight[url] = nil }

        let image = try await task.value
        fullResCache.setObject(image, forKey: url as NSURL, cost: Self.bitmapCost(image))
        return image
    }

    /// Variante tolerante del full-res (para el visor).
    func fullImageIfAvailable(for url: URL) async -> UIImage? {
        try? await fullImage(for: url)
    }

    // MARK: - Decode / downsample (off-main)

    /// Reduce los bytes a un `UIImage` con lado máximo `maxPixelSize`, YA
    /// decodificado (`kCGImageSourceShouldCacheImmediately`) y con la orientación
    /// EXIF aplicada. Devuelve nil si los datos no son una imagen.
    private static func downsampledImage(from data: Data, maxPixelSize: Int) -> UIImage? {
        let sourceOptions: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary) else {
            return UIImage(data: data)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return UIImage(data: data)
        }
        return UIImage(cgImage: cg)
    }

    /// Coste real (bytes) del bitmap decodificado, para el presupuesto de NSCache.
    private static func bitmapCost(_ image: UIImage) -> Int {
        guard let cg = image.cgImage else {
            return Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        }
        return cg.bytesPerRow * cg.height
    }

    /// Pre-calienta la caché (p. ej. avatares de la primera página de la bandeja).
    func prefetch(_ urls: [URL]) {
        for url in urls {
            guard memoryCache.object(forKey: url as NSURL) == nil, inFlight[url] == nil else { continue }
            Task { _ = await self.imageIfAvailable(for: url) }
        }
    }

    /// Limpia todas las cachés (logout).
    func removeAll() {
        memoryCache.removeAllObjects()
        fullResCache.removeAllObjects()
        diskCache.removeAllCachedResponses()
        inFlight.removeAll()
        fullResInFlight.removeAll()
    }
}
