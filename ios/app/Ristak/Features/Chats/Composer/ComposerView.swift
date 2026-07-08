import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Barra del composer (doc research/05 §7): botón `+`, botón de canal, campo
/// multilinea, reloj para programar, morph mic/enviar, tray de adjuntos,
/// barra de respuesta, banner del agente y sugerencia IA.
///
/// Va montada con `safeAreaInset(edge: .bottom)` — un solo dueño del teclado
/// (memoria del proyecto): sin avoidance anidado.
struct ComposerView: View {
    @Bindable var viewModel: ConversationViewModel
    @Environment(ShellState.self) private var shell

    @FocusState private var isTextFieldFocused: Bool
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var isPhotoPickerPresented = false
    @State private var isCameraPresented = false
    @State private var isFileImporterPresented = false
    @State private var sendPulse = false

    /// Tipos aceptados por el picker de documentos (PDF/Word/Excel/PPT/TXT/CSV).
    private static let documentContentTypes: [UTType] = {
        var types: [UTType] = [.pdf, .plainText, .commaSeparatedText]
        let identifiers: [String] = [
            "com.microsoft.word.doc",
            "org.openxmlformats.wordprocessingml.document",
            "com.microsoft.excel.xls",
            "org.openxmlformats.spreadsheetml.sheet",
            "com.microsoft.powerpoint.ppt",
            "org.openxmlformats.presentationml.presentation",
        ]
        for identifier in identifiers {
            if let type = UTType(identifier) {
                types.append(type)
            }
        }
        return types
    }()

    var body: some View {
        VStack(spacing: 0) {
            agentBanner
            aiSuggestBar
            replyBar
            attachmentsTray
            voicePanel
            composerRow
        }
        .background(RistakTheme.composerBackground)
        .photosPicker(
            isPresented: $isPhotoPickerPresented,
            selection: $photoPickerItems,
            maxSelectionCount: ChatMediaLimits.maxDraftAttachments - viewModel.attachments.count,
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: photoPickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await loadPickedItems(items) }
        }
        .fullScreenCover(isPresented: $isCameraPresented) {
            CameraCaptureView { image in
                viewModel.addCameraImage(image)
            }
            .ignoresSafeArea()
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: Self.documentContentTypes,
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                viewModel.addDocument(at: url)
            }
        }
        .sheet(isPresented: $viewModel.isAttachmentSheetPresented) {
            attachmentActionsSheet
                .presentationDetents([.medium, .large])
        }
        .confirmationDialog(
            "Agente activo en este chat",
            isPresented: $viewModel.agentConfirmationPending,
            titleVisibility: .visible
        ) {
            Button("Pausar 24h y enviar") {
                viewModel.resolveAgentConfirmation(action: .pause)
            }
            Button("Quitar del agente y enviar", role: .destructive) {
                viewModel.resolveAgentConfirmation(action: .skip)
            }
            Button("Cancelar", role: .cancel) {
                viewModel.resolveAgentConfirmation(action: nil)
            }
        } message: {
            Text(agentConfirmationMessage)
        }
    }

    private var agentConfirmationMessage: String {
        let name = viewModel.activeAgentStates.first?.agentName ?? "El agente"
        return "Si envías este mensaje, \(name) dejará de responder este chat. Elige si quieres pausarlo 24 horas o quitar este contacto del agente hasta que lo reactives."
    }

    // MARK: - Banner del agente (doc 05 §6.4)

    @ViewBuilder
    private var agentBanner: some View {
        if let text = viewModel.agentBannerText {
            HStack(spacing: RistakTheme.Spacing.xs) {
                Image(systemName: "sparkles")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.accent)
                Text(text)
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Menu {
                    ForEach(Array(viewModel.agentStates.enumerated()), id: \.offset) { _, state in
                        agentMenuActions(for: state)
                    }
                } label: {
                    Text("Acciones")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.accent)
                }
                .disabled(viewModel.agentActionInFlight)
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private func agentMenuActions(for state: ConversationAgentState) -> some View {
        let name = state.agentName ?? "Agente"
        if state.status.lowercased() == "active" {
            Button("Tomar \(name)") {
                viewModel.performAgentAction(.takeOver, state: state)
            }
            Button("Pausar \(name)") {
                viewModel.performAgentAction(.pause, state: state)
            }
            Button("Omitir \(name)", role: .destructive) {
                viewModel.performAgentAction(.skip, state: state)
            }
        } else {
            Button("Reactivar \(name)") {
                viewModel.performAgentAction(.activate, state: state)
            }
        }
    }

    // MARK: - Sugerencia IA (doc 05 §7.1)

    @ViewBuilder
    private var aiSuggestBar: some View {
        if viewModel.aiSuggestionsEnabled {
            HStack(spacing: RistakTheme.Spacing.xs) {
                Text("✨ El agente puede ayudarte a contestar")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button {
                    viewModel.suggestReply()
                } label: {
                    if viewModel.aiSuggestInFlight {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Sugerir")
                            .font(.caption.weight(.semibold))
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(viewModel.aiSuggestInFlight)
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, 4)
        }
    }

    // MARK: - Barra de respuesta

    @ViewBuilder
    private var replyBar: some View {
        if let target = viewModel.replyTarget {
            HStack(spacing: RistakTheme.Spacing.xs) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(RistakTheme.accent)
                    .frame(width: 3, height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(target.direction == .outbound ? "Respondiendo a ti" : "Respondiendo a \(viewModel.displayName)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.accent)
                    Text(MessagePreviewText.preview(for: target))
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Button {
                    viewModel.cancelReply()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.body)
                        .foregroundStyle(RistakTheme.textMute)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancelar respuesta")
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, 6)
        }
    }

    // MARK: - Tray de adjuntos

    @ViewBuilder
    private var attachmentsTray: some View {
        if !viewModel.attachments.isEmpty {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.xxs) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: RistakTheme.Spacing.xs) {
                        ForEach(viewModel.attachments) { draft in
                            attachmentChip(draft)
                        }
                    }
                    .padding(.horizontal, RistakTheme.Spacing.md)
                }
                Text("\(viewModel.attachments.count) archivo\(viewModel.attachments.count == 1 ? "" : "s") listo\(viewModel.attachments.count == 1 ? "" : "s") · Agrega texto o envía directo.")
                    .font(.caption2)
                    .foregroundStyle(RistakTheme.textMute)
                    .padding(.horizontal, RistakTheme.Spacing.md)
            }
            .padding(.vertical, 6)
        }
    }

    private func attachmentChip(_ draft: ComposerAttachmentDraft) -> some View {
        HStack(spacing: RistakTheme.Spacing.xxs) {
            if let preview = draft.previewImage {
                Image(uiImage: preview)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 34, height: 34)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                Image(systemName: iconName(for: draft.kind))
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.accent)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 6).fill(RistakTheme.accentSoft))
            }
            Text(draft.filename)
                .font(.caption)
                .foregroundStyle(RistakTheme.textPrimary)
                .lineLimit(1)
                .frame(maxWidth: 110, alignment: .leading)
            Button {
                viewModel.removeAttachment(draft.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textMute)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Quitar \(draft.filename)")
        }
        .padding(6)
        .background(
            RoundedRectangle(cornerRadius: RistakTheme.Radius.small)
                .fill(RistakTheme.surface)
        )
    }

    private func iconName(for kind: ChatMediaKind) -> String {
        switch kind {
        case .image: return "photo"
        case .video: return "video"
        case .audio: return "mic"
        case .document: return "doc.text"
        }
    }

    // MARK: - Panel de nota de voz (doc 05 §7.3)

    @ViewBuilder
    private var voicePanel: some View {
        let recorder = viewModel.voiceRecorder
        if recorder.phase != .idle {
            HStack(spacing: RistakTheme.Spacing.sm) {
                Button {
                    recorder.discard()
                } label: {
                    Image(systemName: "trash")
                        .font(.body)
                        .foregroundStyle(RistakTheme.neg)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Descartar nota de voz")

                if recorder.isRecording {
                    Circle()
                        .fill(RistakTheme.neg)
                        .frame(width: 8, height: 8)
                        .opacity(0.4 + recorder.meterLevel * 0.6)
                    Text("Grabando…")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                } else {
                    Image(systemName: "waveform")
                        .foregroundStyle(RistakTheme.accent)
                    Text("Nota de voz lista")
                        .font(.caption)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer(minLength: 0)

                Text(BusinessFormatters.audioDuration(seconds: recorder.elapsedSeconds))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textPrimary)
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, RistakTheme.Spacing.xs)
        }
    }

    // MARK: - Fila principal

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: RistakTheme.Spacing.xs) {
            Button {
                viewModel.isAttachmentSheetPresented = true
            } label: {
                Image(systemName: "plus")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(RistakTheme.controlRest))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Adjuntar")

            Button {
                viewModel.isChannelSheetPresented = true
            } label: {
                ChannelBadgeView(channel: viewModel.selectedChannel.badgeChannel, size: 26)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Canal de envío")

            HStack(alignment: .bottom, spacing: RistakTheme.Spacing.xxs) {
                TextField("Mensaje", text: $viewModel.draftText, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($isTextFieldFocused)
                    .textInputAutocapitalization(.sentences)
                    .font(.body)

                if !viewModel.draftText.trimmingCharacters(in: .whitespaces).isEmpty,
                   viewModel.attachments.isEmpty {
                    Button {
                        viewModel.presentScheduleSheet()
                    } label: {
                        Image(systemName: "clock")
                            .font(.body)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Programar mensaje")
                }
            }
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 18)
                    .fill(RistakTheme.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 18)
                            .strokeBorder(RistakTheme.border, lineWidth: 0.5)
                    )
            )

            micOrSendButton
        }
        .padding(.horizontal, RistakTheme.Spacing.md)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    /// Morph mic ↔ enviar: sin contenido = mic; con contenido o nota lista =
    /// flecha de enviar (doc 05 §7.1).
    @ViewBuilder
    private var micOrSendButton: some View {
        let hasContent = viewModel.canSendDraft
        Button {
            if hasContent {
                sendPulse.toggle()
                viewModel.sendCurrentDraft()
            } else {
                viewModel.toggleVoiceRecording()
            }
        } label: {
            Image(systemName: buttonIcon)
                .font(.body.weight(.semibold))
                .foregroundStyle(RistakTheme.onAccent)
                .frame(width: 36, height: 36)
                .background(Circle().fill(buttonColor))
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isSending)
        .sensoryFeedback(.impact(weight: .medium), trigger: sendPulse)
        .accessibilityLabel(hasContent ? "Enviar" : (viewModel.voiceRecorder.isRecording ? "Detener grabación" : "Grabar nota de voz"))
    }

    private var buttonIcon: String {
        if viewModel.voiceRecorder.isRecording { return "stop.fill" }
        return viewModel.canSendDraft ? "arrow.up" : "mic.fill"
    }

    private var buttonColor: Color {
        viewModel.voiceRecorder.isRecording ? RistakTheme.neg : RistakTheme.accent
    }

    // MARK: - PhotosPicker

    private func loadPickedItems(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first
            let mime = type?.preferredMIMEType
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let filename = "media-\(Int(Date().timeIntervalSince1970)).\(ext)"
            viewModel.addPickedMedia(data: data, mimeType: mime, filename: filename)
        }
        photoPickerItems = []
    }

    // MARK: - Sheet de adjuntos y acciones (`+`, doc 05 §7.2)

    private var attachmentActionsSheet: some View {
        SheetScaffold(title: "Acciones", subtitle: viewModel.displayName) {
            List {
                Section("Adjuntos") {
                    attachmentAction("Tomar foto", systemImage: "camera") {
                        isCameraPresented = true
                    }
                    attachmentAction("Elegir foto o video", systemImage: "photo.on.rectangle") {
                        isPhotoPickerPresented = true
                    }
                    attachmentAction("Documento", systemImage: "doc.text") {
                        isFileImporterPresented = true
                    }
                    attachmentAction("Ubicación", systemImage: "location") {
                        viewModel.sendCurrentLocation()
                    }
                }

                Section("Herramientas") {
                    attachmentAction("Plantillas", systemImage: "square.text.square") {
                        viewModel.isTemplatesSheetPresented = true
                    }
                    attachmentAction("Programar mensaje", systemImage: "clock") {
                        viewModel.presentScheduleSheet()
                    }
                    attachmentAction("Agendar cita", systemImage: "calendar.badge.plus") {
                        shell.openCalendars(contactID: viewModel.contactID)
                    }
                    attachmentAction("Registrar pago", systemImage: "dollarsign.circle") {
                        shell.openPayments(contactID: viewModel.contactID)
                    }
                    attachmentAction("Agregar etiqueta", systemImage: "tag") {
                        viewModel.isTagSheetPresented = true
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
    }

    private func attachmentAction(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button {
            viewModel.isAttachmentSheetPresented = false
            // Deja que la sheet cierre antes de presentar lo siguiente.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 250_000_000)
                action()
            }
        } label: {
            Label(title, systemImage: systemImage)
                .foregroundStyle(RistakTheme.textPrimary)
        }
    }
}

// MARK: - Cámara (UIImagePickerController)

/// Captura de foto con la cámara del sistema (doc 05 §7.2 «Tomar foto»).
struct CameraCaptureView: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraCaptureView

        init(parent: CameraCaptureView) {
            self.parent = parent
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = (info[.editedImage] ?? info[.originalImage]) as? UIImage {
                parent.onCapture(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
