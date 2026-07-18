import AVFoundation
import AVKit
import MapKit
import QuickLook
import SwiftUI
import UIKit

// Render de media en burbujas (docs research/04 §7.5 y 12 §7):
// imagen (visor zoom), video (AVPlayer), nota de voz (player con velocidades),
// documento (QuickLook) y ubicación (MapKit).

// MARK: - Imagen remota con caché propia

/// Imagen remota vía `RistakImageLoader` (caché memoria + disco).
struct ChatRemoteImage: View {
    let url: URL
    var contentMode: ContentMode = .fill

    @State private var image: UIImage?
    @State private var failed = false

    init(url: URL, contentMode: ContentMode = .fill) {
        self.url = url
        self.contentMode = contentMode
        // Pintado síncrono desde memoria: si ya está cacheada, sin spinner ni flash
        // aunque la fila recicle al hacer scroll.
        _image = State(initialValue: RistakImageLoader.shared.cachedImage(for: url))
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else if failed {
                ZStack {
                    RistakTheme.controlRest
                    Image(systemName: "photo")
                        .foregroundStyle(RistakTheme.textMute)
                }
            } else {
                ZStack {
                    RistakTheme.controlRest
                    Image(systemName: "photo")
                        .foregroundStyle(RistakTheme.textMute)
                }
            }
        }
        .task(id: url) {
            // Ya la tenemos en memoria (sembrada o de una carga previa): reporta el
            // tamaño y no vuelvas a descargar.
            if let cached = RistakImageLoader.shared.cachedImage(for: url) {
                if image !== cached { image = cached }
                failed = false
                return
            }
            if image != nil { image = nil }
            failed = false
            if let loaded = await RistakImageLoader.shared.imageIfAvailable(for: url) {
                image = loaded
            } else {
                failed = true
            }
        }
    }
}

// MARK: - Imagen

/// Canvas inmutable de foto/video dentro del timeline. No depende de que la red
/// revele después el aspecto del archivo: placeholder y contenido final ocupan
/// exactamente los mismos puntos, así que el scroll jamás cambia de geometría.
enum ChatVisualMediaLayout {
    static let size = CGSize(width: 252, height: 189)
}

/// Decide la geometría de foto/video antes de que el servidor entregue la URL.
/// Algunos eventos llegan primero con `messageType` y el adjunto se materializa
/// en el siguiente refresh. La fila debe nacer con su tamaño definitivo para no
/// empujar el timeline cuando ese segundo payload aparezca.
enum ChatVisualMediaPresentation {
    static func kind(attachment: ChatAttachment?, messageType: String?) -> ChatAttachment.Kind? {
        if let type = attachment?.type {
            return type == .image || type == .video ? type : nil
        }

        let inferred = ChatJourneyParser.attachmentType(
            messageType: messageType ?? "",
            mimeType: "",
            filename: "",
            mediaUrl: ""
        )
        guard inferred == .image || inferred == .video else { return nil }
        return inferred
    }

    static func attachment(
        actual: ChatAttachment?,
        messageType: String?
    ) -> ChatAttachment? {
        if let actual { return actual }
        guard let kind = kind(attachment: nil, messageType: messageType) else { return nil }
        return ChatAttachment(
            type: kind,
            name: kind == .image ? "Foto" : "Video"
        )
    }

    static func caption(_ text: String, kind: ChatAttachment.Kind?) -> String {
        guard let kind else { return text }
        let normalized = text
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let generatedFallbacks: Set<String>
        switch kind {
        case .image:
            generatedFallbacks = ["foto", "imagen", "image", "photo", "gif", "sticker"]
        case .video:
            generatedFallbacks = ["video"]
        case .audio, .document, .file:
            return text
        }
        return generatedFallbacks.contains(normalized) ? "" : text
    }
}

struct ImageAttachmentView: View {
    let attachment: ChatAttachment

    @State private var showsViewer = false
    @State private var localImage: UIImage?

    private var remoteURL: URL? {
        guard let raw = attachment.url, let url = URL(string: raw) else { return nil }
        return url
    }

    var body: some View {
        content
            .frame(width: ChatVisualMediaLayout.size.width, height: ChatVisualMediaLayout.size.height)
            .clipped()
            .contentShape(Rectangle())
            .onTapGesture {
                if remoteURL != nil || localImage != nil { showsViewer = true }
            }
            .task(id: localPreviewTaskID) {
                guard localImage == nil else { return }
                let previewData = attachment.localPreviewData
                let dataURL = attachment.dataUrl
                guard previewData != nil || dataURL != nil else { return }
                // El binario optimista se decodifica fuera de main sin convertirlo
                // primero a un String base64. `dataUrl` queda solo para mensajes
                // legacy recibidos del servidor.
                let decoded = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                    let image: UIImage?
                    if let previewData {
                        image = UIImage(data: previewData)
                    } else if let dataURL {
                        image = Self.decodeDataURL(dataURL)
                    } else {
                        image = nil
                    }
                    guard let image else { return nil }
                    return image.preparingForDisplay() ?? image
                }.value
                guard let image = decoded, !Task.isCancelled else { return }
                localImage = image
            }
            .fullScreenCover(isPresented: $showsViewer) {
                FullScreenImageViewer(remoteURL: remoteURL, localImage: localImage)
            }
            .accessibilityLabel(attachment.name ?? "Foto")
    }

    private var localPreviewTaskID: String {
        if let data = attachment.localPreviewData {
            return "binary:\(data.count):\(attachment.name ?? "")"
        }
        return attachment.dataUrl ?? ""
    }

    @ViewBuilder
    private var content: some View {
        if let localImage {
            Image(uiImage: localImage)
                .resizable()
                .scaledToFill()
        } else if let remoteURL {
            ChatRemoteImage(url: remoteURL)
        } else {
            unavailablePlaceholder
        }
    }

    private var unavailablePlaceholder: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "photo")
            Text(attachment.name ?? "Foto")
                .font(.subheadline)
        }
        .foregroundStyle(RistakTheme.textDim)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RistakTheme.controlRest)
    }

    nonisolated static func decodeDataURL(_ dataUrl: String) -> UIImage? {
        guard let comma = dataUrl.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else {
            return nil
        }
        return UIImage(data: data)
    }
}

/// Visor pantalla completa con pinch-zoom, doble tap y compartir.
struct FullScreenImageViewer: View {
    let remoteURL: URL?
    let localImage: UIImage?

    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                ZStack {
                    Color.black.ignoresSafeArea()
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(width: proxy.size.width, height: proxy.size.height)
                            .scaleEffect(scale)
                            .offset(offset)
                            .gesture(zoomGesture.simultaneously(with: panGesture))
                            .onTapGesture(count: 2) {
                                withAnimation(.spring(duration: 0.3)) {
                                    if scale > 1 {
                                        scale = 1
                                        offset = .zero
                                    } else {
                                        scale = 2.4
                                    }
                                    lastScale = scale
                                    lastOffset = offset
                                }
                            }
                    } else {
                        ProgressView()
                            .tint(.white)
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Cerrar")
                }
                if let image {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview("Foto", image: Image(uiImage: image))) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Compartir")
                    }
                }
            }
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .task {
            if let localImage {
                image = localImage
            } else if let remoteURL {
                // Visor con zoom: resolución NATIVA (no la miniatura reducida).
                image = await RistakImageLoader.shared.fullImageIfAvailable(for: remoteURL)
            }
        }
    }

    private var zoomGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                scale = max(1, min(5, lastScale * value))
            }
            .onEnded { _ in
                lastScale = scale
                if scale <= 1.02 {
                    withAnimation(.spring(duration: 0.25)) {
                        scale = 1
                        offset = .zero
                        lastOffset = .zero
                        lastScale = 1
                    }
                }
            }
    }

    private var panGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                guard scale > 1 else { return }
                offset = CGSize(
                    width: lastOffset.width + value.translation.width,
                    height: lastOffset.height + value.translation.height
                )
            }
            .onEnded { _ in
                lastOffset = offset
            }
    }
}

// MARK: - Video

struct VideoAttachmentView: View {
    let attachment: ChatAttachment

    @State private var showsPlayer = false
    @State private var thumbnail: UIImage?
    @State private var measuredDurationMs: Double?

    private var videoURL: URL? {
        guard let raw = attachment.url else { return nil }
        return URL(string: raw)
    }

    var body: some View {
        Button {
            if videoURL != nil { showsPlayer = true }
        } label: {
            ZStack {
                Color.black

                if let thumbnail {
                    Image(uiImage: thumbnail)
                        .resizable()
                        .scaledToFill()
                } else if videoURL != nil {
                    Image(systemName: "video")
                        .font(.title2)
                        .foregroundStyle(.white.opacity(0.76))
                } else {
                    Image(systemName: "video.slash")
                        .font(.title2)
                        .foregroundStyle(.white.opacity(0.76))
                }

                LinearGradient(
                    colors: [.clear, .black.opacity(0.66)],
                    startPoint: .center,
                    endPoint: .bottom
                )

                Circle()
                    .fill(.black.opacity(0.5))
                    .frame(width: 54, height: 54)
                    .overlay {
                        Image(systemName: "play.fill")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.white)
                            .offset(x: 2)
                    }

                HStack(spacing: 5) {
                    Image(systemName: "video.fill")
                        .font(.caption2.weight(.semibold))
                    Text(durationLabel)
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                }
                .foregroundStyle(RistakTheme.bubbleMediaMeta)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.black.opacity(0.5), in: Capsule())
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .padding(9)
            }
            .frame(width: ChatVisualMediaLayout.size.width, height: ChatVisualMediaLayout.size.height)
            .clipped()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(videoURL == nil)
        .task(id: videoURL) {
            guard let videoURL else { return }
            await loadPreview(from: videoURL)
        }
        .sheet(isPresented: $showsPlayer) {
            if let videoURL {
                VideoPlayerSheet(url: videoURL)
            }
        }
        .accessibilityLabel(attachment.name ?? "Video")
        .accessibilityValue("Duración \(durationLabel)")
    }

    private var durationLabel: String {
        let milliseconds = attachment.durationMs ?? measuredDurationMs ?? 0
        guard milliseconds > 0 else { return "--:--" }
        return BusinessFormatters.audioDuration(milliseconds: milliseconds)
    }

    private func loadPreview(from url: URL) async {
        let preview = await ChatVideoPreviewLoader.shared.preview(for: url)
        guard !Task.isCancelled else { return }
        if attachment.durationMs == nil {
            measuredDurationMs = preview.durationMs
        }
        thumbnail = preview.image
    }
}

/// AVFoundation y la preparación del bitmap corren en el actor, nunca en el
/// hilo principal que está desplazando el chat. También evita regenerar la misma
/// miniatura cuando SwiftUI recicla una fila.
private struct ChatVideoPreview: @unchecked Sendable {
    let image: UIImage?
    let durationMs: Double?
}

private actor ChatVideoPreviewLoader {
    static let shared = ChatVideoPreviewLoader()

    private var cache: [String: ChatVideoPreview] = [:]
    private let maximumEntryCount = 80

    func preview(for url: URL) async -> ChatVideoPreview {
        let key = url.absoluteString
        if let cached = cache[key] { return cached }

        let asset = AVURLAsset(url: url)
        var durationMs: Double?
        if let duration = try? await asset.load(.duration),
           duration.seconds.isFinite,
           duration.seconds > 0 {
            durationMs = duration.seconds * 1_000
        }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 756, height: 567)
        generator.requestedTimeToleranceBefore = .positiveInfinity
        generator.requestedTimeToleranceAfter = .positiveInfinity

        let requestTime = CMTime(seconds: 0.15, preferredTimescale: 600)
        let image: UIImage?
        if let result = try? await generator.image(at: requestTime) {
            let decoded = UIImage(cgImage: result.image)
            image = decoded.preparingForDisplay() ?? decoded
        } else {
            image = nil
        }

        let preview = ChatVideoPreview(image: image, durationMs: durationMs)
        if cache.count >= maximumEntryCount, let oldestKey = cache.keys.first {
            cache.removeValue(forKey: oldestKey)
        }
        cache[key] = preview
        return preview
    }
}

private struct VideoPlayerSheet: View {
    let url: URL
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .ignoresSafeArea(edges: .bottom)
            .onAppear {
                let player = AVPlayer(url: url)
                self.player = player
                player.play()
            }
            .onDisappear {
                player?.pause()
            }
    }
}

// MARK: - Audio / nota de voz

/// Player de nota de voz: play/pausa + progreso + duración + velocidad
/// 1×→1.5×→2× (doc 04 §7.5). Si el formato no se puede reproducir (OGG/Opus
/// inbound, gap doc 12 §8.6) muestra la nota de fallback.
struct AudioMessageView: View {
    let attachment: ChatAttachment
    let isOutbound: Bool
    /// Id del mensaje: clave para la cascada de audios (orden del timeline).
    var messageID: String = ""
    /// Nombre + foto del contacto para el avatar de la nota (paridad /movil, que
    /// pinta el avatar del contacto junto al waveform).
    var contactName: String = ""
    var contactPhotoURL: URL? = nil
    /// Se activa mientras se arrastra la ruedita del scrubber; el hilo lo lee para
    /// desarmar el swipe-para-responder durante ese gesto (ambos son horizontales).
    var isScrubbing: Binding<Bool> = .constant(false)

    @State private var controller = AudioPlaybackController()
    /// Coordinador de cascada inyectado por el hilo (opcional: fuera del hilo la
    /// vista sigue funcionando como reproductor aislado).
    @Environment(AudioCascadeCoordinator.self) private var cascade: AudioCascadeCoordinator?

    private var audioURL: URL? {
        // Nota de voz PROPIA: el servidor la guarda en OGG/Opus (que iOS no
        // decodifica); si tenemos el m4a original que grabamos, reproducir ESE.
        if isOutbound, let local = VoiceNoteLocalStore.localFileURL(forRemoteURL: attachment.url) {
            return local
        }
        if let raw = attachment.url {
            if raw.hasPrefix("file://"), let url = URL(string: raw) { return url }
            if let url = URL(string: raw), url.scheme != nil { return url }
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
            if controller.playbackFailed {
                Label("No se puede reproducir este audio en iOS", systemImage: "mic.slash")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            } else if audioURL == nil {
                Label(isOutbound ? "Nota de voz enviada" : "Nota de voz", systemImage: "mic.fill")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
            } else {
                playerRow
                Text(durationLabel)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textDim)
            }
        }
        .frame(minWidth: 214, alignment: .leading)
        .onAppear { registerWithCascade() }
        .onDisappear {
            controller.stop()
            cascade?.unregister(id: messageID)
        }
        // Fin natural del audio → la cascada decide si encadena el siguiente.
        .onChange(of: controller.finishedTick) { _, _ in
            guard !messageID.isEmpty else { return }
            cascade?.didFinishPlaying(id: messageID)
        }
    }

    /// Fila del reproductor: avatar (según lado) + play/pausa + scrubber (paridad
    /// /movil `messageAudioTopRow`: avatar a la izquierda en salientes, a la
    /// derecha en entrantes).
    private var playerRow: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            if isOutbound { avatarButton }
            playButton
            scrubber
            if !isOutbound { avatarButton }
        }
    }

    private var playButton: some View {
        Button {
            togglePlayback()
        } label: {
            Image(systemName: controller.isPlaying ? "pause.fill" : "play.fill")
                .font(.title3)
                .foregroundStyle(RistakTheme.bubbleMeta)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(controller.isPlaying ? "Pausar" : "Reproducir")
    }

    /// Scrubber arrastrable: pista (waveform con relleno hasta el progreso) + una
    /// ruedita de acento que el usuario puede arrastrar para buscar. Al soltar,
    /// libera el candado del swipe. Toques rápidos también saltan a esa posición.
    private var scrubber: some View {
        // Diámetro/radio de la ruedita arrastrable. Toda la pista se inseta este
        // radio a cada lado (padding exterior) para que el círculo COMPLETO quepa
        // siempre —incluidos los extremos 0 y 1— y jamás se recorte contra el
        // borde de la burbuja (bug #1: la ruedita se veía "cortada"/hexagonal al
        // inicio). Sin clipShape que recorte el círculo.
        let knobDiameter: CGFloat = 13
        let knobRadius = knobDiameter / 2
        let endpointOverhang: CGFloat = 4
        return GeometryReader { proxy in
            let width = max(1, proxy.size.width)
            // El círculo invade un poco el padding reservado en los extremos: en
            // 0:00 no se ve adelantado sobre las primeras barras, pero sigue entero.
            let startOffset = -endpointOverhang
            let travel = max(1, width - knobDiameter + endpointOverhang * 2)
            let startCenter = knobRadius - endpointOverhang
            let clamped = CGFloat(min(1, max(0, controller.progress)))
            ZStack(alignment: .leading) {
                AudioWaveformView(progress: controller.progress)
                Circle()
                    .fill(RistakTheme.accent)
                    .frame(width: knobDiameter, height: knobDiameter)
                    .shadow(color: .black.opacity(0.18), radius: 1, y: 0.5)
                    // La onda vive en [0, width]; la ruedita usa el padding como
                    // holgura visual para que 0:00 y el final no parezcan cortados.
                    .offset(x: startOffset + travel * clamped)
            }
            .frame(height: proxy.size.height, alignment: .center)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        isScrubbing.wrappedValue = true
                        // Mapea el dedo dentro del mismo recorrido visual que usa
                        // la ruedita, incluyendo la holgura de los extremos.
                        let localX = value.location.x - startCenter
                        seek(to: Double(max(0, min(1, localX / travel))))
                    }
                    .onEnded { _ in
                        isScrubbing.wrappedValue = false
                    }
            )
        }
        .frame(height: 26)
        // Clearance real: la pista se separa `knobRadius` de sus vecinos para que
        // ni el borde de la burbuja ni la fila recorten la ruedita en los extremos.
        .padding(.horizontal, knobRadius)
    }

    /// Avatar del contacto que, al tocarlo, cicla la velocidad 1×→2×→4× (paridad
    /// /movil). Cuando la velocidad supera 1× aparece la píldora de velocidad en
    /// la esquina; siempre lleva el distintivo de micrófono.
    private var avatarButton: some View {
        Button {
            controller.cycleRate()
        } label: {
            ContactAvatarView(name: contactName, photoURL: contactPhotoURL, size: 44)
                .overlay(alignment: .bottomTrailing) { micBadge }
                .overlay(alignment: .topLeading) {
                    if controller.rateIsBoosted { speedPill }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: controller.rateLabel)
        .accessibilityLabel("Cambiar velocidad del audio. Actual \(controller.rateLabel)")
    }

    private var micBadge: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(RistakTheme.textDim)
            .frame(width: 16, height: 16)
            .background(Circle().fill(RistakTheme.surface))
            .overlay(Circle().strokeBorder(RistakTheme.border, lineWidth: 0.5))
            .offset(x: 3, y: 2)
    }

    private var speedPill: some View {
        Text(controller.rateLabel)
            .font(.system(size: 9, weight: .heavy))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(minWidth: 22, minHeight: 16)
            .background(Capsule().fill(RistakTheme.accent))
            .overlay(Capsule().strokeBorder(RistakTheme.surface, lineWidth: 1))
            .offset(x: -4, y: -5)
    }

    private func seek(to progress: Double) {
        guard let audioURL else { return }
        controller.seek(toProgress: progress, url: audioURL)
    }

    /// Play/pausa desde el botón, notificando a la cascada el cambio de estado
    /// para que solo suene un audio a la vez y sepa cuál está activo.
    private func togglePlayback() {
        guard let audioURL else { return }
        let willPlay = !controller.isPlaying
        if willPlay, !messageID.isEmpty {
            cascade?.didStartPlaying(id: messageID)
        } else if !messageID.isEmpty {
            cascade?.didPause(id: messageID)
        }
        controller.togglePlayback(url: audioURL)
    }

    /// Registra los handlers de este audio en la cascada (reproducir / detener).
    private func registerWithCascade() {
        guard !messageID.isEmpty, let cascade else { return }
        let url = audioURL
        cascade.register(
            id: messageID,
            play: { if let url { controller.play(url: url) } },
            stop: { controller.stop() }
        )
    }

    /// Tiempo en formato de negocio: muestra el transcurrido mientras suena o se
    /// arrastra la ruedita, y la duración total en reposo.
    private var durationLabel: String {
        if controller.durationSeconds > 0 {
            let showsElapsed = controller.progress > 0 && controller.progress < 1
            let seconds = showsElapsed
                ? controller.durationSeconds * controller.progress
                : controller.durationSeconds
            return BusinessFormatters.audioDuration(seconds: seconds)
        }
        if let durationMs = attachment.durationMs, durationMs > 0 {
            return BusinessFormatters.audioDuration(milliseconds: durationMs)
        }
        return "Audio"
    }
}

/// Waveform estática con progreso (barras predefinidas, paridad RN).
struct AudioWaveformView: View {
    let progress: Double

    private static let barHeights: [CGFloat] = [
        9, 14, 20, 12, 17, 24, 15, 10, 18, 22, 13, 8, 16, 21, 12, 18, 25, 14, 10, 15,
        20, 12, 9, 17, 23, 13, 19, 11, 16, 22,
    ]

    var body: some View {
        GeometryReader { proxy in
            let count = Self.barHeights.count
            let spacing: CGFloat = 2
            let barWidth = max(1.5, (proxy.size.width - CGFloat(count - 1) * spacing) / CGFloat(count))
            HStack(alignment: .center, spacing: spacing) {
                ForEach(0..<count, id: \.self) { index in
                    let filled = Double(index) / Double(count) <= progress
                    Capsule()
                        .fill(filled ? RistakTheme.accent : RistakTheme.textMute.opacity(0.5))
                        .frame(width: barWidth, height: Self.barHeights[index])
                }
            }
            .frame(height: proxy.size.height, alignment: .center)
        }
    }
}

/// Controlador de reproducción con AVPlayer (velocidades 1/1.5/2).
@MainActor
@Observable
final class AudioPlaybackController {
    private(set) var isPlaying = false
    private(set) var progress: Double = 0
    private(set) var durationSeconds: TimeInterval = 0
    private(set) var playbackFailed = false
    /// Se incrementa cada vez que el audio llega NATURALMENTE al final (no en
    /// pausas manuales). Lo observa la vista para encadenar la cascada de audios.
    private(set) var finishedTick = 0

    /// Velocidades del reproductor, idénticas a /movil
    /// (`CONVERSATION_AUDIO_PLAYBACK_SPEEDS = [1, 2, 4]`).
    private static let rates: [Float] = [1, 2, 4]
    private var rateIndex = 0
    private var player: AVPlayer?
    private var timeObserver: Any?
    /// `nonisolated(unsafe)` para poder liberarlo desde el `deinit` (nonisolated).
    /// Solo se muta en main (clase @MainActor) y el deinit tiene acceso exclusivo,
    /// así que no hay carrera real. Es el ÚNICO recurso que puede acumularse
    /// huérfano: el token del bloque lo retiene `NotificationCenter` hasta
    /// `removeObserver` (a diferencia de `timeObserver`, que lo retiene el propio
    /// `AVPlayer` y muere con el controller, y `statusTask`, que se auto-termina).
    @ObservationIgnored nonisolated(unsafe) private var endObserver: NSObjectProtocol?
    private var statusTask: Task<Void, Never>?

    var rateLabel: String {
        let rate = Self.rates[rateIndex]
        return rate == rate.rounded() ? "\(Int(rate))x" : String(format: "%.1fx", rate)
    }

    /// La velocidad actual supera 1× (para mostrar la píldora sobre el avatar,
    /// como /movil que solo dibuja el badge cuando `playbackSpeed > 1`).
    var rateIsBoosted: Bool { rateIndex != 0 }

    /// Red de seguridad: SwiftUI no garantiza `onDisappear` en listas perezosas.
    /// Sin esto, el bloque de `didPlayToEndTimeNotification` quedaría registrado
    /// huérfano en `NotificationCenter` al destruirse la vista sin cerrar el
    /// reproductor. `stop()` ya deja `endObserver` en nil, así que si corrió
    /// antes, el deinit es no-op. (El `timeObserver` lo libera el `AVPlayer` al
    /// morir con el controller y `statusTask` se auto-cancela, por eso el deinit
    /// solo necesita el observer de NotificationCenter.)
    deinit {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
    }

    func togglePlayback(url: URL) {
        if isPlaying {
            player?.pause()
            isPlaying = false
            return
        }
        play(url: url)
    }

    /// Arranca la reproducción (idempotente si ya suena). Lo usa la cascada para
    /// encadenar el siguiente audio sin ambigüedad de «toggle».
    func play(url: URL) {
        if isPlaying { return }
        if player == nil {
            preparePlayer(url: url)
        }
        guard let player else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        if progress >= 0.999 {
            player.seek(to: .zero)
            progress = 0
        }
        player.rate = Self.rates[rateIndex]
        isPlaying = true
    }

    func cycleRate() {
        rateIndex = (rateIndex + 1) % Self.rates.count
        if isPlaying {
            player?.rate = Self.rates[rateIndex]
        }
    }

    /// Prepara el reproductor SIN sonar (para poder buscar/scrubbing antes de dar
    /// play). Idempotente.
    func prepareIfNeeded(url: URL) {
        if player == nil { preparePlayer(url: url) }
    }

    /// Busca a una posición relativa (0…1) arrastrando la ruedita del scrubber.
    /// Prepara el reproductor si aún no existe para poder mover el cabezal.
    func seek(toProgress target: Double, url: URL) {
        prepareIfNeeded(url: url)
        let clamped = min(1, max(0, target))
        progress = clamped
        guard let player else { return }
        let duration = durationSeconds > 0
            ? durationSeconds
            : (player.currentItem?.duration.seconds ?? 0)
        guard duration.isFinite, duration > 0 else { return }
        let time = CMTime(seconds: duration * clamped, preferredTimescale: 600)
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func stop() {
        player?.pause()
        isPlaying = false
        teardownObservers()
        player = nil
    }

    private func preparePlayer(url: URL) {
        playbackFailed = false
        let item = AVPlayerItem(url: url)
        // Corrige el tono al acelerar (2×/4×) para que la voz no suene "chipmunk"
        // — equivalente a `shouldCorrectPitch = true` de /movil.
        item.audioTimePitchAlgorithm = .timeDomain
        let player = AVPlayer(playerItem: item)
        self.player = player

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 10),
            queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, let item = self.player?.currentItem else { return }
                let duration = item.duration.seconds
                guard duration.isFinite, duration > 0 else { return }
                self.durationSeconds = duration
                self.progress = min(1, max(0, time.seconds / duration))
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: item,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.isPlaying = false
                self.progress = 1
                // Señal de fin natural → dispara la cascada al siguiente audio.
                self.finishedTick &+= 1
            }
        }

        statusTask = Task { [weak self] in
            // Detección de formato no reproducible (OGG/Opus): esperar status.
            for _ in 0..<40 {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard let self, let item = self.player?.currentItem else { return }
                if item.status == .failed {
                    self.playbackFailed = true
                    self.isPlaying = false
                    return
                }
                if item.status == .readyToPlay { return }
            }
        }
    }

    private func teardownObservers() {
        if let timeObserver, let player {
            player.removeTimeObserver(timeObserver)
        }
        timeObserver = nil
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = nil
        statusTask?.cancel()
        statusTask = nil
    }
}

// MARK: - Documento (QuickLook)

struct DocumentAttachmentView: View {
    let attachment: ChatAttachment

    @State private var isDownloading = false
    @State private var previewURL: URL?
    @State private var downloadFailed = false

    var body: some View {
        Button {
            openDocument()
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: "doc.text.fill")
                    .font(.title3)
                    .foregroundStyle(RistakTheme.accent)
                    .frame(width: 40, height: 40)
                    .background(RoundedRectangle(cornerRadius: RistakTheme.Radius.small).fill(RistakTheme.accentSoft))

                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name ?? "Documento")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if isDownloading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textMute)
                }
            }
            .padding(RistakTheme.Spacing.xs)
        }
        .buttonStyle(.plain)
        .disabled(attachment.url == nil || isDownloading)
        .opacity(attachment.url == nil ? 0.55 : 1)
        .quickLookPreview($previewURL)
    }

    private var subtitle: String {
        var pieces: [String] = []
        pieces.append(Self.readableType(mime: attachment.mimeType, name: attachment.name))
        if let size = attachment.size, size > 0 {
            pieces.append(Self.readableSize(bytes: size))
        }
        if downloadFailed {
            pieces.append("No se pudo abrir")
        }
        return pieces.joined(separator: " · ")
    }

    private func openDocument() {
        guard let raw = attachment.url, let url = URL(string: raw) else { return }
        if url.isFileURL {
            previewURL = url
            return
        }
        // Reusa la copia ya descargada (mismo doc → misma ruta determinística):
        // reabrir un PDF/archivo lo muestra al instante, sin spinner ni volver a
        // bajar datos.
        let filename = attachment.name ?? url.lastPathComponent
        let target = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-doc-\(abs(raw.hashValue))-\(filename)")
        if FileManager.default.fileExists(atPath: target.path) {
            previewURL = target
            return
        }
        isDownloading = true
        downloadFailed = false
        Task {
            defer { isDownloading = false }
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                try data.write(to: target)
                previewURL = target
            } catch {
                downloadFailed = true
            }
        }
    }

    static func readableType(mime: String?, name: String?) -> String {
        let probe = "\(mime ?? "") \((name ?? "").lowercased())"
        if probe.contains("pdf") { return "PDF" }
        if probe.contains("word") || probe.contains(".doc") { return "Word" }
        if probe.contains("excel") || probe.contains("sheet") || probe.contains(".xls") { return "Excel" }
        if probe.contains("presentation") || probe.contains(".ppt") { return "PowerPoint" }
        if probe.contains("image") { return "Imagen" }
        if probe.contains("video") { return "Video" }
        if probe.contains("audio") { return "Audio" }
        let ext = ((name ?? "") as NSString).pathExtension
        return ext.isEmpty ? "Archivo" : ext.uppercased()
    }

    static func readableSize(bytes: Double) -> String {
        if bytes >= 1024 * 1024 {
            return String(format: "%.1f MB", bytes / (1024 * 1024))
        }
        if bytes >= 1024 {
            return String(format: "%.0f KB", bytes / 1024)
        }
        return String(format: "%.0f B", bytes)
    }
}

// MARK: - Ubicación (MapKit)

struct LocationMessageView: View {
    let location: ChatLocation

    private var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: location.latitude, longitude: location.longitude)
    }

    var body: some View {
        Button {
            openInMaps()
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                Map(initialPosition: .region(
                    MKCoordinateRegion(
                        center: coordinate,
                        span: MKCoordinateSpan(latitudeDelta: 0.006, longitudeDelta: 0.006)
                    )
                )) {
                    Marker(location.name ?? "Ubicación", coordinate: coordinate)
                }
                .frame(width: 250, height: 124)
                .allowsHitTesting(false)

                HStack(spacing: RistakTheme.Spacing.xxs) {
                    Text("📍 Ubicación")
                        .font(.caption.weight(.semibold))
                    if let name = location.name, !name.isEmpty {
                        Text(name)
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.vertical, RistakTheme.Spacing.xs)
            }
            .clipShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.small))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ubicación compartida. Abrir en Mapas")
    }

    private func openInMaps() {
        let query = (location.name ?? "Ubicación")
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "Ubicacion"
        let apple = "https://maps.apple.com/?ll=\(location.latitude),\(location.longitude)&q=\(query)"
        if let url = URL(string: apple) {
            UIApplication.shared.open(url)
        }
    }
}
