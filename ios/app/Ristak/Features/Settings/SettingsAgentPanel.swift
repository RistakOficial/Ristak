import SwiftUI

/// Panel «Asistente Personal AI» (doc 10 §5.1 `SettingsAgentPanel`):
/// - Sin OpenAI: input seguro de API key + botón «Conectar OpenAI».
/// - Card «Descripción del negocio»: editor + dictado por voz (m4a →
///   `/transcribe` binario → `business-context-answer` pulido) + «Guardar».
/// - Toggles «Mostrar como primer chat» y «Sugerir respuestas» (app_config).
struct SettingsAgentPanel: View {
    @Environment(SettingsModel.self) private var model
    @Environment(AppConfigStore.self) private var appConfig

    @State private var controller = SettingsAgentPanelController()
    @State private var saveError = SettingsSaveErrorPresenter()

    var body: some View {
        SettingsLoadStateView(
            state: model.agent,
            loadingMessage: "Cargando agente...",
            retry: { Task { await model.loadAgent() } }
        ) { status in
            content(status: status)
        }
        .navigationTitle("Asistente Personal AI")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.loadAgent() }
        .settingsSaveErrorAlert(saveError)
        .alert(
            controller.alertTitle ?? "OpenAI",
            isPresented: Binding(
                get: { controller.alertMessage != nil },
                set: { if !$0 { controller.clearAlert() } }
            )
        ) {
            Button("Entendido", role: .cancel) { controller.clearAlert() }
        } message: {
            Text(controller.alertMessage ?? "")
        }
        .onChange(of: model.agent.value?.editableBusinessContext) { _, newValue in
            controller.syncSavedContext(newValue)
        }
        .onAppear {
            controller.attach(model: model)
            controller.syncSavedContext(model.agent.value?.editableBusinessContext)
        }
        .onDisappear {
            controller.cancelRecordingIfNeeded()
        }
    }

    // MARK: - Contenido

    @ViewBuilder
    private func content(status: AIAgentConfigStatus) -> some View {
        let aiReady = status.isReady

        SettingsPanelScroll {
            if !aiReady {
                connectCard(status: status)
            }

            businessContextCard(aiReady: aiReady)

            SectionCard(title: "Agente en la app") {
                VStack(spacing: RistakTheme.Spacing.sm) {
                    SettingsToggleRow(
                        title: "Mostrar como primer chat",
                        subtitle: "El agente aparece fijo arriba de tus conversaciones.",
                        isOn: aiReady && appConfig.aiAgentChatEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakAppConfigKey.aiAgentEnabled),
                        isDisabled: !aiReady
                    ) { newValue in
                        saveError.run {
                            try await appConfig.setAppConfigBool(newValue, forKey: RistakAppConfigKey.aiAgentEnabled)
                        }
                    }

                    Divider()

                    SettingsToggleRow(
                        title: "Sugerir respuestas",
                        subtitle: "El agente puede preparar un texto para responder en chats reales.",
                        isOn: aiReady && appConfig.aiReplySuggestionsEnabled,
                        isSaving: appConfig.savingKeys.contains(RistakAppConfigKey.aiReplySuggestionsEnabled),
                        // Dependiente: requiere agente listo Y «primer chat» ON (doc 10 §4.6).
                        isDisabled: !aiReady || !appConfig.aiAgentChatEnabled
                    ) { newValue in
                        saveError.run {
                            try await appConfig.setAppConfigBool(newValue, forKey: RistakAppConfigKey.aiReplySuggestionsEnabled)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Conectar OpenAI

    private func connectCard(status: AIAgentConfigStatus) -> some View {
        SectionCard(title: "Conexión") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                Text(status.needsReconnect
                    ? "Reconecta OpenAI para activar el agente en este celular."
                    : "Conecta OpenAI para activar el agente en este celular.")
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                    .fixedSize(horizontal: false, vertical: true)

                SecureField("Pega tu API key de OpenAI (sk-...)", text: $controller.apiKeyDraft)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(.body)
                    .padding(.horizontal, RistakTheme.Spacing.sm)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                            .fill(RistakTheme.surface2)
                    )

                Button {
                    Task { await controller.connectOpenAI() }
                } label: {
                    HStack(spacing: RistakTheme.Spacing.xs) {
                        if controller.isConnecting {
                            ProgressView().controlSize(.small)
                        }
                        Text(controller.isConnecting ? "Conectando…" : "Conectar OpenAI")
                            .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(controller.isConnecting || controller.apiKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    // MARK: - Descripción del negocio

    private func businessContextCard(aiReady: Bool) -> some View {
        SectionCard(title: "Descripción del negocio") {
            VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    Image(systemName: "sparkles")
                        .font(.body.weight(.medium))
                        .foregroundStyle(RistakTheme.accent)
                    Text("Dicta tu giro, servicios y clientes; la IA lo pule y lo guarda aquí.")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }

                ZStack(alignment: .topLeading) {
                    TextEditor(text: $controller.contextDraft)
                        .font(.body)
                        .frame(minHeight: 130)
                        .scrollContentBackground(.hidden)
                        .disabled(!aiReady || controller.isBusy)

                    if controller.contextDraft.isEmpty {
                        Text("Ejemplo: Somos una clínica dental en Ciudad Juárez, atendemos familias...")
                            .font(.body)
                            .foregroundStyle(RistakTheme.textMute)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
                .padding(RistakTheme.Spacing.xs)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(RistakTheme.surface2)
                )

                Text(controller.statusLine(aiReady: aiReady))
                    .font(.footnote)
                    .foregroundStyle(controller.statusIsError ? RistakTheme.neg : RistakTheme.textDim)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: RistakTheme.Spacing.xs) {
                    dictationButton(aiReady: aiReady)

                    Spacer(minLength: 0)

                    Button {
                        Task { await controller.saveContext() }
                    } label: {
                        HStack(spacing: 6) {
                            if controller.isSavingContext {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "square.and.arrow.down")
                                    .font(.subheadline.weight(.semibold))
                            }
                            Text("Guardar")
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!controller.canSaveContext(aiReady: aiReady))
                }
            }
        }
        .sensoryFeedback(.success, trigger: controller.savedPulse)
    }

    private func dictationButton(aiReady: Bool) -> some View {
        Button {
            Task { await controller.toggleDictation() }
        } label: {
            HStack(spacing: 6) {
                switch controller.dictationPhase {
                case .idle:
                    Image(systemName: "mic.fill")
                        .font(.subheadline.weight(.semibold))
                    Text("Dictar")
                        .font(.subheadline.weight(.semibold))
                case .recording:
                    Image(systemName: "stop.fill")
                        .font(.subheadline.weight(.semibold))
                    Text("Detener")
                        .font(.subheadline.weight(.semibold))
                case .transcribing, .polishing:
                    ProgressView().controlSize(.small)
                    Text("Procesando")
                        .font(.subheadline.weight(.semibold))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .foregroundStyle(controller.dictationPhase == .recording ? RistakTheme.onAccent : RistakTheme.textPrimary)
            .background(
                Capsule().fill(controller.dictationPhase == .recording
                    ? AnyShapeStyle(RistakTheme.neg)
                    : AnyShapeStyle(RistakTheme.controlRest))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!aiReady || controller.isSavingContext || controller.dictationPhase == .transcribing || controller.dictationPhase == .polishing)
        .sensoryFeedback(.impact, trigger: controller.dictationPhase == .recording)
        .accessibilityLabel(controller.dictationPhase == .recording ? "Detener dictado" : "Dictar")
    }
}

// MARK: - Controlador del panel

/// Estado y flujos del panel del agente: conexión de OpenAI, borrador del
/// contexto de negocio, guardado pulido y dictado por voz (doc 10 §4.14-4.16).
@MainActor
@Observable
final class SettingsAgentPanelController {
    enum DictationPhase: Equatable {
        case idle
        case recording
        case transcribing
        case polishing
    }

    // Conexión OpenAI.
    var apiKeyDraft = ""
    private(set) var isConnecting = false

    // Contexto de negocio.
    var contextDraft = ""
    private(set) var savedContext = ""
    private(set) var isSavingContext = false
    /// Pulso para el haptic de guardado exitoso.
    private(set) var savedPulse = 0

    // Dictado.
    private(set) var dictationPhase: DictationPhase = .idle
    private(set) var statusMessage: String?
    private(set) var statusIsError = false

    // Alertas.
    private(set) var alertTitle: String?
    private(set) var alertMessage: String?

    private let recorder = SettingsDictationRecorder()
    private weak var model: SettingsModel?
    private var didSyncOnce = false

    var isBusy: Bool {
        isSavingContext || dictationPhase != .idle
    }

    func attach(model: SettingsModel) {
        self.model = model
    }

    /// Sincroniza el borrador con el contexto guardado del backend (el
    /// sentinela de vacío ya viene mapeado a `""`). No pisa ediciones locales.
    func syncSavedContext(_ value: String?) {
        guard let value else { return }
        let draftMatchesSaved = contextDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            == savedContext.trimmingCharacters(in: .whitespacesAndNewlines)
        savedContext = value
        if !didSyncOnce || draftMatchesSaved {
            contextDraft = value
        }
        didSyncOnce = true
    }

    func clearAlert() {
        alertTitle = nil
        alertMessage = nil
    }

    func cancelRecordingIfNeeded() {
        if dictationPhase == .recording {
            recorder.discard()
            dictationPhase = .idle
            statusMessage = nil
            statusIsError = false
        }
    }

    // MARK: Estado visible

    /// Línea de estado bajo el editor (mensajes exactos doc 10 §4.15).
    func statusLine(aiReady: Bool) -> String {
        if let statusMessage { return statusMessage }
        return aiReady
            ? "El dictado se guarda automático al terminar."
            : "OpenAI debe estar conectado para dictar y pulir."
    }

    /// «Guardar» habilitado: agente listo, sin trabajo en vuelo, sin grabación,
    /// borrador no vacío y distinto del guardado (doc 10 §4.14).
    func canSaveContext(aiReady: Bool) -> Bool {
        let draft = contextDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let saved = savedContext.trimmingCharacters(in: .whitespacesAndNewlines)
        return aiReady && !isBusy && !draft.isEmpty && draft != saved
    }

    // MARK: Conectar OpenAI

    func connectOpenAI() async {
        let apiKey = apiKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !apiKey.isEmpty, !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }

        do {
            let status = try await AIAgentService.updateConfig(AIAgentConfigUpdate(apiKey: apiKey))
            model?.applyAgentStatus(status)
            apiKeyDraft = ""
        } catch let error as RistakAPIError {
            alertTitle = "OpenAI"
            alertMessage = error.message
        } catch {
            alertTitle = "OpenAI"
            alertMessage = "No se pudo conectar OpenAI. Intenta otra vez."
        }
    }

    // MARK: Guardar contexto (pulido IA)

    func saveContext() async {
        let answer = contextDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answer.isEmpty, !isSavingContext else { return }

        isSavingContext = true
        statusMessage = "Puliendo y guardando..."
        statusIsError = false
        defer { isSavingContext = false }

        await polishAndPersist(answer: answer)
    }

    /// `POST /business-context-answer`: el texto devuelto reemplaza el
    /// borrador y el guardado (doc 10 §4.14).
    private func polishAndPersist(answer: String) async {
        do {
            let result = try await AIAgentService.saveBusinessContext(answer: answer)
            let text = result.text ?? answer
            contextDraft = text
            savedContext = text
            if let status = result.status {
                model?.applyAgentStatus(status)
            }
            statusMessage = "Guardado."
            statusIsError = false
            savedPulse += 1
        } catch let error as RistakAPIError {
            statusMessage = nil
            presentOpenAIError(error, fallback: "No se pudo guardar la descripción del negocio.")
        } catch {
            statusMessage = nil
            alertTitle = "OpenAI"
            alertMessage = "No se pudo guardar la descripción del negocio."
        }
        if dictationPhase != .idle { dictationPhase = .idle }
    }

    // MARK: Dictado

    func toggleDictation() async {
        switch dictationPhase {
        case .idle:
            await startDictation()
        case .recording:
            await finishDictation()
        case .transcribing, .polishing:
            break
        }
    }

    private func startDictation() async {
        guard await recorder.requestPermission() else {
            alertTitle = "Micrófono bloqueado"
            alertMessage = "Este celular no permitió usar el micrófono."
            return
        }
        do {
            try recorder.start()
            dictationPhase = .recording
            statusMessage = "Grabando... toca detener cuando termines."
            statusIsError = false
        } catch {
            statusMessage = "No pude transcribir el audio."
            statusIsError = true
        }
    }

    private func finishDictation() async {
        guard let fileURL = recorder.stop() else {
            dictationPhase = .idle
            return
        }
        defer { try? FileManager.default.removeItem(at: fileURL) }

        dictationPhase = .transcribing
        statusMessage = "Transcribiendo audio..."
        statusIsError = false

        let audioData: Data
        do {
            audioData = try Data(contentsOf: fileURL)
        } catch {
            dictationPhase = .idle
            statusMessage = "No pude transcribir el audio."
            statusIsError = true
            return
        }

        do {
            let result = try await AIAgentService.transcribe(audioData: audioData)
            let transcript = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else {
                dictationPhase = .idle
                statusMessage = "No se detectó texto en el audio."
                statusIsError = true
                return
            }

            // Pulido + guardado automático con el transcript (doc 10 §4.15).
            dictationPhase = .polishing
            statusMessage = "Puliendo y guardando..."
            statusIsError = false
            await polishAndPersist(answer: transcript)
        } catch let error as RistakAPIError {
            dictationPhase = .idle
            statusMessage = "No pude transcribir el audio."
            statusIsError = true
            presentOpenAIError(error, fallback: nil)
        } catch {
            dictationPhase = .idle
            statusMessage = "No pude transcribir el audio."
            statusIsError = true
        }
    }

    // MARK: Errores OpenAI (409, doc 10 §4.4)

    private func presentOpenAIError(_ error: RistakAPIError, fallback: String?) {
        if error.needsOpenAIReconnect {
            alertTitle = "OpenAI"
            alertMessage = "Reconecta OpenAI para seguir usando el agente."
        } else if error.isOpenAIConfigurationIssue {
            alertTitle = "OpenAI"
            alertMessage = error.message
        } else if let fallback {
            alertTitle = "OpenAI"
            alertMessage = error.message.isEmpty ? fallback : error.message
        } else {
            alertTitle = "OpenAI"
            alertMessage = error.message
        }
    }
}
