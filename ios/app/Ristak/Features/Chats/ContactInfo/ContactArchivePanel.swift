import AVFoundation
import AVKit
import QuickLook
import SwiftUI
import UIKit

// Multimedia / archivos compartidos de la ficha de contacto (paridad mobile/
// `getContactArchiveItems` + panel "Archivos del chat"). Se derivan del journey
// COMPLETO: los mensajes se reconstruyen con `ChatJourneyParser.buildMessages`
// y de cada adjunto (imagen/video/documento) y de los enlaces del texto se
// arma la lista, ordenada de más nuevo a más viejo. Cada item se puede abrir
// (visor de imágenes / reproductor de video / QuickLook / Safari).

// MARK: - Modelo

enum ContactArchiveKind: Equatable, Sendable {
    case image
    case video
    case document
    case link

    var isMedia: Bool { self == .image || self == .video }
}

struct ContactArchiveItem: Identifiable, Equatable, Sendable {
    let id: String
    let kind: ContactArchiveKind
    /// URL remota (o file://). Vacío si sólo hay `dataUrl` local.
    let url: String
    let dataUrl: String?
    let title: String
    let caption: String
    let date: String
    let direction: ChatMessageDirection
    let mimeType: String?
    let size: Double?

    var remoteURL: URL? {
        guard !url.isEmpty else { return nil }
        return URL(string: url)
    }
}

// MARK: - Constructor (journey completo → items)

enum ContactArchiveBuilder {
    /// Reconstruye los mensajes del journey y extrae adjuntos + enlaces
    /// (paridad `getContactArchiveItems`). Los audios se ignoran.
    static func items(contactID: String, events: [JourneyEvent], appBaseURL: URL? = nil) -> [ContactArchiveItem] {
        var items: [ContactArchiveItem] = []
        var seenLinks = Set<String>()

        let messages = ChatJourneyParser.buildMessages(contactId: contactID, events: events, appBaseURL: appBaseURL)
        for message in messages {
            if let attachment = message.attachment, attachment.type != .audio,
               let item = archiveItem(from: attachment, message: message, index: items.count) {
                items.append(item)
            }
            for link in extractLinks(from: message.text) where seenLinks.insert(link).inserted {
                items.append(ContactArchiveItem(
                    id: "\(message.id)-link-\(items.count)",
                    kind: .link,
                    url: link,
                    dataUrl: nil,
                    title: linkTitle(link),
                    caption: link,
                    date: message.date,
                    direction: message.direction,
                    mimeType: nil,
                    size: nil
                ))
            }
        }

        // Enlaces en eventos del journey que no se volvieron mensajes (formularios,
        // notas, etc.) — se de-duplican por URL contra lo ya recogido.
        for (index, event) in events.enumerated() {
            for link in extractLinks(from: firstText(event.data)) where seenLinks.insert(link).inserted {
                let outbound = isOutbound(event.data)
                items.append(ContactArchiveItem(
                    id: "\(event.type)-\(event.date ?? "")-journey-link-\(index)-\(items.count)",
                    kind: .link,
                    url: link,
                    dataUrl: nil,
                    title: linkTitle(link),
                    caption: link,
                    date: event.date ?? "",
                    direction: outbound ? .outbound : .inbound,
                    mimeType: nil,
                    size: nil
                ))
            }
        }

        return items.sorted { sortable($0.date) > sortable($1.date) }
    }

    private static func archiveItem(from attachment: ChatAttachment, message: ChatMessage, index: Int) -> ContactArchiveItem? {
        let kind: ContactArchiveKind
        switch attachment.type {
        case .image: kind = .image
        case .video: kind = .video
        case .document, .file: kind = .document
        case .audio: return nil
        }
        let url = attachment.url ?? ""
        guard !url.isEmpty || attachment.dataUrl != nil || attachment.name != nil else { return nil }
        let name = attachment.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = (name?.isEmpty == false) ? name! : defaultLabel(kind)
        let caption = message.text.isEmpty ? (attachment.caption ?? "") : message.text
        return ContactArchiveItem(
            id: "\(message.id)-att-\(index)",
            kind: kind,
            url: url,
            dataUrl: attachment.dataUrl,
            title: title,
            caption: caption,
            date: message.date,
            direction: message.direction,
            mimeType: attachment.mimeType,
            size: attachment.size
        )
    }

    private static func defaultLabel(_ kind: ContactArchiveKind) -> String {
        switch kind {
        case .image: return "Foto"
        case .video: return "Video"
        case .document: return "Documento"
        case .link: return "Enlace"
        }
    }

    /// `extractLinksFromText`: `https?://…` únicos preservando orden.
    private static func extractLinks(from text: String) -> [String] {
        guard !text.isEmpty,
              let regex = try? NSRegularExpression(pattern: "https?://[^\\s)]+", options: [.caseInsensitive]) else {
            return []
        }
        let ns = text as NSString
        var seen = Set<String>()
        var result: [String] = []
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let link = ns.substring(with: match.range)
            if seen.insert(link).inserted { result.append(link) }
        }
        return result
    }

    /// `getArchiveLinkTitle`: hostname sin `www.`.
    private static func linkTitle(_ url: String) -> String {
        if let parsed = URL(string: url), let host = parsed.host {
            return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
        let stripped = url.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
        return stripped.split(separator: "/").first.map(String.init) ?? "Enlace"
    }

    private static func firstText(_ data: [String: RistakJSONValue]) -> String {
        for key in ["message_text", "message", "body", "text"] {
            if let value = data[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return ""
    }

    private static func isOutbound(_ data: [String: RistakJSONValue]) -> Bool {
        for key in ["direction", "message_direction", "from_type"] {
            if let value = data[key]?.stringValue?.lowercased(), value.contains("out") {
                return true
            }
        }
        return false
    }

    private static func sortable(_ date: String) -> TimeInterval {
        RistakDateParsing.date(fromISO: date)?.timeIntervalSince1970 ?? 0
    }
}

// MARK: - Fila resumen "Archivos compartidos" (antes de Etiquetas)

/// Fila de acceso al panel de archivos (paridad `ContactInfoSummaryRow`).
struct ContactArchiveSummaryRow: View {
    let phase: JourneyLoadPhase
    let items: [ContactArchiveItem]
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: RistakTheme.Spacing.sm) {
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(RistakTheme.accentSoft)
                    .frame(width: 44, height: 44)
                    .overlay(
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundStyle(RistakTheme.accent)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Archivos compartidos")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                HStack(spacing: 2) {
                    Text("Ver")
                        .font(.subheadline.weight(.semibold))
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(RistakTheme.accent)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ver archivos compartidos")
    }

    private var subtitle: String {
        if items.isEmpty {
            switch phase {
            case .loading: return "Cargando archivos…"
            case .failed: return "Toca para reintentar"
            default: return "Aún no hay archivos compartidos"
            }
        }
        let media = items.filter { $0.kind.isMedia }.count
        let docs = items.filter { $0.kind == .document }.count
        let links = items.filter { $0.kind == .link }.count
        var parts: [String] = []
        if media > 0 { parts.append("\(media) \(media == 1 ? "foto/video" : "fotos/videos")") }
        if docs > 0 { parts.append("\(docs) \(docs == 1 ? "documento" : "documentos")") }
        if links > 0 { parts.append("\(links) \(links == 1 ? "enlace" : "enlaces")") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Panel (sheet)

struct ContactArchivePanel: View {
    let contactName: String
    let phase: JourneyLoadPhase
    let items: [ContactArchiveItem]
    let timeZone: TimeZone
    let onRetry: () -> Void

    @Environment(\.openURL) private var openURL

    private enum Tab: Hashable { case media, documents, links }

    @State private var selectedTab: Tab = .media
    @State private var imageViewerItem: ContactArchiveItem?
    @State private var videoItem: IdentifiedURL?
    @State private var previewURL: URL?
    @State private var downloadingID: String?

    private struct IdentifiedURL: Identifiable {
        let id = UUID()
        let url: URL
    }

    private var media: [ContactArchiveItem] { items.filter { $0.kind.isMedia } }
    private var documents: [ContactArchiveItem] { items.filter { $0.kind == .document } }
    private var links: [ContactArchiveItem] { items.filter { $0.kind == .link } }

    private var availableTabs: [Tab] {
        var result: [Tab] = []
        if !media.isEmpty { result.append(.media) }
        if !documents.isEmpty { result.append(.documents) }
        if !links.isEmpty { result.append(.links) }
        return result
    }

    private var effectiveTab: Tab {
        availableTabs.contains(selectedTab) ? selectedTab : (availableTabs.first ?? .media)
    }

    private let mediaColumns = [GridItem(.adaptive(minimum: 104), spacing: RistakTheme.Spacing.xs)]

    var body: some View {
        SheetScaffold(title: "Archivos compartidos", subtitle: contactName) {
            content
        }
        .quickLookPreview($previewURL)
        .fullScreenCover(item: $imageViewerItem) { item in
            FullScreenImageViewer(
                remoteURL: item.remoteURL,
                localImage: item.dataUrl.flatMap(ImageAttachmentView.decodeDataURL)
            )
        }
        .sheet(item: $videoItem) { item in
            ContactArchiveVideoPlayer(url: item.url)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading where items.isEmpty:
            RistakLoadingView(message: "Cargando archivos…")
        case .failed where items.isEmpty:
            RistakErrorState(message: "No se pudieron cargar los archivos del chat.") {
                onRetry()
            }
        default:
            if items.isEmpty {
                RistakEmptyState(
                    icon: "photo.on.rectangle.angled",
                    title: "Sin archivos",
                    message: "Aún no se han compartido fotos, videos, documentos ni enlaces en este chat."
                )
            } else {
                VStack(spacing: RistakTheme.Spacing.md) {
                    if availableTabs.count > 1 {
                        tabBar
                    }
                    ScrollView {
                        tabContent
                            .padding(.horizontal, RistakTheme.Spacing.lg)
                            .padding(.bottom, RistakTheme.Spacing.lg)
                    }
                }
                .padding(.top, RistakTheme.Spacing.xs)
            }
        }
    }

    // MARK: Tabs

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                if !media.isEmpty {
                    RistakFilterChip(title: "Fotos y videos", count: media.count, isSelected: effectiveTab == .media) { selectedTab = .media }
                }
                if !documents.isEmpty {
                    RistakFilterChip(title: "Documentos", count: documents.count, isSelected: effectiveTab == .documents) { selectedTab = .documents }
                }
                if !links.isEmpty {
                    RistakFilterChip(title: "Enlaces", count: links.count, isSelected: effectiveTab == .links) { selectedTab = .links }
                }
            }
        }
        .ristakEdgeToEdgeChips(horizontalInset: RistakTheme.Spacing.lg)
    }

    @ViewBuilder
    private var tabContent: some View {
        switch effectiveTab {
        case .media:
            LazyVGrid(columns: mediaColumns, spacing: RistakTheme.Spacing.xs) {
                ForEach(media) { mediaTile($0) }
            }
        case .documents:
            rowsCard(documents) { documentRow($0) }
        case .links:
            rowsCard(links) { linkRow($0) }
        }
    }

    private func rowsCard<Row: View>(_ rows: [ContactArchiveItem], @ViewBuilder row: @escaping (ContactArchiveItem) -> Row) -> some View {
        VStack(spacing: 0) {
            ForEach(rows) { item in
                row(item)
                if item.id != rows.last?.id {
                    Divider().overlay(RistakTheme.border.opacity(0.5))
                }
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.card, style: .continuous)
                .fill(RistakTheme.surface)
        )
    }

    // MARK: Media

    private func mediaTile(_ item: ContactArchiveItem) -> some View {
        Button {
            openMedia(item)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                    .fill(RistakTheme.controlRest)

                if item.kind == .image, let url = item.remoteURL {
                    ChatRemoteImage(url: url)
                } else if item.kind == .image, let dataUrl = item.dataUrl,
                          let image = ImageAttachmentView.decodeDataURL(dataUrl) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: item.kind == .video ? "video.fill" : "photo")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(item.kind == .video ? RistakTheme.textPrimary : RistakTheme.accent)
                }

                if item.kind == .video {
                    Circle()
                        .fill(Color.black.opacity(0.45))
                        .frame(width: 36, height: 36)
                        .overlay(
                            Image(systemName: "play.fill")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                        )
                }
            }
            .aspectRatio(1, contentMode: .fill)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.kind == .video ? "Ver video" : "Ver foto")
    }

    private func openMedia(_ item: ContactArchiveItem) {
        switch item.kind {
        case .image:
            imageViewerItem = item
        case .video:
            if let url = item.remoteURL { videoItem = IdentifiedURL(url: url) }
        case .document, .link:
            break
        }
    }

    // MARK: Documentos

    private func documentRow(_ item: ContactArchiveItem) -> some View {
        Button {
            openDocument(item)
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: "doc.text.fill")
                    .font(.title3)
                    .foregroundStyle(RistakTheme.accent)
                    .frame(width: 40, height: 40)
                    .background(RoundedRectangle(cornerRadius: RistakTheme.Radius.small).fill(RistakTheme.accentSoft))

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)
                    Text(documentSubtitle(item))
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)

                if downloadingID == item.id {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textMute)
                }
            }
            .padding(.vertical, RistakTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(item.remoteURL == nil || downloadingID == item.id)
        .opacity(item.remoteURL == nil ? 0.55 : 1)
        .accessibilityLabel("Abrir \(item.title)")
    }

    private func documentSubtitle(_ item: ContactArchiveItem) -> String {
        var parts: [String] = [directionLabel(item.direction)]
        parts.append(DocumentAttachmentView.readableType(mime: item.mimeType, name: item.title))
        if let size = item.size, size > 0 {
            parts.append(DocumentAttachmentView.readableSize(bytes: size))
        }
        let date = ContactInfoDates.dateTime(fromISO: item.date, timeZone: timeZone)
        if !date.isEmpty { parts.append(date) }
        return parts.joined(separator: " · ")
    }

    private func openDocument(_ item: ContactArchiveItem) {
        guard let url = item.remoteURL else { return }
        if url.isFileURL {
            previewURL = url
            return
        }
        downloadingID = item.id
        Task {
            defer { downloadingID = nil }
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                let filename = item.title.isEmpty ? url.lastPathComponent : item.title
                let target = FileManager.default.temporaryDirectory
                    .appendingPathComponent("contact-archive-\(abs(item.url.hashValue))-\(filename)")
                try data.write(to: target)
                previewURL = target
            } catch {
                // Silencioso: el usuario puede reintentar tocando de nuevo.
            }
        }
    }

    // MARK: Enlaces

    private func linkRow(_ item: ContactArchiveItem) -> some View {
        Button {
            if let url = item.remoteURL { openURL(url) }
        } label: {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Image(systemName: "link")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.accent)
                    .frame(width: 40, height: 40)
                    .background(RoundedRectangle(cornerRadius: RistakTheme.Radius.small).fill(RistakTheme.accentSoft))

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)
                    Text(linkSubtitle(item))
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)

                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(RistakTheme.textMute)
            }
            .padding(.vertical, RistakTheme.Spacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Abrir enlace \(item.title)")
    }

    private func linkSubtitle(_ item: ContactArchiveItem) -> String {
        var parts: [String] = [directionLabel(item.direction)]
        let date = ContactInfoDates.dateTime(fromISO: item.date, timeZone: timeZone)
        if !date.isEmpty { parts.append(date) }
        return parts.joined(separator: " · ")
    }

    private func directionLabel(_ direction: ChatMessageDirection) -> String {
        direction == .outbound ? "Enviado por ti" : "Enviado por el contacto"
    }
}

// MARK: - Reproductor de video (sheet)

private struct ContactArchiveVideoPlayer: View {
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
