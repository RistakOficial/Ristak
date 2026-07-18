#if DEBUG
import SwiftUI
import UIKit

/// Configuración sintética activada exclusivamente por XCUITest. Al reemplazar
/// `RootView`, este modo no abre sesión, no lee datos reales y no toca la red.
struct RistakUITestConfiguration: Sendable {
    let chatCount: Int
    let showsRealInboxPresentation: Bool
    let showsPersonalAssistantChat: Bool
    let showsActivityMarkers: Bool
    let showsConversationScroll: Bool
    let showsChatAppearance: Bool

    static var current: RistakUITestConfiguration? {
        let process = ProcessInfo.processInfo
        guard process.arguments.contains("-ristak-ui-testing") else {
            return nil
        }
        let mode = process.environment["RISTAK_UI_TEST_MODE"]
        guard [
            "synthetic", "inbox-presentation", "personal-assistant-chat", "activity-markers",
            "conversation-scroll", "chat-appearance",
        ].contains(mode) else {
            return nil
        }

        let requestedCount = Int(
            process.environment["RISTAK_SYNTHETIC_CHAT_COUNT"] ?? "5000"
        ) ?? 5_000
        return RistakUITestConfiguration(
            chatCount: min(max(requestedCount, 100), 50_000),
            showsRealInboxPresentation: mode == "inbox-presentation",
            showsPersonalAssistantChat: mode == "personal-assistant-chat",
            showsActivityMarkers: mode == "activity-markers",
            showsConversationScroll: mode == "conversation-scroll",
            showsChatAppearance: mode == "chat-appearance"
        )
    }
}

/// Historial largo y determinista que monta el mismo control de producción. La
/// suite puede lanzar un gesto rápido y tocar la flecha mientras aún hay inercia.
struct RistakConversationScrollUITestHarnessView: View {
    @State private var isNearBottom = true

    private static let bottomAnchorID = "scroll-harness-bottom-anchor"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(0..<240, id: \.self) { index in
                        Text("Mensaje de prueba \(index + 1)")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .id("scroll-harness-message-\(index + 1)")
                            .accessibilityIdentifier("scroll-harness-message-\(index + 1)")
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchorID)
                }
                .scrollTargetLayout()
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 40
            } action: { _, newValue in
                isNearBottom = newValue
            }
            .accessibilityIdentifier("conversation-scroll-harness-root")
            .conversationScrollToBottomControl(
                isNearBottom: $isNearBottom,
                scrollToBottom: {
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            )
        }
    }
}

/// Reproduce los textos largos que antes forzaban los hitos de cita/pago a
/// desbordarse horizontalmente. No abre sesión ni usa red.
struct RistakActivityMarkersUITestHarnessView: View {
    private let formatters = BusinessFormatters(
        timeZone: .gmt,
        currencyCode: "MXN"
    )

    private let appointment = ConversationActivityMarker(
        id: "appointment-long",
        kind: .appointment,
        title: "Cita agendada",
        subtitle: "Asesoría con José Francisco Murillo Ávila · Hoy · 3:00 p.m. · 11:00 p.m.",
        amountLabel: nil,
        date: "2026-07-16T21:00:00.000Z"
    )

    private let payment = ConversationActivityMarker(
        id: "payment-long",
        kind: .payment,
        title: "Pago completado",
        subtitle: "Programa Premium de acompañamiento y seguimiento personalizado",
        amountLabel: "$123,456.78 MXN",
        date: "2026-07-16T21:00:00.000Z"
    )

    var body: some View {
        ZStack {
            ChatWallpaperBackground()
            VStack(spacing: RistakTheme.Spacing.lg) {
                Text("Marcadores de actividad")
                    .font(.headline)
                    .accessibilityIdentifier("activity-markers-harness-root")
                ActivityMarkerView(marker: appointment, formatters: formatters)
                ActivityMarkerView(marker: payment, formatters: formatters)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

/// Monta burbujas reales de producción en tema oscuro, incluida media que pasa
/// de placeholder a bitmap local. Permite comprobar que la geometría no cambia
/// al cargar y conservar una captura visual revisable sin sesión ni red.
struct RistakChatAppearanceUITestHarnessView: View {
    private let formatters = BusinessFormatters(timeZone: .gmt, currencyCode: "MXN")

    private static let sampleImageData: Data? = {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600))
        return renderer.image { context in
            UIColor(red: 0.10, green: 0.19, blue: 0.30, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
            UIColor(red: 0.12, green: 0.72, blue: 0.53, alpha: 1).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 180, y: 80, width: 440, height: 440))
            UIColor.white.withAlphaComponent(0.9).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 332, y: 232, width: 136, height: 136))
        }.jpegData(compressionQuality: 0.9)
    }()

    private var messages: [ChatMessage] {
        [
            ChatMessage(
                id: "night-inbound",
                contactId: "fixture",
                date: "2026-07-17T20:01:00.000Z",
                direction: .inbound,
                text: "Así descansa la vista en modo noche.",
                channel: "whatsapp",
                status: "delivered"
            ),
            ChatMessage(
                id: "night-outbound",
                contactId: "fixture",
                date: "2026-07-17T20:02:00.000Z",
                direction: .outbound,
                text: "Y cada canal conserva su identidad sin brillar de más.",
                channel: "whatsapp",
                status: "read",
                transport: "api"
            ),
            ChatMessage(
                id: "night-image",
                contactId: "fixture",
                date: "2026-07-17T20:03:00.000Z",
                direction: .inbound,
                text: "",
                channel: "whatsapp",
                status: "delivered",
                attachment: ChatAttachment(
                    type: .image,
                    localPreviewData: Self.sampleImageData,
                    name: "Foto de muestra",
                    mimeType: "image/jpeg"
                )
            ),
            ChatMessage(
                id: "night-video",
                contactId: "fixture",
                date: "2026-07-17T20:04:00.000Z",
                direction: .outbound,
                text: "",
                channel: "instagram",
                status: "read",
                transport: "meta",
                attachment: ChatAttachment(
                    type: .video,
                    name: "Video de muestra",
                    mimeType: "video/mp4",
                    durationMs: 72_000
                )
            )
        ]
    }

    var body: some View {
        NavigationStack {
            ZStack {
                ChatWallpaperBackground()
                ScrollView {
                    LazyVStack(spacing: 0) {
                        DaySeparatorView(label: "Hoy")
                        ForEach(messages) { message in
                            MessageRowView(
                                message: message,
                                formatters: formatters,
                                contactName: "Paty",
                                scheduledCountdown: nil,
                                actions: noOpActions
                            )
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Burbuja visual \(message.id)")
                            .accessibilityIdentifier("chat-appearance-row-\(message.id)")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 16)
                }
            }
            .navigationTitle("Paty")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("chat-appearance-harness-root")
    }

    private var noOpActions: MessageRowActions {
        MessageRowActions(
            reply: { _ in },
            react: { _, _ in },
            copy: { _ in },
            info: { _ in },
            retry: { _ in },
            editScheduled: { _ in },
            deleteScheduled: { _ in },
            scrollTo: { _ in },
            reactionCapability: { _ in
                .blocked(title: "No disponible", message: "Fixture visual")
            },
            findReplyTarget: { _ in nil },
            commentContext: { _ in nil }
        )
    }
}

/// Monta el chat real del asistente con un cliente determinista y sin red. Así
/// XCUITest valida el flujo completo de escribir, enviar y continuar opciones.
@MainActor
struct RistakPersonalAssistantChatUITestHarnessView: View {
    @State private var viewModel = PersonalAssistantChatViewModel(client: .uiTest)

    var body: some View {
        NavigationStack {
            PersonalAssistantChatScreen(viewModel: viewModel)
        }
        .accessibilityIdentifier("personal-assistant-harness-root")
    }
}

/// Monta el `InboxScreen` real sin sesión ni red para verificar su presentación
/// inicial (título grande, buscador y tope de la List) de forma determinista.
struct RistakInboxPresentationUITestHarnessView: View {
    @State private var viewModel = InboxViewModel()

    var body: some View {
        NavigationStack {
            InboxScreen(
                viewModel: viewModel,
                selectedContactID: nil,
                onOpenChat: { _ in },
                onOpenAssistant: {}
            )
        }
        .accessibilityIdentifier("inbox-presentation-root")
    }
}

struct RistakUITestHarnessView: View {
    let configuration: RistakUITestConfiguration

    @State private var query = ""
    @State private var showsNewChat = false
    @FocusState private var searchIsFocused: Bool

    private var matchingChatIndexes: [Int] {
        let normalizedQuery = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !normalizedQuery.isEmpty else {
            return Array(0..<configuration.chatCount)
        }

        return (0..<configuration.chatCount).filter { index in
            SyntheticChat(index: index).searchableText.contains(normalizedQuery)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Button {
                        searchIsFocused = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Activar búsqueda")
                    .accessibilityIdentifier("synthetic-search-focus")

                    TextField("Buscar contactos", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit { searchIsFocused = false }
                        .focused($searchIsFocused)
                        .accessibilityIdentifier("synthetic-search")

                    if !query.isEmpty {
                        Button("Limpiar") {
                            query = ""
                        }
                        .accessibilityIdentifier("synthetic-search-clear")
                    }
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 48)

                Text("\(configuration.chatCount) chats sintéticos")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .accessibilityIdentifier("synthetic-chat-count")

                List(matchingChatIndexes, id: \.self) { index in
                    NavigationLink(value: index) {
                        SyntheticChatRow(chat: SyntheticChat(index: index))
                    }
                    .accessibilityIdentifier("synthetic-chat-row-\(index)")
                }
                .listStyle(.plain)
                .accessibilityIdentifier("synthetic-chat-list")
            }
            .navigationTitle("Chats")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsNewChat = true
                    } label: {
                        Label("Nuevo chat", systemImage: "square.and.pencil")
                    }
                    .accessibilityIdentifier("synthetic-new-chat")
                }
            }
            .navigationDestination(for: Int.self) { index in
                SyntheticConversationView(chat: SyntheticChat(index: index))
            }
            .sheet(isPresented: $showsNewChat) {
                SyntheticNewChatView()
            }
        }
        .accessibilityIdentifier("synthetic-root")
    }
}

private struct SyntheticChat: Sendable {
    let index: Int

    var displayNumber: Int { index + 1 }
    var name: String { String(format: "Contacto %05d", displayNumber) }
    var preview: String { "Mensaje sintético \(displayNumber)" }
    var searchableText: String {
        "\(name) \(preview)".lowercased()
    }
}

private struct SyntheticChatRow: View {
    let chat: SyntheticChat

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(.blue.opacity(0.14))
                .frame(width: 44, height: 44)
                .overlay {
                    Text(String(chat.name.prefix(1)))
                        .font(.headline)
                }

            VStack(alignment: .leading, spacing: 4) {
                Text(chat.name)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Text(chat.preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(minHeight: 56)
    }
}

private struct SyntheticConversationView: View {
    let chat: SyntheticChat

    @State private var showsAppointment = false

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(0..<120, id: \.self) { messageIndex in
                    Text("Mensaje de prueba \(messageIndex + 1)")
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(
                            maxWidth: .infinity,
                            alignment: messageIndex.isMultiple(of: 2)
                                ? .leading
                                : .trailing
                        )
                }
            }
            .padding()
        }
        .navigationTitle(chat.name)
        .accessibilityIdentifier("synthetic-history")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Agendar") {
                    showsAppointment = true
                }
                .accessibilityIdentifier("synthetic-schedule")
            }
        }
        .sheet(isPresented: $showsAppointment) {
            NavigationStack {
                VStack(spacing: 16) {
                    Image(systemName: "calendar.badge.plus")
                        .font(.largeTitle)
                    Text("Agendar cita sintética")
                        .font(.title2.bold())
                    Text("Esta prueba no guarda ni envía datos.")
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("synthetic-appointment")
                .navigationTitle("Nueva cita")
            }
        }
    }
}

private struct SyntheticNewChatView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Image(systemName: "person.crop.circle.badge.plus")
                    .font(.largeTitle)
                Text("Nuevo chat sintético")
                    .font(.title2.bold())
                Text("Sin contactos reales y sin conexión de red.")
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("synthetic-new-chat-sheet")
            .navigationTitle("Nuevo chat")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") {
                        dismiss()
                    }
                    .accessibilityIdentifier("synthetic-new-chat-close")
                }
            }
        }
    }
}
#endif
