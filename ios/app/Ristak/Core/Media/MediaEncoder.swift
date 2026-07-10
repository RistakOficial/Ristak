import Foundation
import UIKit
import UniformTypeIdentifiers

/// Prepara media local para los envíos de chat (doc 12): convierte a los
/// formatos que el backend acepta, aplica límites por tipo y produce el
/// data URL base64 que viaja en el JSON (`imageDataUrl`, `videoDataUrl`,
/// `audioDataUrl`, `documentDataUrl`). Errores con los mensajes exactos en
/// español del backend para validación local equivalente.
///
/// Reglas clave:
/// - Imagen: JPG/PNG/WebP ≤25 MB. HEIC/HEIF (y cualquier otro formato
///   decodificable) se CONVIERTE a JPEG antes de enviar — el backend no
///   acepta HEIC.
/// - Video: MP4/MOV/WebM/3GP ≤25 MB (grabar H.264, no HEVC; el backend
///   transcodifica a MP4 ≤16 MB).
/// - Audio: AAC/M4A como `audio/mp4` ≤16 MB (el backend transcodifica a
///   OGG/Opus, formato de nota de voz de WhatsApp).
/// - Documento: PDF/Word/Excel/PowerPoint/TXT/CSV ≤20 MB; filename sanitizado.
enum MediaEncoder {
    /// WhatsApp termina reduciendo las fotos a un tamaño parecido. Hacerlo antes
    /// evita subir 3-8 MB como base64 para que el servidor y WhatsApp vuelvan a
    /// comprimir exactamente lo mismo.
    static let jpegConversionQuality: CGFloat = 0.80
    static let imageMaxPixelDimension: CGFloat = 1_600

    // MARK: Data URL

    /// `data:<mime>;base64,<...>`.
    static func dataURL(from data: Data, mimeType: String) -> String {
        "data:\(mimeType);base64,\(data.base64EncodedString())"
    }

    // MARK: Imagen

    /// Codifica una `UIImage` (cámara/galería) como JPEG listo para
    /// `imageDataUrl`.
    static func encodeImage(_ image: UIImage, filename: String? = nil) throws -> EncodedChatMedia {
        let preparedImage = downscaledChatImage(image)
        guard let jpegData = preparedImage.jpegData(compressionQuality: jpegConversionQuality), !jpegData.isEmpty else {
            throw MediaEncodingError.imageEmpty
        }
        return try validatedImage(data: jpegData, mimeType: "image/jpeg", filename: filename ?? defaultFilename(ext: "jpg"))
    }

    /// Codifica datos de imagen ya cargados (JPG/PNG/WebP/HEIC u otro formato
    /// que UIKit pueda leer), los reduce y los convierte a JPEG.
    static func encodeImageData(_ data: Data, mimeType: String?, filename: String? = nil) throws -> EncodedChatMedia {
        guard !data.isEmpty else { throw MediaEncodingError.imageEmpty }
        // Todas las fotos decodificables pasan por la misma optimización. Antes
        // JPG/PNG/WebP "válidos" saltaban directo y una foto de cámara de varios
        // megapíxeles viajaba completa aunque el backend la redujera después.
        guard let image = UIImage(data: data) else {
            throw MediaEncodingError.imageInvalidFormat
        }
        return try encodeImage(image, filename: jpegFilename(from: filename))
    }

    private static func downscaledChatImage(_ image: UIImage) -> UIImage {
        let width = image.size.width
        let height = image.size.height
        let longestSide = max(width, height)
        guard longestSide > imageMaxPixelDimension, width > 0, height > 0 else {
            return image
        }

        let ratio = imageMaxPixelDimension / longestSide
        let targetSize = CGSize(
            width: max(1, (width * ratio).rounded()),
            height: max(1, (height * ratio).rounded())
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: targetSize, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: targetSize))
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
    }

    /// Codifica un archivo de imagen del disco.
    static func encodeImageFile(at url: URL) throws -> EncodedChatMedia {
        let data = try readFile(at: url, kind: .image)
        return try encodeImageData(data, mimeType: mimeType(forFile: url), filename: url.lastPathComponent)
    }

    private static func validatedImage(data: Data, mimeType: String, filename: String) throws -> EncodedChatMedia {
        guard data.count <= ChatMediaLimits.imageMaxBytes else {
            throw MediaEncodingError.imageTooLarge
        }
        return EncodedChatMedia(
            kind: .image,
            dataUrl: dataURL(from: data, mimeType: mimeType),
            mimeType: mimeType,
            filename: filename,
            sizeBytes: data.count,
            durationMs: nil
        )
    }

    // MARK: Video

    static func encodeVideoFile(at url: URL) throws -> EncodedChatMedia {
        let mime = normalizeMime(mimeType(forFile: url) ?? "video/mp4")
        guard ChatMediaLimits.allowedVideoMimeTypes.contains(mime) else {
            throw MediaEncodingError.videoInvalidFormat
        }
        let data = try readFile(at: url, kind: .video)
        guard data.count <= ChatMediaLimits.videoMaxBytes else {
            throw MediaEncodingError.videoTooLarge
        }
        return EncodedChatMedia(
            kind: .video,
            dataUrl: dataURL(from: data, mimeType: mime),
            mimeType: mime,
            filename: url.lastPathComponent,
            sizeBytes: data.count,
            durationMs: nil
        )
    }

    // MARK: Audio (notas de voz)

    /// Codifica una grabación (m4a/AAC) como `audio/mp4`. `durationMs` la
    /// mide el cliente al grabar — el backend NO la calcula (gap doc 05 §10.15).
    static func encodeAudioFile(at url: URL, durationMs: Double?) throws -> EncodedChatMedia {
        var mime = normalizeMime(mimeType(forFile: url) ?? "audio/mp4")
        // m4a suele resolverse como audio/x-m4a en UTType: el backend espera audio/mp4.
        if mime == "audio/x-m4a" || mime == "audio/m4a" { mime = "audio/mp4" }
        guard ChatMediaLimits.allowedAudioMimeTypes.contains(mime) else {
            throw MediaEncodingError.audioInvalidFormat
        }
        let data = try readFile(at: url, kind: .audio)
        guard data.count <= ChatMediaLimits.audioMaxBytes else {
            throw MediaEncodingError.audioTooLarge
        }
        return EncodedChatMedia(
            kind: .audio,
            dataUrl: dataURL(from: data, mimeType: mime),
            mimeType: mime,
            filename: url.lastPathComponent.isEmpty ? "nota-de-voz.m4a" : url.lastPathComponent,
            sizeBytes: data.count,
            durationMs: durationMs
        )
    }

    // MARK: Documento

    /// Codifica un documento. Acepta también audio/video compatibles
    /// ("mandar como documento", p. ej. video >16 MB).
    static func encodeDocumentFile(at url: URL, mimeTypeOverride: String? = nil) throws -> EncodedChatMedia {
        let mime = normalizeMime(mimeTypeOverride ?? mimeType(forFile: url) ?? "application/octet-stream")
        let isAllowed = ChatMediaLimits.allowedDocumentMimeTypes.contains(mime)
            || ChatMediaLimits.allowedVideoMimeTypes.contains(mime)
            || ChatMediaLimits.allowedAudioMimeTypes.contains(mime)
        guard isAllowed else {
            throw MediaEncodingError.documentInvalidFormat
        }
        let data = try readFile(at: url, kind: .document)
        guard data.count <= ChatMediaLimits.documentMaxBytes else {
            throw MediaEncodingError.documentTooLarge
        }
        return EncodedChatMedia(
            kind: .document,
            dataUrl: dataURL(from: data, mimeType: mime),
            mimeType: mime,
            filename: sanitizedDocumentFilename(url.lastPathComponent, mimeType: mime),
            sizeBytes: data.count,
            durationMs: nil
        )
    }

    /// Sanitiza el filename como el backend (`sanitizeDocumentFilename`):
    /// sin caracteres de control ni `<>:"/\|?*`, máx 180 chars, con extensión
    /// garantizada según el MIME.
    static func sanitizedDocumentFilename(_ name: String, mimeType: String) -> String {
        let forbidden = CharacterSet(charactersIn: "<>:\"/\\|?*").union(.controlCharacters)
        var cleaned = String(name.unicodeScalars.filter { !forbidden.contains($0) })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { cleaned = "archivo" }
        if cleaned.count > 180 { cleaned = String(cleaned.prefix(180)) }
        let hasExtension = !(cleaned as NSString).pathExtension.isEmpty
        if !hasExtension, let ext = fileExtension(forMime: mimeType) {
            cleaned += ".\(ext)"
        }
        return cleaned
    }

    // MARK: Helpers

    private static func readFile(at url: URL, kind: ChatMediaKind) throws -> Data {
        let needsScopedAccess = url.startAccessingSecurityScopedResource()
        defer {
            if needsScopedAccess { url.stopAccessingSecurityScopedResource() }
        }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw MediaEncodingError.unreadableFile(label: kind.spanishLabel.lowercased())
        }
    }

    /// MIME por extensión con `UTType` (fallback nil).
    static func mimeType(forFile url: URL) -> String? {
        let ext = url.pathExtension
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return nil }
        return type.preferredMIMEType
    }

    /// Normaliza un MIME (`"image/jpeg; charset=..."` → `"image/jpeg"`).
    static func normalizeMime(_ value: String?) -> String {
        let raw = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let semicolon = raw.firstIndex(of: ";") else { return raw }
        return String(raw[..<semicolon]).trimmingCharacters(in: .whitespaces)
    }

    static func fileExtension(forMime mime: String) -> String? {
        switch normalizeMime(mime) {
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/png": return "png"
        case "image/webp": return "webp"
        case "video/mp4": return "mp4"
        case "video/quicktime": return "mov"
        case "video/webm": return "webm"
        case "video/3gpp", "video/3gp": return "3gp"
        case "audio/mp4", "audio/x-m4a", "audio/m4a": return "m4a"
        case "audio/mpeg": return "mp3"
        case "audio/aac": return "aac"
        case "audio/ogg": return "ogg"
        case "audio/wav", "audio/x-wav": return "wav"
        case "audio/amr": return "amr"
        case "audio/webm": return "webm"
        case "application/pdf": return "pdf"
        case "application/msword": return "doc"
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "docx"
        case "application/vnd.ms-excel": return "xls"
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return "xlsx"
        case "application/vnd.ms-powerpoint": return "ppt"
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation": return "pptx"
        case "text/plain": return "txt"
        case "text/csv": return "csv"
        default:
            if let type = UTType(mimeType: normalizeMime(mime)) {
                return type.preferredFilenameExtension
            }
            return nil
        }
    }

    private static func defaultFilename(ext: String) -> String {
        "foto-\(Int(Date().timeIntervalSince1970)).\(ext)"
    }

    /// Renombra a `.jpg` al convertir HEIC→JPEG.
    private static func jpegFilename(from original: String?) -> String {
        guard let original, !original.isEmpty else { return defaultFilename(ext: "jpg") }
        let base = (original as NSString).deletingPathExtension
        return base.isEmpty ? defaultFilename(ext: "jpg") : "\(base).jpg"
    }
}
