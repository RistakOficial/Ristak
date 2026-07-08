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
                    ProgressView()
                }
            }
        }
        .task(id: url) {
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

struct ImageAttachmentView: View {
    let attachment: ChatAttachment

    @State private var showsViewer = false
    @State private var localImage: UIImage?

    private var remoteURL: URL? {
        guard let raw = attachment.url, let url = URL(string: raw) else { return nil }
        return url
    }

    var body: some View {
        Group {
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
        .frame(maxWidth: 252, maxHeight: 318)
        .clipShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.small))
        .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.small))
        .onTapGesture {
            if remoteURL != nil || localImage != nil { showsViewer = true }
        }
        .task(id: attachment.dataUrl ?? "") {
            if let dataUrl = attachment.dataUrl, localImage == nil {
                localImage = Self.decodeDataURL(dataUrl)
            }
        }
        .fullScreenCover(isPresented: $showsViewer) {
            FullScreenImageViewer(remoteURL: remoteURL, localImage: localImage)
        }
        .accessibilityLabel(attachment.name ?? "Foto")
    }

    private var unavailablePlaceholder: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            Image(systemName: "photo")
            Text(attachment.name ?? "Foto")
                .font(.subheadline)
        }
        .foregroundStyle(RistakTheme.textDim)
        .padding(RistakTheme.Spacing.sm)
    }

    static func decodeDataURL(_ dataUrl: String) -> UIImage? {
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
                image = await RistakImageLoader.shared.imageIfAvailable(for: remoteURL)
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
    let isOutbound: Bool

    @State private var showsPlayer = false

    private var videoURL: URL? {
        guard let raw = attachment.url else { return nil }
        return URL(string: raw)
    }

    var body: some View {
        Button {
            if videoURL != nil { showsPlayer = true }
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                ZStack {
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.small)
                        .fill(RistakTheme.controlRest)
                        .frame(width: 52, height: 52)
                    Image(systemName: "play.fill")
                        .font(.headline)
                        .foregroundStyle(RistakTheme.textPrimary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name ?? "Video")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    if let durationMs = attachment.durationMs, durationMs > 0 {
                        Text(BusinessFormatters.audioDuration(milliseconds: durationMs))
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                    } else {
                        Text("Video")
                            .font(.caption)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(RistakTheme.Spacing.xs)
        }
        .buttonStyle(.plain)
        .disabled(videoURL == nil)
        .sheet(isPresented: $showsPlayer) {
            if let videoURL {
                VideoPlayerSheet(url: videoURL)
            }
        }
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

    @State private var controller = AudioPlaybackController()

    private var audioURL: URL? {
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
                HStack(spacing: RistakTheme.Spacing.sm) {
                    Button {
                        if let audioURL {
                            controller.togglePlayback(url: audioURL)
                        }
                    } label: {
                        Image(systemName: controller.isPlaying ? "pause.fill" : "play.fill")
                            .font(.headline)
                            .foregroundStyle(RistakTheme.textPrimary)
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(RistakTheme.controlRest))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(controller.isPlaying ? "Pausar" : "Reproducir")

                    AudioWaveformView(progress: controller.progress)
                        .frame(height: 26)

                    Button {
                        controller.cycleRate()
                    } label: {
                        Text(controller.rateLabel)
                            .font(.caption2.weight(.bold))
                            .monospacedDigit()
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(RistakTheme.controlRest))
                    }
                    .buttonStyle(.plain)
                    .sensoryFeedback(.selection, trigger: controller.rateLabel)
                    .accessibilityLabel("Velocidad \(controller.rateLabel)")
                }
            }

            Text(durationLabel)
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(RistakTheme.textDim)
        }
        .frame(minWidth: 190, alignment: .leading)
        .onDisappear {
            controller.stop()
        }
    }

    private var durationLabel: String {
        if controller.durationSeconds > 0 {
            return BusinessFormatters.audioDuration(seconds: controller.durationSeconds)
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

    private static let rates: [Float] = [1, 1.5, 2]
    private var rateIndex = 0
    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusTask: Task<Void, Never>?

    var rateLabel: String {
        let rate = Self.rates[rateIndex]
        return rate == rate.rounded() ? "\(Int(rate))x" : String(format: "%.1fx", rate)
    }

    func togglePlayback(url: URL) {
        if isPlaying {
            player?.pause()
            isPlaying = false
            return
        }
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

    func stop() {
        player?.pause()
        isPlaying = false
        teardownObservers()
        player = nil
    }

    private func preparePlayer(url: URL) {
        playbackFailed = false
        let item = AVPlayerItem(url: url)
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
        isDownloading = true
        downloadFailed = false
        Task {
            defer { isDownloading = false }
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                let filename = attachment.name ?? url.lastPathComponent
                let target = FileManager.default.temporaryDirectory
                    .appendingPathComponent("chat-doc-\(abs(raw.hashValue))-\(filename)")
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
