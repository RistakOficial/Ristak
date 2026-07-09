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
    @Environment(\.displayScale) private var displayScale

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
            agentSignalBanner
            agentBanner
            aiSuggestBar
            replyBar
            attachmentsTray
            // Grabando o con nota lista, la barra deja de ser el composer normal
            // y se convierte en UI de audio dedicada (paridad /movil): se ocultan
            // canal, "+" y campo de texto; solo se ve la grabación / el preview.
            switch viewModel.voiceRecorder.phase {
            case .idle:
                composerRow
            case .recording:
                RecordingComposerBar(
                    recorder: viewModel.voiceRecorder,
                    onStop: { viewModel.toggleVoiceRecording() }
                )
            case .preview:
                voicePreviewBar
            }
        }
        // El fondo del composer se derrama hacia el borde inferior seguro: así
        // NO queda una franja entre el panel y el teclado; se ven como uno solo
        // (paridad mobile/: composer + teclado comparten fondo). Un hairline
        // arriba separa el hilo del composer, como en mobile/.
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

    // MARK: - Banner de objetivo cumplido (señal de cierre → clear_signal)

    @ViewBuilder
    private var agentSignalBanner: some View {
        if let state = viewModel.agentSignalState,
           let meta = AgentStatusStyle.signalMeta(state.signal ?? "") {
            HStack(spacing: RistakTheme.Spacing.xs) {
                Image(systemName: meta.icon)
                    .font(.caption)
                    .foregroundStyle(RistakTheme.pos)
                VStack(alignment: .leading, spacing: 0) {
                    Text(meta.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)
                    if let summary = state.signalSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                        Text(summary)
                            .font(.caption2)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Button {
                    viewModel.clearAgentSignal()
                } label: {
                    if viewModel.clearingAgentSignal {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Descartar")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(RistakTheme.accent)
                    }
                }
                .disabled(viewModel.clearingAgentSignal)
            }
            .padding(.horizontal, RistakTheme.Spacing.md)
            .padding(.vertical, 6)
            .background(RistakTheme.posSoft)
        }
    }

    // MARK: - Banner del agente (doc 05 §6.4)

    @ViewBuilder
    private var agentBanner: some View {
        // Solo aparece con agente ASIGNADO: `agentBannerText` devuelve nil si
        // `agentStates` está vacío, así que en chats sin agente el composer queda
        // limpio (sin la barra del agente).
        if let text = viewModel.agentBannerText {
            HStack(spacing: RistakTheme.Spacing.xs) {
                AgentBotGlyph(color: RistakTheme.accent, size: 16)
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
                }
                .ristakEdgeToEdgeChips(horizontalInset: RistakTheme.Spacing.md)
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

    // MARK: - Preview de nota de voz (doc 05 §7.3)

    /// Reproductor de la nota grabada: onda con progreso + duración, y las tres
    /// acciones (eliminar, reproducir, enviar). Se arma con los datos ya fijos
    /// del recorder en `.preview`, así que solo cambia al detener/descartar.
    @ViewBuilder
    private var voicePreviewBar: some View {
        if let url = viewModel.voiceRecorder.recordedFileURL {
            VoicePreviewBar(
                url: url,
                durationMs: viewModel.voiceRecorder.recordedDurationMs,
                sending: viewModel.isSending,
                onSend: { viewModel.sendCurrentDraft() },
                onDelete: { viewModel.voiceRecorder.discard() }
            )
        }
    }

    // MARK: - Fila principal

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: RistakTheme.Spacing.xs) {
            // El canal va primero, antes del "+" (User #3): primero eliges por
            // dónde envías, luego adjuntas.
            Button {
                viewModel.isChannelSheetPresented = true
            } label: {
                ChannelBadgeView(channel: viewModel.selectedChannel.badgeChannel, size: 26)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Canal de envío")

            Button {
                viewModel.isAttachmentSheetPresented = true
            } label: {
                // Glifo "+" libre, sin círculo de fondo (User #6).
                Image(systemName: "plus")
                    .font(.title3)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Adjuntar")

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
                // Mic vacío = glifo libre como el "+" (textDim); enviar/grabar =
                // glifo blanco sobre el círculo de acento (User #5).
                .foregroundStyle(isEmptyMic ? RistakTheme.textDim : RistakTheme.onAccent)
                // El avión apunta a la derecha (User #6). La rotación solo aplica
                // al glifo de enviar; el mic/stop quedan sin rotar.
                .rotationEffect(.degrees(isSendGlyph ? 45 : 0))
                .frame(width: 36, height: 36)
                .background {
                    // Sin círculo en el mic vacío: queda suelto como el "+"
                    // (User #5). El acento solo aparece al enviar o grabar.
                    if !isEmptyMic {
                        Circle().fill(buttonColor)
                    }
                }
                .contentShape(Rectangle())
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isSending)
        .sensoryFeedback(.impact(weight: .medium), trigger: sendPulse)
        .accessibilityLabel(hasContent ? "Enviar" : (viewModel.voiceRecorder.isRecording ? "Detener grabación" : "Grabar nota de voz"))
    }

    private var buttonIcon: String {
        if viewModel.voiceRecorder.isRecording { return "stop.fill" }
        // Mic de contorno (sin `.fill`) para el estado vacío (User #5).
        return viewModel.canSendDraft ? "paperplane.fill" : "mic"
    }

    /// Verdadero cuando se muestra el avión de enviar (para rotarlo a horizontal).
    private var isSendGlyph: Bool {
        !viewModel.voiceRecorder.isRecording && viewModel.canSendDraft
    }

    /// Estado vacío del morph: mic de contorno, libre y sin círculo (User #5).
    private var isEmptyMic: Bool {
        !viewModel.voiceRecorder.isRecording && !viewModel.canSendDraft
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

// MARK: - Barra de grabación en vivo (doc 05 §7.3)

/// Reemplaza al composer mientras se graba (paridad /movil): PAUSA al extremo
/// izquierdo, onda en vivo con nivel REAL del micrófono + reloj en la pista, y
/// STOP al extremo derecho. Aislada como vista propia para que el refresco a
/// ~20 fps de la onda no repinte el resto del composer.
private struct RecordingComposerBar: View {
    let recorder: VoiceRecorderController
    let onStop: () -> Void

    @State private var stopPulse = false

    var body: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            // PAUSA — extremo izquierdo.
            Button {
                recorder.togglePause()
            } label: {
                Image(systemName: recorder.isPaused ? "play.fill" : "pause.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(recorder.isPaused ? "Continuar grabación" : "Pausar grabación")

            // Pista: punto rojo vivo + onda real + reloj.
            HStack(spacing: RistakTheme.Spacing.xs) {
                Circle()
                    .fill(RistakTheme.neg)
                    .frame(width: 7, height: 7)
                    .opacity(recorder.isPaused ? 0.3 : 0.5 + recorder.meterLevel * 0.5)
                LiveWaveformView(samples: recorder.meterSamples, paused: recorder.isPaused)
                    .frame(maxWidth: .infinity, minHeight: 22, maxHeight: 22)
                Text(BusinessFormatters.audioDuration(seconds: recorder.elapsedSeconds))
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(minWidth: 42, alignment: .trailing)
            }
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .frame(minHeight: 38)
            .background(
                RoundedRectangle(cornerRadius: 19)
                    .fill(RistakTheme.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 19)
                            .strokeBorder(RistakTheme.border, lineWidth: 0.5)
                    )
            )

            // STOP — extremo derecho: termina y pasa al preview.
            Button {
                stopPulse.toggle()
                onStop()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.onAccent)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(RistakTheme.accent))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.impact(weight: .medium), trigger: stopPulse)
            .accessibilityLabel("Detener grabación")
        }
        .padding(.horizontal, RistakTheme.Spacing.md)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}

/// Onda en vivo dibujada con `Canvas`: cada muestra es una barra fina; la más
/// nueva queda a la derecha y el conjunto se desplaza hacia la izquierda. La
/// altura sale del nivel REAL del micrófono (no de una animación). En pausa se
/// tiñe con el color apagado.
private struct LiveWaveformView: View {
    let samples: [Double]
    let paused: Bool

    var body: some View {
        Canvas { context, size in
            guard size.width > 0, size.height > 0 else { return }
            let barWidth: CGFloat = 2
            let gap: CGFloat = 2
            let step = barWidth + gap
            let maxBars = max(1, Int((size.width + gap) / step))
            let visible = Array(samples.suffix(maxBars))
            guard !visible.isEmpty else { return }
            let color = paused ? RistakTheme.textMute : RistakTheme.accent
            let count = visible.count
            for (offset, sample) in visible.enumerated() {
                let fromRight = count - 1 - offset
                let x = size.width - CGFloat(fromRight) * step - barWidth
                let level = max(0, min(1, CGFloat(sample)))
                let barHeight = max(3, level * size.height)
                let y = (size.height - barHeight) / 2
                let rect = CGRect(x: x, y: y, width: barWidth, height: barHeight)
                context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(color))
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Barra de preview de nota de voz (doc 05 §7.3)

/// Reemplaza al composer cuando hay una nota lista para enviar (paridad /movil):
/// solo se ve la nota (onda con progreso + duración) con tres acciones —
/// ELIMINAR (descarta), REPRODUCIR (preview) y ENVIAR. Reutiliza los
/// componentes de audio del hilo (`AudioWaveformView` / `AudioPlaybackController`).
private struct VoicePreviewBar: View {
    let url: URL
    let durationMs: Double
    let sending: Bool
    let onSend: () -> Void
    let onDelete: () -> Void

    @State private var player = AudioPlaybackController()

    var body: some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            // ELIMINAR — descarta la nota y vuelve al composer normal.
            Button {
                player.stop()
                onDelete()
            } label: {
                Image(systemName: "trash")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(width: 36, height: 38)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Eliminar nota de voz")

            // Pista: onda con progreso de reproducción + duración.
            HStack(spacing: RistakTheme.Spacing.xs) {
                AudioWaveformView(progress: player.progress)
                    .frame(maxWidth: .infinity, minHeight: 22, maxHeight: 22)
                Text(BusinessFormatters.audioDuration(milliseconds: durationMs))
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(minWidth: 42, alignment: .trailing)
            }
            .padding(.horizontal, RistakTheme.Spacing.sm)
            .frame(minHeight: 38)
            .background(
                RoundedRectangle(cornerRadius: 19)
                    .fill(RistakTheme.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 19)
                            .strokeBorder(RistakTheme.border, lineWidth: 0.5)
                    )
            )

            // REPRODUCIR — escucha la nota antes de enviarla.
            Button {
                player.togglePlayback(url: url)
            } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(player.isPlaying ? "Pausar nota de voz" : "Reproducir nota de voz")

            // ENVIAR — usa la ruta de nota de voz existente.
            Button {
                player.stop()
                onSend()
            } label: {
                Group {
                    if sending {
                        ProgressView()
                            .tint(RistakTheme.onAccent)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(RistakTheme.onAccent)
                            .rotationEffect(.degrees(45))
                    }
                }
                .frame(width: 40, height: 40)
                .background(Circle().fill(RistakTheme.accent))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(sending)
            .accessibilityLabel("Enviar nota de voz")
        }
        .padding(.horizontal, RistakTheme.Spacing.md)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .onDisappear { player.stop() }
    }
}
