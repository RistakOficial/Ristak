import Foundation

/// Asset persistido por `/api/media/upload`. La URL apunta al CDN configurado
/// para el tenant (o al endpoint público del asset como fallback de storage).
struct UploadedChatMedia: Decodable, Sendable {
    let id: String
    let publicUrl: String
    let mimeType: String
    let originalFilename: String?
    let storedFilename: String?
    let sizeProcessed: Int?

    var url: String { publicUrl }
    var hasPublicHTTPSURL: Bool {
        guard let components = URLComponents(string: publicUrl) else { return false }
        return components.scheme?.lowercased() == "https" && components.host?.isEmpty == false
    }
}

/// Referencia que el endpoint de mensajería recibirá. Normalmente es una URL
/// pública; el data URL solo aparece contra servidores anteriores al endpoint
/// de subida de chat o que aún lo protegían como `settings_media`.
enum ChatMediaSendReference: Sendable {
    case uploaded(UploadedChatMedia)
    case legacyDataURL(String)

    var publicURL: String? {
        guard case .uploaded(let asset) = self else { return nil }
        return asset.url
    }

    var mediaAssetID: String? {
        guard case .uploaded(let asset) = self else { return nil }
        let value = asset.id.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    var legacyDataURL: String? {
        guard case .legacyDataURL(let dataURL) = self else { return nil }
        return dataURL
    }
}

/// Multipart respaldado por un archivo temporal. Conserva en RAM solo el
/// `binaryData` del draft; no crea un segundo `Data` de 20–40 MB para el body.
struct ChatMediaMultipartFile: Sendable {
    let boundary: String
    let url: URL

    init(
        media: EncodedChatMedia,
        clientUploadID: String,
        contactID: String?
    ) throws {
        let boundary = "ristak-ios-\(UUID().uuidString.lowercased())"
        self.boundary = boundary

        var prefix = ""
        func appendField(name: String, value: String) {
            prefix += "--\(boundary)\r\n"
            prefix += "Content-Disposition: form-data; name=\"\(Self.quoted(name))\"\r\n\r\n"
            prefix += Self.fieldValue(value)
            prefix += "\r\n"
        }

        appendField(name: "moduleEntityId", value: contactID ?? "")
        appendField(name: "isPublic", value: "true")
        appendField(name: "clientUploadId", value: clientUploadID)
        prefix += "--\(boundary)\r\n"
        prefix += "Content-Disposition: form-data; name=\"file\"; filename=\"\(Self.quoted(media.filename))\"\r\n"
        prefix += "Content-Type: \(Self.headerValue(media.mimeType))\r\n\r\n"
        let suffix = "\r\n--\(boundary)--\r\n"

        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("ristak-chat-uploads", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory
            .appendingPathComponent(UUID().uuidString.lowercased())
            .appendingPathExtension("multipart")
        guard fileManager.createFile(atPath: fileURL.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }

        let handle = try FileHandle(forWritingTo: fileURL)
        do {
            try handle.write(contentsOf: Data(prefix.utf8))
            try handle.write(contentsOf: media.binaryData)
            try handle.write(contentsOf: Data(suffix.utf8))
            try handle.close()
            url = fileURL
        } catch {
            try? handle.close()
            try? fileManager.removeItem(at: fileURL)
            throw error
        }
    }

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    func remove() {
        try? FileManager.default.removeItem(at: url)
    }

    private static func quoted(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "\"", with: "_")
            .replacingOccurrences(of: "\r", with: "_")
            .replacingOccurrences(of: "\n", with: "_")
    }

    private static func headerValue(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
    }

    private static func fieldValue(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
    }
}

struct ChatMediaUploadService: Sendable {
    let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Sube una sola vez (idempotencia por `clientUploadId`) y devuelve la URL
    /// compatible con WhatsApp/QR/Meta/HighLevel. `chatCompatibility=whatsapp`
    /// hace que el servidor normalice voz y video antes de guardarlos.
    func upload(
        _ media: EncodedChatMedia,
        clientUploadID: String,
        contactID: String? = nil
    ) async throws -> UploadedChatMedia {
        let span = RistakObservability.begin(.mediaUpload)
        do {
            // Concatenar 20–25 MB de multipart en el MainActor produciría el
            // mismo tirón visual que estamos eliminando. Se arma fuera de UI.
            let multipart = try await Task.detached(priority: .userInitiated) {
                try ChatMediaMultipartFile(
                    media: media,
                    clientUploadID: clientUploadID,
                    contactID: contactID
                )
            }.value
            defer { multipart.remove() }
            try Task.checkCancellation()
            let asset: UploadedChatMedia = try await client.uploadFile(
                "/media/upload",
                fileURL: multipart.url,
                contentType: multipart.contentType,
                query: [
                    "module": "chat",
                    "chatCompatibility": "whatsapp",
                    "chatMediaKind": media.kind.rawValue,
                ],
                timeout: 120
            )
            guard !asset.publicUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw RistakAPIError.invalidResponse
            }
            span.finish(outcome: .success, itemCount: 1)
            return asset
        } catch is CancellationError {
            span.finish(outcome: .cancelled)
            throw CancellationError()
        } catch {
            span.finish(outcome: .failed)
            throw error
        }
    }

    /// Solo cae a base64 cuando el servidor es legacy (404) o conserva el gate
    /// viejo de Media (403). Un timeout/5xx NO dispara otro request 33% más grande.
    func preferredReference(
        for media: EncodedChatMedia,
        clientUploadID: String,
        contactID: String? = nil
    ) async throws -> ChatMediaSendReference {
        do {
            let uploaded = try await upload(
                media,
                clientUploadID: clientUploadID,
                contactID: contactID
            )
            // Los proveedores externos y el transporte QR necesitan una URL
            // absoluta descargable. El fallback local `/media/assets/...` no lo
            // es; en esa instalación conservamos el contrato base64 existente.
            guard uploaded.hasPublicHTTPSURL else {
                return try await legacyReference(for: media)
            }
            return .uploaded(uploaded)
        } catch let error as RistakAPIError where Self.canUseLegacyFallback(error) {
            return try await legacyReference(for: media)
        }
    }

    /// El fallback puede inflar el archivo 33 %, pero nunca corre en MainActor
    /// ni se conserva dentro de la burbuja/snapshot local.
    private func legacyReference(for media: EncodedChatMedia) async throws -> ChatMediaSendReference {
        let dataURL = await Task.detached(priority: .userInitiated) {
            MediaEncoder.dataURL(from: media.binaryData, mimeType: media.mimeType)
        }.value
        try Task.checkCancellation()
        return .legacyDataURL(dataURL)
    }

    static func canUseLegacyFallback(_ error: RistakAPIError) -> Bool {
        error.kind == .notFound || error.kind == .featureUnavailable || error.kind == .accessDenied
    }
}
