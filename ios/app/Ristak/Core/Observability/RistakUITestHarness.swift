#if DEBUG
import SwiftUI

/// Configuración sintética activada exclusivamente por XCUITest. Al reemplazar
/// `RootView`, este modo no abre sesión, no lee datos reales y no toca la red.
struct RistakUITestConfiguration: Sendable {
    let chatCount: Int
    let showsRealInboxPresentation: Bool

    static var current: RistakUITestConfiguration? {
        let process = ProcessInfo.processInfo
        guard process.arguments.contains("-ristak-ui-testing") else {
            return nil
        }
        let mode = process.environment["RISTAK_UI_TEST_MODE"]
        guard mode == "synthetic" || mode == "inbox-presentation" else { return nil }

        let requestedCount = Int(
            process.environment["RISTAK_SYNTHETIC_CHAT_COUNT"] ?? "5000"
        ) ?? 5_000
        return RistakUITestConfiguration(
            chatCount: min(max(requestedCount, 100), 50_000),
            showsRealInboxPresentation: mode == "inbox-presentation"
        )
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
