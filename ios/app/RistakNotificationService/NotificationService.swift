import Foundation
import Intents
import UIKit
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let stateQueue = DispatchQueue(label: "com.ristak.notification-service.state")
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNNotificationContent?
    private var activeTasks: [Int: URLSessionTask] = [:]

    private static let maxAvatarBytes = 5 * 1024 * 1024
    private static let maxAttachmentBytes = 12 * 1024 * 1024
    private static let downloadSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 7
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let mutableContent = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }

        stateQueue.sync {
            self.contentHandler = contentHandler
            self.bestAttemptContent = mutableContent
            self.activeTasks.removeAll()
        }
        let userInfo = request.content.userInfo

        attachNotificationMedia(to: mutableContent, userInfo: userInfo) { [weak self] contentWithMedia in
            guard let self else {
                contentHandler(contentWithMedia)
                return
            }

            self.applyCommunicationSender(to: contentWithMedia, userInfo: userInfo) { [weak self] finalContent in
                self?.finish(with: finalContent)
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        let snapshot: (tasks: [URLSessionTask], content: UNNotificationContent?) = stateQueue.sync {
            (Array(activeTasks.values), bestAttemptContent)
        }
        snapshot.tasks.forEach { $0.cancel() }
        if let content = snapshot.content { finish(with: content) }
    }

    private func finish(with content: UNNotificationContent) {
        let handler: ((UNNotificationContent) -> Void)? = stateQueue.sync {
            guard let contentHandler else { return nil }
            self.contentHandler = nil
            self.bestAttemptContent = content
            return contentHandler
        }
        handler?(content)
    }

    private func attachNotificationMedia(
        to content: UNMutableNotificationContent,
        userInfo: [AnyHashable: Any],
        completion: @escaping (UNMutableNotificationContent) -> Void
    ) {
        guard let mediaURL = notificationAttachmentURL(from: userInfo) else {
            completion(content)
            return
        }

        var taskIdentifier = -1
        let task = Self.downloadSession.downloadTask(with: mediaURL) { [weak self] temporaryURL, response, _ in
            guard let self else {
                completion(content)
                return
            }

            defer {
                self.removeActiveTask(withIdentifier: taskIdentifier)
                self.updateBestAttemptContent(content)
                completion(content)
            }

            guard
                let temporaryURL,
                self.responseLengthIsAllowed(response, limit: Self.maxAttachmentBytes),
                self.fileSize(at: temporaryURL) <= Self.maxAttachmentBytes,
                let attachmentURL = self.copyAttachment(from: temporaryURL, response: response, sourceURL: mediaURL),
                let attachment = try? UNNotificationAttachment(
                    identifier: "message-media",
                    url: attachmentURL,
                    options: nil
                )
            else {
                return
            }

            content.attachments = [attachment]
        }

        taskIdentifier = task.taskIdentifier
        registerActiveTask(task)
        task.resume()
    }

    private func applyCommunicationSender(
        to content: UNMutableNotificationContent,
        userInfo: [AnyHashable: Any],
        completion: @escaping (UNNotificationContent) -> Void
    ) {
        guard #available(iOS 15.0, *) else {
            completion(content)
            return
        }

        // Basta con conocer el nombre del remitente: si hay foto la usamos y, si no
        // (o si la descarga falla), dibujamos las iniciales localmente. Así el avatar
        // circular tipo iMessage aparece SIEMPRE en cada mensaje de chat sin depender
        // de que el backend logre resolver y servir una URL de imagen.
        guard let senderName = senderDisplayName(from: userInfo, fallbackTitle: content.title) else {
            completion(content)
            return
        }

        let personIdentifier = contactIdentifier(from: userInfo)

        let finalize: (Data?) -> Void = { [weak self] avatarData in
            guard let self else {
                completion(content)
                return
            }

            // Foto real descargada o, en su defecto, iniciales renderizadas nativamente.
            let resolvedData = avatarData ?? Self.renderInitialsAvatarPNG(
                displayName: senderName,
                seed: personIdentifier
            )
            let senderImage = resolvedData.flatMap { INImage(imageData: $0) }
            let sender = INPerson(
                personHandle: INPersonHandle(value: personIdentifier, type: .unknown),
                nameComponents: nil,
                displayName: senderName,
                image: senderImage,
                contactIdentifier: personIdentifier,
                customIdentifier: personIdentifier,
                isMe: false,
                suggestionType: .none
            )
            let intent = INSendMessageIntent(
                recipients: nil,
                outgoingMessageType: .outgoingMessageText,
                content: content.body,
                speakableGroupName: nil,
                conversationIdentifier: self.conversationIdentifier(from: userInfo, fallbackIdentifier: personIdentifier),
                serviceName: "Ristak",
                sender: sender,
                attachments: nil
            )

            let interaction = INInteraction(intent: intent, response: nil)
            interaction.direction = .incoming
            interaction.donate(completion: nil)

            do {
                let updatedContent = try content.updating(from: intent)
                self.updateBestAttemptContent(updatedContent)
                completion(updatedContent)
            } catch {
                completion(content)
            }
        }

        if let avatarURL = contactAvatarURL(from: userInfo) {
            downloadImageData(from: avatarURL) { finalize($0) }
        } else {
            finalize(nil)
        }
    }

    // MARK: - Avatar de iniciales (fallback nativo)

    /// Misma paleta que la insignia de iniciales del backend
    /// (`/api/push/contact-avatar`), para que el fallback dibujado en el propio
    /// dispositivo se vea igual que el avatar que genera el servidor.
    private static let initialsAvatarColors: [UIColor] = [
        UIColor(red: 14 / 255, green: 165 / 255, blue: 233 / 255, alpha: 1),
        UIColor(red: 37 / 255, green: 99 / 255, blue: 235 / 255, alpha: 1),
        UIColor(red: 124 / 255, green: 58 / 255, blue: 237 / 255, alpha: 1),
        UIColor(red: 219 / 255, green: 39 / 255, blue: 119 / 255, alpha: 1),
        UIColor(red: 5 / 255, green: 150 / 255, blue: 105 / 255, alpha: 1),
        UIColor(red: 8 / 255, green: 145 / 255, blue: 178 / 255, alpha: 1),
        UIColor(red: 79 / 255, green: 70 / 255, blue: 229 / 255, alpha: 1),
        UIColor(red: 190 / 255, green: 18 / 255, blue: 60 / 255, alpha: 1)
    ]

    /// Dibuja un círculo de color sólido con 1–2 iniciales blancas y lo devuelve
    /// como PNG listo para `INImage`. Ligero (~220pt, escala 1) para respetar el
    /// presupuesto de memoria de la extensión.
    private static func renderInitialsAvatarPNG(displayName: String, seed: String) -> Data? {
        let initials = initialsText(from: displayName)
        let trimmedSeed = seed.trimmingCharacters(in: .whitespacesAndNewlines)
        let background = initialsAvatarColors[colorIndex(for: trimmedSeed.isEmpty ? displayName : trimmedSeed)]

        let side: CGFloat = 220
        let bounds = CGRect(x: 0, y: 0, width: side, height: side)
        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)

        let image = renderer.image { context in
            background.setFill()
            // Círculo con esquinas transparentes: se ve limpio aun sin recorte del SO.
            context.cgContext.fillEllipse(in: bounds)

            let text = initials as NSString
            let fontSize = initials.count > 1 ? side * 0.40 : side * 0.46
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: fontSize, weight: .semibold),
                .foregroundColor: UIColor.white,
                .paragraphStyle: paragraph
            ]
            let textSize = text.size(withAttributes: attributes)
            let textRect = CGRect(
                x: 0,
                y: (side - textSize.height) / 2,
                width: side,
                height: textSize.height
            )
            text.draw(in: textRect, withAttributes: attributes)
        }

        return image.pngData()
    }

    /// Iniciales al estilo del backend: sin acentos, 1–2 letras de las primeras
    /// palabras; fallback a las primeras alfanuméricas o "C".
    private static func initialsText(from name: String) -> String {
        let folded = name
            .folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let words = folded
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }

        if words.count >= 2 {
            let first = words[0].first.map(String.init) ?? ""
            let second = words[1].first.map(String.init) ?? ""
            return (first + second).uppercased()
        }
        if let word = words.first {
            return String(word.prefix(2)).uppercased()
        }

        let alphanumerics = folded.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        let fallback = String(String.UnicodeScalarView(alphanumerics.prefix(2)))
        return fallback.isEmpty ? "C" : fallback.uppercased()
    }

    /// Índice de color determinístico (FNV-1a) sobre la paleta de iniciales.
    private static func colorIndex(for seed: String) -> Int {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in (seed.isEmpty ? "contact" : seed).utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return Int(hash % UInt64(initialsAvatarColors.count))
    }

    private func downloadImageData(from url: URL, completion: @escaping (Data?) -> Void) {
        var taskIdentifier = -1
        // DownloadTask escribe a disco; `dataTask` podia acumular una respuesta
        // enorme completa en RAM antes de aplicar el limite y matar la extension.
        let task = Self.downloadSession.downloadTask(with: url) { [weak self] temporaryURL, response, _ in
            guard let self else {
                completion(nil)
                return
            }

            defer {
                self.removeActiveTask(withIdentifier: taskIdentifier)
            }

            guard
                let temporaryURL,
                self.responseLengthIsAllowed(response, limit: Self.maxAvatarBytes),
                self.fileSize(at: temporaryURL) <= Self.maxAvatarBytes,
                let data = try? Data(contentsOf: temporaryURL, options: .mappedIfSafe),
                !data.isEmpty,
                data.count <= Self.maxAvatarBytes
            else {
                completion(nil)
                return
            }

            if let mimeType = response?.mimeType?.lowercased(), !mimeType.hasPrefix("image/") {
                completion(nil)
                return
            }

            completion(data)
        }

        taskIdentifier = task.taskIdentifier
        registerActiveTask(task)
        task.resume()
    }

    private func responseLengthIsAllowed(_ response: URLResponse?, limit: Int) -> Bool {
        let length = response?.expectedContentLength ?? NSURLSessionTransferSizeUnknown
        return length == NSURLSessionTransferSizeUnknown || length <= Int64(limit)
    }

    private func fileSize(at url: URL) -> Int {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return values?.fileSize ?? Int.max
    }

    private func registerActiveTask(_ task: URLSessionTask) {
        stateQueue.sync {
            activeTasks[task.taskIdentifier] = task
        }
    }

    private func removeActiveTask(withIdentifier identifier: Int) {
        stateQueue.sync {
            _ = activeTasks.removeValue(forKey: identifier)
        }
    }

    private func updateBestAttemptContent(_ content: UNNotificationContent) {
        stateQueue.sync {
            guard contentHandler != nil else { return }
            bestAttemptContent = content
        }
    }

    private func notificationAttachmentURL(from userInfo: [AnyHashable: Any]) -> URL? {
        let contactURL = contactAvatarURL(from: userInfo)
        let candidates = [
            stringValue(userInfo["notificationAttachmentUrl"]),
            stringValue(userInfo["notification_attachment_url"]),
            stringValue(userInfo["notificationImageUrl"]),
            stringValue(userInfo["notification_image_url"]),
            stringValue(userInfo["mediaAttachmentUrl"]),
            stringValue(userInfo["media_attachment_url"]),
            stringValue(userInfo["mediaUrl"]),
            stringValue(userInfo["media_url"]),
            stringValue(userInfo["image"]),
            stringValue((userInfo["fcm_options"] as? [String: Any])?["image"]),
            stringValue((userInfo["aps"] as? [String: Any])?["image"])
        ]

        for candidate in candidates {
            guard let url = publicURL(from: candidate) else {
                continue
            }
            if let contactURL, url.absoluteString == contactURL.absoluteString {
                continue
            }
            return url
        }

        return nil
    }

    private func contactAvatarURL(from userInfo: [AnyHashable: Any]) -> URL? {
        let candidates = [
            stringValue(userInfo["contactAvatarUrl"]),
            stringValue(userInfo["contact_avatar_url"]),
            stringValue(userInfo["senderAvatarUrl"]),
            stringValue(userInfo["sender_avatar_url"])
        ]

        for candidate in candidates {
            if let url = publicURL(from: candidate) {
                return url
            }
        }

        return nil
    }

    private func senderDisplayName(from userInfo: [AnyHashable: Any], fallbackTitle: String) -> String? {
        let candidates = [
            stringValue(userInfo["contactName"]),
            stringValue(userInfo["contact_name"]),
            stringValue(userInfo["senderName"]),
            stringValue(userInfo["sender_name"]),
            fallbackTitle
        ]

        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return nil
    }

    private func contactIdentifier(from userInfo: [AnyHashable: Any]) -> String {
        let candidates = [
            stringValue(userInfo["contactId"]),
            stringValue(userInfo["contact_id"]),
            stringValue(userInfo["threadId"]),
            stringValue(userInfo["messageId"])
        ]

        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return UUID().uuidString
    }

    private func conversationIdentifier(from userInfo: [AnyHashable: Any], fallbackIdentifier: String) -> String {
        let candidates = [
            stringValue(userInfo["threadId"]),
            stringValue(userInfo["thread_id"]),
            stringValue(userInfo["contactId"]),
            stringValue(userInfo["contact_id"])
        ]

        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }

        return fallbackIdentifier
    }

    private func publicURL(from value: String?) -> URL? {
        guard
            let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !rawValue.isEmpty,
            let url = URL(string: rawValue),
            let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "http"
        else {
            return nil
        }
        return url
    }

    private func stringValue(_ value: Any?) -> String? {
        if let value = value as? String {
            return value
        }
        if let value = value as? CustomStringConvertible {
            return value.description
        }
        return nil
    }

    private func copyAttachment(from temporaryURL: URL, response: URLResponse?, sourceURL: URL) -> URL? {
        if let size = try? temporaryURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           size > Self.maxAttachmentBytes {
            return nil
        }
        let fileExtension = attachmentFileExtension(response: response) ??
            allowedAttachmentExtension(sourceURL.pathExtension) ??
            allowedAttachmentExtension(response?.suggestedFilename?.split(separator: ".").last.map(String.init))
        let sanitizedExtension = allowedAttachmentExtension(fileExtension) ?? "jpg"
        let destinationURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(sanitizedExtension)

        do {
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }
            try FileManager.default.copyItem(at: temporaryURL, to: destinationURL)
            return destinationURL
        } catch {
            return nil
        }
    }

    private func attachmentFileExtension(response: URLResponse?) -> String? {
        guard let mimeType = response?.mimeType?.lowercased() else {
            return nil
        }

        switch mimeType {
        case "image/jpeg", "image/jpg":
            return "jpg"
        case "image/png":
            return "png"
        case "image/gif":
            return "gif"
        case "image/heic":
            return "heic"
        case "image/heif":
            return "heif"
        case "video/mp4":
            return "mp4"
        case "video/quicktime":
            return "mov"
        case "video/x-m4v":
            return "m4v"
        default:
            return nil
        }
    }

    private func allowedAttachmentExtension(_ value: String?) -> String? {
        let normalized = (value ?? "").lowercased()
        if ["jpg", "jpeg", "png", "gif", "heic", "heif", "mp4", "mov", "m4v"].contains(normalized) {
            return normalized == "jpeg" ? "jpg" : normalized
        }
        return nil
    }
}
