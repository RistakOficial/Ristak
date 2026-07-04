import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var activeTask: URLSessionDownloadTask?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler

        guard let mutableContent = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }

        bestAttemptContent = mutableContent

        guard let imageURL = notificationImageURL(from: request.content.userInfo) else {
            finish(with: mutableContent)
            return
        }

        activeTask = URLSession.shared.downloadTask(with: imageURL) { [weak self] temporaryURL, response, _ in
            guard let self else {
                contentHandler(mutableContent)
                return
            }

            defer {
                self.activeTask = nil
                self.finish(with: mutableContent)
            }

            guard
                let temporaryURL,
                let attachmentURL = self.copyAttachment(from: temporaryURL, response: response),
                let attachment = try? UNNotificationAttachment(
                    identifier: "contact-avatar",
                    url: attachmentURL,
                    options: nil
                )
            else {
                return
            }

            mutableContent.attachments = [attachment]
        }

        activeTask?.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        activeTask?.cancel()
        if let bestAttemptContent {
            finish(with: bestAttemptContent)
        }
    }

    private func finish(with content: UNNotificationContent) {
        guard let contentHandler else {
            return
        }
        self.contentHandler = nil
        contentHandler(content)
    }

    private func notificationImageURL(from userInfo: [AnyHashable: Any]) -> URL? {
        let candidates = [
            stringValue(userInfo["notificationImageUrl"]),
            stringValue(userInfo["contactAvatarUrl"]),
            stringValue(userInfo["image"]),
            stringValue((userInfo["fcm_options"] as? [String: Any])?["image"]),
            stringValue((userInfo["aps"] as? [String: Any])?["image"])
        ]

        for candidate in candidates {
            guard
                let rawValue = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                !rawValue.isEmpty,
                let url = URL(string: rawValue),
                let scheme = url.scheme?.lowercased(),
                scheme == "https" || scheme == "http"
            else {
                continue
            }
            return url
        }

        return nil
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

    private func copyAttachment(from temporaryURL: URL, response: URLResponse?) -> URL? {
        let fileExtension = attachmentFileExtension(response: response) ?? temporaryURL.pathExtension
        let sanitizedExtension = allowedImageExtension(fileExtension) ?? "jpg"
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
        default:
            return nil
        }
    }

    private func allowedImageExtension(_ value: String?) -> String? {
        let normalized = (value ?? "").lowercased()
        if ["jpg", "jpeg", "png", "gif"].contains(normalized) {
            return normalized == "jpeg" ? "jpg" : normalized
        }
        return nil
    }
}
