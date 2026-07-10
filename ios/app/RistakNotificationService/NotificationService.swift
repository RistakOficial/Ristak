import Foundation
import Intents
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNNotificationContent?
    private var activeTasks: [URLSessionTask] = []

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
        activeTasks.forEach { $0.cancel() }
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
        let task = URLSession.shared.downloadTask(with: mediaURL) { [weak self] temporaryURL, response, _ in
            guard let self else {
                completion(content)
                return
            }

            defer {
                self.removeActiveTask(withIdentifier: taskIdentifier)
                self.bestAttemptContent = content
                completion(content)
            }

            guard
                let temporaryURL,
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
        activeTasks.append(task)
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

        guard
            let senderName = senderDisplayName(from: userInfo, fallbackTitle: content.title),
            let avatarURL = contactAvatarURL(from: userInfo)
        else {
            completion(content)
            return
        }

        downloadImageData(from: avatarURL) { [weak self] avatarData in
            guard let self else {
                completion(content)
                return
            }

            let personIdentifier = self.contactIdentifier(from: userInfo)
            let senderImage = avatarData.flatMap { INImage(imageData: $0) }
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
                self.bestAttemptContent = updatedContent
                completion(updatedContent)
            } catch {
                completion(content)
            }
        }
    }

    private func downloadImageData(from url: URL, completion: @escaping (Data?) -> Void) {
        var taskIdentifier = -1
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            guard let self else {
                completion(nil)
                return
            }

            defer {
                self.removeActiveTask(withIdentifier: taskIdentifier)
            }

            guard
                let data,
                !data.isEmpty
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
        activeTasks.append(task)
        task.resume()
    }

    private func removeActiveTask(withIdentifier identifier: Int) {
        activeTasks.removeAll { $0.taskIdentifier == identifier }
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
