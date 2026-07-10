import AVFoundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Resultado de la cámara global de la bandeja: foto o video recién capturado.
/// Para video se entrega una copia estable en `tmp/` (el archivo original del
/// `UIImagePickerController` puede borrarse al cerrarse la cámara).
enum InboxCameraCapture {
    case image(UIImage)
    case video(URL)
}

/// Cámara del sistema (foto o video) para la CÁMARA GLOBAL de la bandeja
/// (paridad mobile/ `openCamera`, App.tsx L3356 + `pickMedia('camera')`):
/// permite tomar una foto o grabar un video (máx. 60 s) para después elegir uno
/// o varios contactos y mandárselo por WhatsApp.
struct InboxCameraPicker: UIViewControllerRepresentable {
    let onCapture: (InboxCameraCapture) -> Void
    @Environment(\.dismiss) private var dismiss

    /// Paridad mobile/: `CAMERA_SHARE_VIDEO_MAX_DURATION_SECONDS = 60`.
    static let videoMaxDuration: TimeInterval = 60

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            controller.sourceType = .camera
            controller.cameraCaptureMode = .photo
        } else {
            // Sin cámara (simulador): caer a la fototeca para no romper el flujo.
            controller.sourceType = .photoLibrary
        }
        controller.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        controller.videoMaximumDuration = Self.videoMaxDuration
        controller.videoQuality = .typeHigh
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    /// Copia el video a un `tmp/` propio para que sobreviva al cierre de la
    /// cámara (el `UIImagePickerController` limpia su directorio temporal).
    private static func stableCopy(of url: URL) -> URL? {
        let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-camera-\(UUID().uuidString).\(ext)")
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.copyItem(at: url, to: destination)
            return destination
        } catch {
            return nil
        }
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: InboxCameraPicker

        init(parent: InboxCameraPicker) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let url = info[.mediaURL] as? URL {
                let stableURL = InboxCameraPicker.stableCopy(of: url) ?? url
                parent.onCapture(.video(stableURL))
            } else if let image = (info[.editedImage] ?? info[.originalImage]) as? UIImage {
                parent.onCapture(.image(image))
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// Genera una miniatura del primer segundo de un video para la vista previa de
/// la cámara global (no bloquea la carga del envío; si falla se muestra un
/// marcador con icono de video).
enum InboxCameraThumbnail {
    static func generate(from url: URL) async -> UIImage? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1080, height: 1080)
        let time = CMTime(seconds: 0.1, preferredTimescale: 600)
        return await withCheckedContinuation { continuation in
            generator.generateCGImageAsynchronously(for: time) { cgImage, _, _ in
                continuation.resume(returning: cgImage.map(UIImage.init(cgImage:)))
            }
        }
    }
}
