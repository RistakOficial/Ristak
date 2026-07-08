import Observation
import SwiftUI
import UIKit

/// Estado del flujo «Enviar media» de la cámara global de la bandeja
/// (paridad mobile/ `sendCameraShare`, App.tsx L3443): con una foto o video ya
/// capturado, el usuario busca y selecciona uno o varios contactos, agrega un
/// mensaje opcional y lo manda a cada uno por WhatsApp
/// (`MessagingService.sendImage` / `sendVideo` con el data URL base64).
@MainActor
@Observable
final class CameraShareViewModel: Identifiable {
    let id = UUID()

    /// Media ya codificada (mismos límites/encoding del composer, via `MediaEncoder`).
    let media: EncodedChatMedia
    /// Miniatura local para la vista previa (imagen capturada o frame del video).
    let previewImage: UIImage?

    private let inbox: InboxViewModel
    private let messaging = MessagingService()

    // Búsqueda de destinatarios (recientes + `/contacts/search`, igual que «Nuevo chat»).
    var searchText = ""
    private(set) var results: [ChatContact] = []
    private(set) var isSearching = false
    private var searchTask: Task<Void, Never>?

    // Selección múltiple (se conserva el orden de toque, como el array de RN).
    private(set) var selected: [ChatContact] = []

    var caption = ""
    private(set) var isSending = false
    var alertMessage: String?

    init(media: EncodedChatMedia, previewImage: UIImage?, inbox: InboxViewModel) {
        self.media = media
        self.previewImage = previewImage
        self.inbox = inbox
    }

    // MARK: - Selección

    var selectedIDs: Set<String> { Set(selected.map(\.id)) }
    var selectedCount: Int { selected.count }

    func isSelected(_ contact: ChatContact) -> Bool {
        selected.contains { $0.id == contact.id }
    }

    func toggle(_ contact: ChatContact) {
        if let index = selected.firstIndex(where: { $0.id == contact.id }) {
            selected.remove(at: index)
        } else {
            selected.append(contact)
        }
    }

    // MARK: - Búsqueda (debounce 240 ms, igual que «Nuevo chat»)

    func runSearch() async {
        isSearching = true
        results = await inbox.newChatResults(query: searchText)
        isSearching = false
    }

    func searchTextChanged() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 240_000_000)
            guard let self, !Task.isCancelled else { return }
            await self.runSearch()
        }
    }

    // MARK: - Envío

    /// Manda la media a cada destinatario por WhatsApp. Devuelve `true` cuando
    /// todos los envíos pasaron (la vista puede cerrarse); en fallo parcial o
    /// total deja el sheet abierto con un aviso.
    func send() async -> Bool {
        guard !isSending else { return false }
        guard !selected.isEmpty else {
            alertMessage = "Selecciona al menos un contacto para enviar."
            return false
        }

        // La cámara global sale por WhatsApp: exige teléfono (paridad RN).
        let withoutPhone = selected.filter {
            $0.phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if !withoutPhone.isEmpty {
            let names = withoutPhone.prefix(2)
                .map { ChatRowSignals.displayName($0) }
                .joined(separator: ", ")
            alertMessage = "Por ahora la cámara envía por WhatsApp. Revisa el teléfono de \(names)."
            return false
        }

        isSending = true
        defer { isSending = false }

        let caption = self.caption.trimmingCharacters(in: .whitespacesAndNewlines)
        let media = self.media
        let messaging = self.messaging
        let recipients = selected

        let succeeded = await withTaskGroup(of: Bool.self) { group in
            for contact in recipients {
                group.addTask {
                    do {
                        try await Self.sendMedia(messaging, to: contact, media: media, caption: caption)
                        return true
                    } catch {
                        return false
                    }
                }
            }
            var oks = 0
            for await ok in group where ok { oks += 1 }
            return oks
        }

        let failed = recipients.count - succeeded
        if succeeded > 0 {
            inbox.requestSilentRefresh()
        }
        if failed > 0 {
            alertMessage = succeeded > 0
                ? "Se envió a \(succeeded) contacto(s), pero falló en \(failed)."
                : "No se pudo enviar. Intenta otra vez."
            return false
        }
        return true
    }

    /// Envío de una pieza de media a un contacto (paridad `sendDraftAttachment` +
    /// `api.sendImage` / `api.sendVideo`: `to`/`from`/`phoneNumberId` derivados
    /// del contacto, transport por defecto `api`, `messageOrigin: manual_chat`).
    private static func sendMedia(
        _ messaging: MessagingService,
        to contact: ChatContact,
        media: EncodedChatMedia,
        caption: String
    ) async throws {
        let from = contact.lastBusinessPhone.isEmpty ? nil : contact.lastBusinessPhone
        let phoneNumberId = contact.lastBusinessPhoneNumberId.isEmpty ? nil : contact.lastBusinessPhoneNumberId
        let captionValue = caption.isEmpty ? nil : caption

        switch media.kind {
        case .video:
            _ = try await messaging.sendVideo(
                VideoMessageSendRequest(
                    to: contact.phone,
                    from: from,
                    contactId: contact.id,
                    videoDataUrl: media.dataUrl,
                    caption: captionValue,
                    phoneNumberId: phoneNumberId
                )
            )
        default:
            _ = try await messaging.sendImage(
                ImageMessageSendRequest(
                    to: contact.phone,
                    from: from,
                    contactId: contact.id,
                    imageDataUrl: media.dataUrl,
                    caption: captionValue,
                    phoneNumberId: phoneNumberId
                )
            )
        }
    }
}
