import SwiftUI

@MainActor
struct PersonalAssistantChatScreen: View {
    @State private var viewModel: PersonalAssistantChatViewModel
    @State private var voiceRecorder = SettingsDictationRecorder()
    @State private var alertMessage: String?

    @Environment(AccessStore.self) private var access
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.displayScale) private var displayScale
    @FocusState private var composerFocused: Bool

    private static let bottomAnchorID = "personal-assistant-bottom"

    init() {
        _viewModel = State(initialValue: PersonalAssistantChatViewModel())
    }

    init(viewModel: PersonalAssistantChatViewModel) {
        _viewModel = State(initialValue: viewModel)
    }

    var body: some View {
        Group {
            if access.canRead(module: .aiAgent) {
                conversation
            } else {
                RistakEmptyState(
                    icon: "lock.fill",
                    title: "Sin acceso",
                    message: "No tienes acceso al Asistente Personal AI."
                )
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(horizontalSizeClass == .compact ? .hidden : .automatic, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) { header }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    composerFocused = false
                    viewModel.resetConversation()
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .disabled(viewModel.isBusy)
                .accessibilityLabel("Nueva conversación con el asistente")
                .accessibilityIdentifier("ristak-personal-assistant-reset")
            }
        }
        .task { await viewModel.loadStatus() }
        .onDisappear { voiceRecorder.discard() }
        .alert(
            "Asistente Personal AI",
            isPresented: Binding(
                get: { alertMessage != nil },
                set: { if !$0 { alertMessage = nil } }
            )
        ) {
            Button("Entendido", role: .cancel) { alertMessage = nil }
        } message: {
            Text(alertMessage ?? "")
        }
    }

    private var conversation: some View {
        ZStack {
            ChatWallpaperBackground()
            messagesList
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composer
        }
    }

    private var header: some View {
        HStack(spacing: RistakTheme.Spacing.xs) {
            ZStack {
                Circle()
                    .fill(RistakTheme.accentSoft)
                    .frame(width: 34, height: 34)
                AgentBotGlyph(color: RistakTheme.accent, size: 20)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("Asistente Personal AI")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)
                Text(viewModel.headerDetail)
                    .font(.caption2)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(viewModel.messages) { message in
                        messageRow(message)
                            .id(message.id)
                    }
                    if viewModel.isSending {
                        typingRow
                            .id("personal-assistant-typing")
                    }
                    Color.clear
                        .frame(height: RistakTheme.Spacing.xs)
                        .id(Self.bottomAnchorID)
                }
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .padding(.top, RistakTheme.Spacing.sm)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onAppear { scrollToBottom(proxy, animated: false) }
            .onChange(of: viewModel.messages.count) {
                scrollToBottom(proxy, animated: true)
            }
            .onChange(of: viewModel.isSending) {
                scrollToBottom(proxy, animated: true)
            }
            .onChange(of: composerFocused) { _, focused in
                if focused { scrollToBottom(proxy, animated: true) }
            }
            .onTapGesture { composerFocused = false }
        }
    }

    private func messageRow(_ message: PersonalAssistantMessage) -> some View {
        let side: RistakBubbleSide = message.role == .user ? .outbound : .inbound
        return RistakMessageRow(side: side, maxWidthFraction: 0.84) {
            RistakChatBubble(
                side: side,
                fill: message.failed ? RistakTheme.bubbleFailed : nil
            ) {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                    PersonalAssistantMarkdownText(
                        text: message.content,
                        failed: message.failed
                    )
                    sources(message.sources)
                    clarificationOptions(message)
                }
            }
            .environment(\.colorScheme, .light)
        }
        .padding(.vertical, 3)
    }

    private var typingRow: some View {
        RistakMessageRow(side: .inbound) {
            RistakChatBubble(side: .inbound) {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ProgressView()
                        .controlSize(.small)
                        .tint(RistakTheme.accent)
                    Text("Pensando…")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.bubbleMeta)
                }
            }
            .environment(\.colorScheme, .light)
        }
        .padding(.vertical, 3)
        .accessibilityIdentifier("ristak-personal-assistant-thinking")
    }

    @ViewBuilder
    private func sources(_ sources: [AIAgentSourceLink]) -> some View {
        let validSources = sources.compactMap { source -> (String, URL)? in
            guard let rawURL = source.url?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let url = URL(string: rawURL),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "")
            else { return nil }
            let title = source.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedTitle = title?.isEmpty == false ? title ?? rawURL : url.host ?? rawURL
            return (resolvedTitle, url)
        }

        if !validSources.isEmpty {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
                Label(validSources.count == 1 ? "Fuente" : "Fuentes", systemImage: "link")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(RistakTheme.bubbleMeta)
                ForEach(Array(validSources.enumerated()), id: \.offset) { _, source in
                    Link(destination: source.1) {
                        Text(source.0)
                            .font(.caption)
                            .foregroundStyle(RistakTheme.accent)
                            .lineLimit(2)
                            .underline()
                    }
                    .accessibilityIdentifier("ristak-personal-assistant-source")
                }
            }
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private func clarificationOptions(_ message: PersonalAssistantMessage) -> some View {
        let options = message.clarificationOptions.filter {
            $0.label?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        }
        if !options.isEmpty {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xs) {
                ForEach(Array(options.prefix(4).enumerated()), id: \.offset) { _, option in
                    Button {
                        Task { await viewModel.select(option, from: message.id) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label ?? "Continuar")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(RistakTheme.accent)
                            if let description = option.description,
                               !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text(description)
                                    .font(.caption)
                                    .foregroundStyle(RistakTheme.bubbleMeta)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, RistakTheme.Spacing.sm)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                                .fill(RistakTheme.accentSoft)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isBusy)
                    .accessibilityIdentifier("ristak-personal-assistant-option")
                }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if voiceRecorder.isRecording {
                recordingBar
            } else if viewModel.isTranscribing {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ProgressView().controlSize(.small)
                    Text("Interpretando audio…")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, RistakTheme.Spacing.md)
                .frame(minHeight: 54)
            } else {
                composerRow
            }
        }
        .background(alignment: .top) {
            RistakTheme.composerBackground
                .ignoresSafeArea(edges: .bottom)
        }
        .overlay(alignment: .top) {
            Rectangle()
                .fill(RistakTheme.border)
                .frame(height: 1 / max(displayScale, 1))
                .accessibilityHidden(true)
        }
    }

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: RistakTheme.Spacing.xs) {
            TextField(
                "Pregúntale a tu asistente",
                text: Bindable(viewModel).draft,
                axis: .vertical
            )
            .lineLimit(1...5)
            .focused($composerFocused)
            .disabled(viewModel.isBusy)
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(RistakTheme.controlBackground)
            )
            .accessibilityIdentifier("ristak-personal-assistant-input")

            Button {
                if viewModel.canSendDraft {
                    Task { await viewModel.sendDraft() }
                } else {
                    startVoiceRecording()
                }
            } label: {
                Group {
                    if viewModel.isSending {
                        ProgressView()
                            .tint(RistakTheme.onAccent)
                    } else {
                        Image(systemName: viewModel.canSendDraft ? "arrow.up" : "mic.fill")
                            .font(.body.weight(.semibold))
                    }
                }
                .frame(width: 38, height: 38)
                .foregroundStyle(viewModel.canSendDraft ? RistakTheme.onAccent : RistakTheme.textPrimary)
                .background(
                    Circle().fill(viewModel.canSendDraft ? RistakTheme.accent : RistakTheme.controlRest)
                )
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isBusy)
            .accessibilityLabel(viewModel.canSendDraft
                ? "Enviar mensaje al asistente"
                : "Grabar nota de voz para el asistente")
            .accessibilityIdentifier("ristak-personal-assistant-send")
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, RistakTheme.Spacing.xs)
    }

    private var recordingBar: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Button(role: .destructive) {
                voiceRecorder.discard()
            } label: {
                Image(systemName: "trash")
                    .frame(width: 38, height: 38)
            }
            .accessibilityLabel("Cancelar nota de voz")

            HStack(spacing: RistakTheme.Spacing.xs) {
                Circle()
                    .fill(RistakTheme.neg)
                    .frame(width: 8, height: 8)
                Text("Grabando…")
                    .font(.subheadline.weight(.medium))
                Spacer(minLength: 0)
            }

            Button {
                guard let url = voiceRecorder.stop() else { return }
                Task { await viewModel.transcribeAndSend(audioURL: url) }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.semibold))
                    .frame(width: 38, height: 38)
                    .foregroundStyle(RistakTheme.onAccent)
                    .background(Circle().fill(RistakTheme.accent))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Enviar nota de voz al asistente")
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .frame(minHeight: 54)
    }

    private func startVoiceRecording() {
        Task {
            guard await voiceRecorder.requestPermission() else {
                alertMessage = "Activa el micrófono en Ajustes del iPhone para dictarle al asistente."
                return
            }
            do {
                try voiceRecorder.start()
            } catch {
                alertMessage = error.localizedDescription
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let action = { proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom) }
        if animated {
            withAnimation(.easeOut(duration: 0.22), action)
        } else {
            action()
        }
    }
}

private struct PersonalAssistantMarkdownText: View {
    let text: String
    let failed: Bool

    private var attributed: AttributedString {
        (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        )) ?? AttributedString(text)
    }

    var body: some View {
        Text(attributed)
            .font(.body)
            .foregroundStyle(failed ? RistakTheme.neg : RistakTheme.bubbleTextInbound)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}
