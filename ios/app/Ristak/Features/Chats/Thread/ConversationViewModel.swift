import CoreLocation
import Foundation
import Observation
import SwiftUI
import UIKit

/// ViewModel del hilo de conversación + composer (docs research/04 y 05).
///
/// Reglas duras que implementa:
/// - Ids ESTABLES de `ChatJourneyParser` y merges identity-preserving: un poll
///   sin cambios es no-op de render (memoria del proyecto: jamás reemplazar el
///   array si es igual, jamás ids por índice).
/// - Paginación hacia atrás con `beforeMessageDate` + merge por id.
/// - Polling del hilo cada 4 s, acuses cada 12 s (solo con salientes
///   pendientes), programados autoritativos en cada poll.
/// - Envíos optimistas con `externalId` idempotente y reconciliación con la
///   copia del servidor (ventana ±4 min, paridad RN).
@MainActor
@Observable
final class ConversationViewModel {
    // MARK: Dependencias

    let contactID: String
    private let journeyService = JourneyService()
    private let chatsService = ChatsService()
    private let contactsService = ContactsService()
    private let scheduledService = ScheduledMessagesService()
    private let messagingService = MessagingService()
    private let agentService = AgentStateService()
    private let templatesService = TemplatesService()
    private let tagsService = TagsService()
    private let locationSender = LocationSender()
    private let chatEventsClient = ChatEventsClient()
    private let clock = PollingClock()

    /// Store de config (formatters con TZ del negocio, sugerencias IA).
    private(set) var appConfig: AppConfigStore?

    // MARK: Estado del contacto / header

    private(set) var seedContact: ChatContact?
    private(set) var contactDetail: ContactDetail?

    var displayName: String {
        let candidates = [contactDetail?.name, seedContact?.name, contactPhone]
        for candidate in candidates {
            if let candidate, !candidate.trimmingCharacters(in: .whitespaces).isEmpty {
                return candidate
            }
        }
        return "Contacto"
    }

    var contactPhone: String? {
        let phone = contactDetail?.phone ?? seedContact?.phone ?? ""
        return phone.isEmpty ? nil : phone
    }

    var avatarURL: URL? {
        let raw = contactDetail?.profilePhotoUrl ?? seedContact?.profilePhotoUrl ?? ""
        return raw.isEmpty ? nil : URL(string: raw)
    }

    /// Canal para el badge del avatar del header.
    var headerChannel: RistakChatChannel? {
        if let seed = seedContact {
            if let channel = RistakChatChannel(raw: seed.lastMessageChannel) { return channel }
            if let channel = RistakChatChannel(raw: seed.lastMessageTransport) { return channel }
        }
        if let last = serverMessages.last(where: { $0.direction != .system }) {
            return RistakChatChannel(raw: last.transport ?? last.channel)
        }
        return nil
    }

    /// Detalle bajo el nombre del header: teléfono o canal.
    var headerDetail: String {
        if let contactPhone { return contactPhone }
        switch headerChannel {
        case .instagram: return "Instagram"
        case .messenger, .facebook: return "Messenger"
        case .gmail: return "Correo"
        default: return ""
        }
    }

    // MARK: Estado del hilo

    private(set) var serverMessages: [ChatMessage] = []
    private(set) var optimisticMessages: [ChatMessage] = []
    private(set) var scheduledItems: [ScheduledChatMessage] = []
    private(set) var activityMarkers: [ConversationActivityMarker] = []
    private(set) var commentContexts: [String: CommentPostContext] = [:]

    private(set) var timeline: [ConversationTimelineItem] = []
    private(set) var combinedMessages: [ChatMessage] = []

    private(set) var isLoadingInitial = false
    private(set) var hasLoadedOnce = false
    private(set) var loadErrorMessage: String?
    private(set) var accessDenied = false

    private(set) var hasOlderMessages = false
    private(set) var isLoadingOlder = false
    private var oldestPageExhausted = false
    private var lastOlderRequestAt: Date?

    /// Tick para countdowns de programados (se refresca cada 30 s si hay).
    private(set) var scheduledTickNow = Date()
    private var scheduledTickTask: Task<Void, Never>?

    /// Señal para que la vista baje al final (envíos / mensaje nuevo abajo).
    private(set) var scrollToBottomSignal = 0
    /// Id que debe quedar arriba tras prepender historial.
    var pendingScrollAnchorID: String?
    /// La vista lo actualiza con la geometría del scroll.
    var isNearBottom = true

    var searchQuery: String = "" {
        didSet { if searchQuery != oldValue { rebuildTimeline() } }
    }

    // MARK: Estado del composer

    var draftText: String = ""
    var replyTarget: ChatMessage?
    private(set) var attachments: [ComposerAttachmentDraft] = []
    let voiceRecorder = VoiceRecorderController()
    private(set) var isSending = false

    private(set) var whatsAppStatus: WhatsAppAPIStatus?
    private(set) var selectedChannel: ComposerChannel = .whatsapp(phoneNumberId: "")
    private var channelResolved = false

    private(set) var agentStates: [ConversationAgentState] = []
    private(set) var agentActionInFlight = false
    /// Envío detenido esperando la decisión de agente (doc 05 §6.3).
    var agentConfirmationPending = false

    private(set) var aiSuggestInFlight = false

    // Sheets / alertas
    var alert: ConversationAlert?
    var templatesSheetReason: String?
    var isTemplatesSheetPresented = false
    var scheduleSheet: ScheduleSheetState?
    var infoMessage: ChatMessage?
    var isChannelSheetPresented = false
    var isTagSheetPresented = false
    var isAttachmentSheetPresented = false

    /// Payloads de mensajes fallidos para «Reintentar» (repone al composer).
    private var failedPayloads: [String: FailedSendPayload] = [:]

    private var lastFullJourneyFetch: Date?
    private var realtimeTask: Task<Void, Never>?

    struct FailedSendPayload {
        var text: String
        var attachment: ComposerAttachmentDraft?
    }

    // MARK: Init

    init(contactID: String, seedContact: ChatContact?) {
        self.contactID = contactID
        self.seedContact = seedContact
    }

    func bind(appConfig: AppConfigStore) {
        guard self.appConfig !== appConfig else { return }
        self.appConfig = appConfig
        rebuildTimeline()
    }

    private var formatters: BusinessFormatters {
        appConfig?.formatters ?? BusinessFormatters(
            timeZone: TimeZone(identifier: AppConfigStore.defaultTimeZoneIdentifier) ?? .current
        )
    }

    // MARK: - Carga inicial / refresh

    func loadInitial() async {
        guard !hasLoadedOnce else { return }
        isLoadingInitial = true
        loadErrorMessage = nil
        accessDenied = false
        defer { isLoadingInitial = false }

        do {
            try await loadConversation(reset: true)
            hasLoadedOnce = true
        } catch let error as RistakAPIError {
            if error.isAccessDenied {
                accessDenied = true
            } else if error.kind == .featureUnavailable {
                // Silencioso en cargas: se queda el vacío estándar.
                hasLoadedOnce = true
            } else {
                loadErrorMessage = error.message
            }
        } catch {
            loadErrorMessage = "No se pudo cargar la conversación."
        }

        guard hasLoadedOnce else { return }
        markRead()
        async let contactTask: Void = hydrateContactDetail()
        async let statusTask: Void = loadWhatsAppStatus()
        async let agentTask: Void = loadAgentStates()
        _ = await (contactTask, statusTask, agentTask)
        resolveDefaultChannelIfNeeded()
    }

    func retryInitialLoad() {
        hasLoadedOnce = false
        Task { await loadInitial() }
    }

    /// Poll silencioso (4 s / foreground / SSE). Nunca alerta ni muestra spinner.
    func refreshSilently() async {
        guard hasLoadedOnce else { return }
        try? await loadConversation(reset: false)
    }

    /// Carga del hilo: página reciente + programados (+ journey completo
    /// throttled 30 s para markers, gap doc 04 §10.18).
    private func loadConversation(reset: Bool) async throws {
        let needsMarkers = reset || lastFullJourneyFetch == nil
            || Date().timeIntervalSince(lastFullJourneyFetch!) > 30

        async let eventsTask = journeyService.fetchConversationEvents(
            contactId: contactID,
            limit: JourneyService.defaultMessageLimit
        )
        async let scheduledTask = fetchScheduledSafely()

        let events = try await eventsTask
        let scheduled = await scheduledTask

        let fresh = ChatJourneyParser.buildMessages(contactId: contactID, events: events)
        var freshContexts = ConversationTimelineBuilder.buildCommentContexts(from: events)

        let merged: [ChatMessage]
        if reset {
            merged = fresh
            oldestPageExhausted = fresh.count < JourneyService.defaultMessageLimit
        } else {
            merged = ChatJourneyParser.mergeById(serverMessages + fresh)
        }

        if !reset {
            freshContexts.merge(commentContexts) { fresh, _ in fresh }
        }

        applyServerMessages(merged, contexts: freshContexts)
        applyScheduled(scheduled)
        hasOlderMessages = !oldestPageExhausted && serverMessages.count >= JourneyService.defaultMessageLimit

        if needsMarkers {
            await refreshActivityMarkers()
        }
        rebuildTimeline()
    }

    private func fetchScheduledSafely() async -> [ScheduledChatMessage]? {
        try? await scheduledService.fetchScheduledMessages(contactId: contactID)
    }

    private func refreshActivityMarkers() async {
        guard let events = try? await journeyService.fetchFullJourney(contactId: contactID) else { return }
        lastFullJourneyFetch = Date()
        let markers = ConversationTimelineBuilder.buildMarkers(from: events, formatters: formatters)
        if markers != activityMarkers {
            activityMarkers = markers
            rebuildTimeline()
        }
    }

    /// Aplica mensajes del servidor con identidad preservada + reconciliación
    /// de optimistas (ventana ±4 min, RN `NATIVE_OPTIMISTIC_RECONCILE_WINDOW_MS`).
    private func applyServerMessages(_ messages: [ChatMessage], contexts: [String: CommentPostContext]) {
        let previousLatest = combinedMessages.last?.id

        if messages != serverMessages {
            serverMessages = messages
        }
        if contexts != commentContexts {
            commentContexts = contexts
        }
        reconcileOptimisticMessages()
        rebuildCombined()

        // Auto-revelar solo si el usuario ya está pegado abajo.
        if let latest = combinedMessages.last?.id, latest != previousLatest, isNearBottom {
            scrollToBottomSignal &+= 1
        }
    }

    private func applyScheduled(_ items: [ScheduledChatMessage]?) {
        guard let items else { return }
        if items != scheduledItems {
            scheduledItems = items
            rebuildCombined()
        }
        updateScheduledTicker()
    }

    private func reconcileOptimisticMessages() {
        guard !optimisticMessages.isEmpty else { return }
        let window: TimeInterval = 4 * 60
        let outboundServer = serverMessages.filter { $0.direction == .outbound }

        optimisticMessages.removeAll { optimistic in
            guard !optimistic.failed else { return false }
            guard let optimisticDate = optimistic.parsedDate else { return false }
            return outboundServer.contains { server in
                guard let serverDate = server.parsedDate else { return false }
                guard abs(serverDate.timeIntervalSince(optimisticDate)) <= window else { return false }
                if let provider = optimistic.providerMessageId, !provider.isEmpty,
                   server.providerMessageId == provider {
                    return true
                }
                let sameText = !optimistic.text.isEmpty
                    && optimistic.text.trimmingCharacters(in: .whitespacesAndNewlines)
                        == server.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let bothAttachments = optimistic.attachment != nil && server.attachment != nil
                let bothLocations = optimistic.location != nil && server.location != nil
                return sameText || bothAttachments || bothLocations
            }
        }
    }

    private func rebuildCombined() {
        var all = ChatJourneyParser.mergeById(serverMessages + optimisticMessages)
        all.append(contentsOf: ChatJourneyParser.buildScheduledMessages(contactId: contactID, items: scheduledItems))
        all.sort { ($0.parsedDate ?? .distantPast) < ($1.parsedDate ?? .distantPast) }
        if all != combinedMessages {
            combinedMessages = all
            rebuildTimeline()
        }
    }

    private func rebuildTimeline() {
        let items = ConversationTimelineBuilder.build(
            messages: combinedMessages,
            markers: activityMarkers,
            formatters: formatters,
            searchQuery: searchQuery
        )
        if items != timeline {
            timeline = items
        }
    }

    // MARK: - Paginación hacia atrás

    func loadOlderIfNeeded() {
        guard hasLoadedOnce, hasOlderMessages, !isLoadingOlder else { return }
        if let last = lastOlderRequestAt, Date().timeIntervalSince(last) < 1.0 { return }
        lastOlderRequestAt = Date()
        Task { await loadOlder() }
    }

    private func loadOlder() async {
        guard let before = JourneyService.oldestMessageDate(in: serverMessages) else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }

        let anchorID = serverMessages.first?.id

        do {
            let events = try await journeyService.fetchConversationEvents(
                contactId: contactID,
                limit: JourneyService.defaultMessageLimit,
                beforeMessageDate: before
            )
            let older = ChatJourneyParser.buildMessages(contactId: contactID, events: events)
            if older.count < JourneyService.defaultMessageLimit {
                oldestPageExhausted = true
                hasOlderMessages = false
            }
            guard !older.isEmpty else { return }
            var contexts = ConversationTimelineBuilder.buildCommentContexts(from: events)
            contexts.merge(commentContexts) { older, current in current }
            let merged = JourneyService.mergeOlderPage(existing: serverMessages, older: older)
            pendingScrollAnchorID = anchorID
            applyServerMessages(merged, contexts: contexts)
        } catch {
            // En error de red se reintenta después (paridad RN).
        }
    }

    // MARK: - Polling / realtime / presencia

    func startPolling() {
        clock.schedule("thread", every: PollingClock.Cadence.thread) { [weak self] in
            await self?.refreshSilently()
        }
        clock.schedule("receipts", every: PollingClock.Cadence.receipts) { [weak self] in
            guard let self, self.hasPendingReceipts else { return }
            await self.refreshSilently()
        }
        startRealtime()
        updateScheduledTicker()
    }

    func stopPolling() {
        clock.cancelAll()
        stopRealtime()
        scheduledTickTask?.cancel()
        scheduledTickTask = nil
    }

    func setScenePaused(_ paused: Bool) {
        clock.setPaused(paused)
        if paused {
            stopRealtime()
        } else {
            startRealtime()
        }
    }

    /// ¿Hay salientes con acuse pendiente? (gate del poll de 12 s).
    private var hasPendingReceipts: Bool {
        combinedMessages.contains { message in
            guard message.direction == .outbound, !message.isScheduled else { return false }
            let receipt = message.receiptStatus
            return receipt == .pending || receipt == .sent
        }
    }

    private func startRealtime() {
        guard realtimeTask == nil else { return }
        realtimeTask = Task { [weak self] in
            guard let self else { return }
            let stream = await self.chatEventsClient.start()
            for await event in stream {
                if case .message(let payload) = event, payload.contactId == self.contactID {
                    await self.refreshSilently()
                }
            }
        }
    }

    private func stopRealtime() {
        realtimeTask?.cancel()
        realtimeTask = nil
        Task { await chatEventsClient.stop() }
    }

    /// Nudge de push en foreground (NotificationRouter).
    func handleForegroundNudge(contactID nudgeContactID: String?) {
        guard nudgeContactID == nil || nudgeContactID == contactID else { return }
        Task { await refreshSilently() }
    }

    private func updateScheduledTicker() {
        let hasScheduled = !scheduledItems.isEmpty
        if hasScheduled, scheduledTickTask == nil {
            scheduledTickTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    guard let self else { return }
                    self.scheduledTickNow = Date()
                }
            }
        } else if !hasScheduled {
            scheduledTickTask?.cancel()
            scheduledTickTask = nil
        }
    }

    // MARK: - Hidratación secundaria

    private func hydrateContactDetail() async {
        if let detail = try? await contactsService.fetchContact(id: contactID, warmProfilePictures: true) {
            contactDetail = detail
        }
    }

    private func loadWhatsAppStatus() async {
        whatsAppStatus = try? await WhatsAppNumbersService.status()
    }

    func loadAgentStates() async {
        do {
            agentStates = try await agentService.fetchAllStates(contactId: contactID)
        } catch {
            agentStates = []
        }
    }

    private func markRead() {
        Task { try? await chatsService.markChatRead(contactId: contactID) }
    }

    // MARK: - Canal de envío

    var whatsAppPhones: [WhatsAppPhoneNumber] { whatsAppStatus?.phoneNumbers ?? [] }

    var selectedWhatsAppPhone: WhatsAppPhoneNumber? {
        guard case .whatsapp(let phoneId) = selectedChannel else { return nil }
        if !phoneId.isEmpty, let match = whatsAppPhones.first(where: { $0.id == phoneId }) {
            return match
        }
        return whatsAppPhones.first(where: { $0.isDefaultSender }) ?? whatsAppPhones.first
    }

    private func resolveDefaultChannelIfNeeded() {
        guard !channelResolved else { return }
        channelResolved = true

        let evidence = channelEvidence()
        if contactPhone == nil || contactPhone?.isEmpty == true {
            if evidence.contains("instagram") { selectedChannel = .instagram; return }
            if evidence.contains("messenger") || evidence.contains("facebook") { selectedChannel = .messenger; return }
        }

        let preferred = contactDetail?.preferredWhatsAppPhoneNumberId
            ?? seedContact?.preferredWhatsAppPhoneNumberId ?? ""
        let lastBusiness = seedContact?.lastBusinessPhoneNumberId ?? ""
        for candidate in [preferred, lastBusiness] where !candidate.isEmpty {
            if whatsAppPhones.contains(where: { $0.id == candidate }) {
                selectedChannel = .whatsapp(phoneNumberId: candidate)
                return
            }
        }
        let fallback = whatsAppPhones.first(where: { $0.isDefaultSender })?.id
            ?? whatsAppPhones.first?.id ?? ""
        selectedChannel = .whatsapp(phoneNumberId: fallback)
    }

    /// Probe de canales visto en el hilo/bandeja para habilitar Meta/SMS.
    private func channelEvidence() -> String {
        var pieces: [String] = []
        if let seed = seedContact {
            pieces.append(seed.lastMessageChannel)
            pieces.append(seed.lastMessageTransport)
        }
        for message in serverMessages.suffix(60) {
            pieces.append(message.channel)
            pieces.append(message.transport ?? "")
        }
        return pieces.joined(separator: " ").lowercased()
    }

    /// Opciones del sheet «Elegir canal de envío» (copys doc 05 §7.1).
    var channelOptions: [ComposerChannelOption] {
        var options: [ComposerChannelOption] = []
        let evidence = channelEvidence()
        let hasPhone = !(contactPhone ?? "").isEmpty

        if whatsAppPhones.isEmpty {
            options.append(
                ComposerChannelOption(
                    channel: .whatsapp(phoneNumberId: ""),
                    title: "WhatsApp",
                    subtitle: "Mensaje por WhatsApp conectado.",
                    disabledReason: whatsAppStatus?.connected == true
                        ? (hasPhone ? nil : "Este contacto no tiene teléfono guardado.")
                        : "Conecta WhatsApp API o QR para responder."
                )
            )
        } else {
            for (index, phone) in whatsAppPhones.enumerated() {
                let label = phone.label?.isEmpty == false ? phone.label! : "Número \(index + 1)"
                let available = phone.apiSendEnabled || phone.isQRConnected
                var reason: String?
                if !hasPhone {
                    reason = "Este contacto no tiene teléfono guardado."
                } else if !available {
                    reason = "Ese número de WhatsApp ya no está disponible."
                } else if (phone.displayPhoneNumber ?? phone.phoneNumber ?? "").isEmpty {
                    reason = "Ese WhatsApp todavía no tiene número detectado."
                }
                options.append(
                    ComposerChannelOption(
                        channel: .whatsapp(phoneNumberId: phone.id),
                        title: "WhatsApp · \(label)",
                        subtitle: phone.displayPhoneNumber ?? phone.phoneNumber ?? phone.verifiedName ?? "",
                        disabledReason: reason
                    )
                )
            }
        }

        options.append(
            ComposerChannelOption(
                channel: .messenger,
                title: "Messenger",
                subtitle: "Responde por Facebook Messenger.",
                disabledReason: (evidence.contains("messenger") || evidence.contains("facebook"))
                    ? nil
                    : "Activa Messenger en Configuración > Meta Ads para responder desde Ristak."
            )
        )
        options.append(
            ComposerChannelOption(
                channel: .instagram,
                title: "Instagram DM",
                subtitle: "Responde por Instagram Direct.",
                disabledReason: evidence.contains("instagram")
                    ? nil
                    : "Activa Instagram en Configuración > Meta Ads para responder desde Ristak."
            )
        )
        if evidence.contains("sms") || evidence.contains("ghl_") {
            options.append(
                ComposerChannelOption(
                    channel: .sms,
                    title: "SMS",
                    subtitle: "Responde por SMS vía HighLevel.",
                    disabledReason: hasPhone ? nil : "Este contacto no tiene teléfono guardado."
                )
            )
        }
        return options
    }

    func selectChannel(_ option: ComposerChannelOption) {
        if let reason = option.disabledReason {
            alert = ConversationAlert(title: "Canal no disponible", message: reason)
            return
        }
        selectedChannel = option.channel
        isChannelSheetPresented = false
    }

    // MARK: - Ventana de 24 h (preflight cliente, doc 05 §1.1)

    /// Último inbound WhatsApp cargado (no sms/meta/email).
    private var lastWhatsAppInboundDate: Date? {
        for message in serverMessages.reversed() where message.direction == .inbound {
            let probe = "\(message.channel) \(message.transport ?? "")".lowercased()
            let excluded = probe.contains("sms") || probe.contains("messenger")
                || probe.contains("instagram") || probe.contains("facebook")
                || probe.contains("mail") || message.isComment
            if !excluded {
                return message.parsedDate
            }
        }
        return nil
    }

    var apiReplyWindowOpen: Bool {
        WhatsAppReplyWindowRules.isWindowOpen(lastInboundDate: lastWhatsAppInboundDate)
    }

    private var selectedPhoneQRReady: Bool {
        guard let phone = selectedWhatsAppPhone else { return false }
        return phone.isQRConnected && phone.qrSendEnabled
    }

    /// Transporte resuelto para envíos libres WhatsApp (lógica /movil).
    private func resolveWhatsAppTransport() -> WhatsAppSendTransport {
        let phone = selectedWhatsAppPhone
        let apiAvailable = (whatsAppStatus?.connected ?? false) && (phone?.apiSendEnabled ?? false)
        if selectedPhoneQRReady && (!apiReplyWindowOpen || !apiAvailable) {
            return .qr
        }
        return .api
    }

    private func presentTemplatesSheet(reason: String?) {
        templatesSheetReason = reason
        isTemplatesSheetPresented = true
    }

    // MARK: - Envío principal

    var canSendDraft: Bool {
        !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty
            || voiceRecorder.hasPreview
    }

    var activeAgentStates: [ConversationAgentState] {
        agentStates.filter { $0.status.lowercased() == "active" }
    }

    func sendCurrentDraft(skipAgentConfirm: Bool = false) {
        guard canSendDraft, !isSending else { return }
        if !skipAgentConfirm, !activeAgentStates.isEmpty {
            agentConfirmationPending = true
            return
        }
        Task { await performSend() }
    }

    /// Decisión del diálogo «Agente activo» (doc 05 §6.3):
    /// `.pause` = «Pausar 24h y enviar», `.skip` = «Quitar del agente y enviar».
    func resolveAgentConfirmation(action: ConversationAgentAction?) {
        agentConfirmationPending = false
        guard let action else { return } // Cancelar: no se envía.
        Task {
            do {
                for state in activeAgentStates {
                    try await agentService.updateState(contactId: contactID, action: action, agentId: state.agentId)
                }
                await loadAgentStates()
                await performSend()
            } catch {
                alert = ConversationAlert(
                    title: "No se pudo pausar el agente",
                    message: "El mensaje no se envió. Intenta otra vez."
                )
            }
        }
    }

    private func performSend() async {
        isSending = true
        defer { isSending = false }

        // 1. Nota de voz pendiente.
        if voiceRecorder.hasPreview {
            await sendVoiceNote()
            return
        }

        let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        let pendingAttachments = attachments

        switch selectedChannel {
        case .messenger, .instagram:
            guard pendingAttachments.isEmpty else {
                alert = ConversationAlert(
                    title: "Solo texto por ahora",
                    message: "Messenger e Instagram desde Meta nativo mandan texto en este chat."
                )
                return
            }
            guard !text.isEmpty else {
                alert = ConversationAlert(title: "Escribe algo", message: "Manda un mensaje escrito desde este chat.")
                return
            }
            await sendMetaText(text)

        case .sms:
            guard !text.isEmpty || !pendingAttachments.isEmpty else { return }
            await sendHighLevel(text: text, drafts: pendingAttachments)

        case .whatsapp:
            guard let phone = contactPhone, !phone.isEmpty else {
                alert = ConversationAlert(
                    title: "Falta el teléfono",
                    message: "Guarda el número del contacto antes de escribir por WhatsApp."
                )
                return
            }
            // Ventana cerrada sin QR → forzar plantilla (doc 05 §1.1).
            if !apiReplyWindowOpen && !selectedPhoneQRReady {
                presentTemplatesSheet(reason: WhatsAppReplyWindowRules.closedReason)
                return
            }
            if pendingAttachments.isEmpty {
                await sendWhatsAppText(text, to: phone)
            } else {
                await sendWhatsAppAttachments(pendingAttachments, caption: text, to: phone)
            }
        }
    }

    // MARK: WhatsApp texto

    private func sendWhatsAppText(_ text: String, to phone: String) async {
        guard !text.isEmpty else { return }
        let externalId = MessageExternalIdFactory.text()
        let transport = resolveWhatsAppTransport()
        let reply = replyTarget

        var optimistic = makeOptimisticMessage(id: externalId, text: text, transport: transport.rawValue)
        optimistic.replyToMessageId = reply?.id
        optimistic.replyToProviderMessageId = reply?.providerMessageId
        appendOptimistic(optimistic, restore: FailedSendPayload(text: text, attachment: nil))
        clearComposerAfterSend()

        do {
            let result = try await messagingService.sendText(
                TextMessageSendRequest(
                    to: phone,
                    from: selectedWhatsAppPhone?.phoneNumber ?? selectedWhatsAppPhone?.displayPhoneNumber,
                    contactId: contactID,
                    text: text,
                    externalId: externalId,
                    transport: transport,
                    phoneNumberId: selectedWhatsAppPhone?.id,
                    replyToMessageId: reply?.id,
                    replyToProviderMessageId: reply?.providerMessageId
                )
            )
            applySendResult(result, to: externalId)
            await refreshSilently()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: text)
        }
    }

    // MARK: WhatsApp adjuntos

    private func sendWhatsAppAttachments(_ drafts: [ComposerAttachmentDraft], caption: String, to phone: String) async {
        clearComposerAfterSend()
        let transport = resolveWhatsAppTransport()

        for (index, draft) in drafts.enumerated() {
            let media = draft.media
            let externalId = MessageExternalIdFactory.make(media.kind.rawValue)
            let messageCaption = index == 0 ? caption : ""

            var optimistic = makeOptimisticMessage(id: externalId, text: messageCaption, transport: transport.rawValue)
            optimistic.messageType = media.kind.rawValue
            optimistic.attachment = ChatAttachment(
                type: attachmentKind(for: media.kind),
                dataUrl: media.kind == .image ? media.dataUrl : nil,
                name: media.filename,
                mimeType: media.mimeType,
                durationMs: media.durationMs,
                size: Double(media.sizeBytes)
            )
            appendOptimistic(optimistic, restore: FailedSendPayload(text: messageCaption, attachment: draft))

            do {
                let result: MessageSendResult
                switch media.kind {
                case .image:
                    result = try await messagingService.sendImage(
                        ImageMessageSendRequest(
                            to: phone,
                            from: selectedWhatsAppPhone?.phoneNumber,
                            contactId: contactID,
                            imageDataUrl: media.dataUrl,
                            caption: messageCaption.isEmpty ? nil : messageCaption,
                            externalId: externalId,
                            transport: transport,
                            phoneNumberId: selectedWhatsAppPhone?.id
                        )
                    )
                case .video:
                    result = try await messagingService.sendVideo(
                        VideoMessageSendRequest(
                            to: phone,
                            from: selectedWhatsAppPhone?.phoneNumber,
                            contactId: contactID,
                            videoDataUrl: media.dataUrl,
                            caption: messageCaption.isEmpty ? nil : messageCaption,
                            externalId: externalId,
                            transport: transport,
                            phoneNumberId: selectedWhatsAppPhone?.id
                        )
                    )
                case .audio:
                    result = try await messagingService.sendAudio(
                        AudioMessageSendRequest(
                            to: phone,
                            from: selectedWhatsAppPhone?.phoneNumber,
                            contactId: contactID,
                            audioDataUrl: media.dataUrl,
                            durationMs: media.durationMs,
                            voice: true,
                            externalId: externalId,
                            transport: transport,
                            phoneNumberId: selectedWhatsAppPhone?.id
                        )
                    )
                case .document:
                    result = try await messagingService.sendDocument(
                        DocumentMessageSendRequest(
                            to: phone,
                            from: selectedWhatsAppPhone?.phoneNumber,
                            contactId: contactID,
                            documentDataUrl: media.dataUrl,
                            filename: media.filename,
                            mimeType: media.mimeType,
                            caption: messageCaption.isEmpty ? nil : messageCaption,
                            externalId: externalId,
                            transport: transport,
                            phoneNumberId: selectedWhatsAppPhone?.id
                        )
                    )
                }
                applySendResult(result, to: externalId)
            } catch {
                handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
            }
        }
        await refreshSilently()
    }

    private func attachmentKind(for kind: ChatMediaKind) -> ChatAttachment.Kind {
        switch kind {
        case .image: return .image
        case .video: return .video
        case .audio: return .audio
        case .document: return .document
        }
    }

    // MARK: Nota de voz

    private func sendVoiceNote() async {
        guard let phone = contactPhone, !phone.isEmpty else {
            alert = ConversationAlert(
                title: "Falta el teléfono",
                message: "Guarda el número del contacto antes de escribir por WhatsApp."
            )
            return
        }
        guard selectedChannel.isWhatsApp || selectedChannel == .sms else {
            alert = ConversationAlert(
                title: "Solo texto por ahora",
                message: "Messenger e Instagram desde Meta nativo mandan texto en este chat."
            )
            return
        }
        guard let preview = voiceRecorder.consumePreview() else { return }

        let encoded: EncodedChatMedia
        do {
            encoded = try MediaEncoder.encodeAudioFile(at: preview.url, durationMs: preview.durationMs)
        } catch {
            alert = ConversationAlert(title: "Audio", message: error.localizedDescription)
            return
        }

        let externalId = MessageExternalIdFactory.audio()
        var optimistic = makeOptimisticMessage(id: externalId, text: "", transport: resolveWhatsAppTransport().rawValue)
        optimistic.messageType = "audio"
        optimistic.attachment = ChatAttachment(
            type: .audio,
            url: preview.url.absoluteString,
            name: encoded.filename,
            mimeType: encoded.mimeType,
            durationMs: preview.durationMs
        )
        appendOptimistic(optimistic, restore: FailedSendPayload(text: "", attachment: nil))

        do {
            if selectedChannel == .sms {
                let result = try await messagingService.sendHighLevelMessage(
                    HighLevelMessageSendRequest(
                        contactId: contactID,
                        channel: "sms_qr",
                        audioDataUrl: encoded.dataUrl,
                        durationMs: preview.durationMs,
                        externalId: externalId
                    )
                )
                applySendResult(result, to: externalId)
            } else {
                let result = try await messagingService.sendAudio(
                    AudioMessageSendRequest(
                        to: phone,
                        from: selectedWhatsAppPhone?.phoneNumber,
                        contactId: contactID,
                        audioDataUrl: encoded.dataUrl,
                        durationMs: preview.durationMs,
                        voice: true,
                        externalId: externalId,
                        transport: resolveWhatsAppTransport(),
                        phoneNumberId: selectedWhatsAppPhone?.id
                    )
                )
                applySendResult(result, to: externalId)
            }
            await refreshSilently()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    // MARK: Meta social / HighLevel

    private func sendMetaText(_ text: String) async {
        guard let platform = selectedChannel.metaPlatform else { return }
        let externalId = MessageExternalIdFactory.meta()
        let reply = replyTarget

        var optimistic = makeOptimisticMessage(
            id: externalId,
            text: text,
            transport: platform == .instagram ? "instagram" : "messenger"
        )
        optimistic.replyToMessageId = reply?.id
        optimistic.replyToProviderMessageId = reply?.providerMessageId
        appendOptimistic(optimistic, restore: FailedSendPayload(text: text, attachment: nil))
        clearComposerAfterSend()

        do {
            let result = try await messagingService.sendMetaSocialText(
                MetaSocialTextSendRequest(
                    contactId: contactID,
                    platform: platform,
                    message: text,
                    externalId: externalId,
                    replyToMessageId: reply?.id,
                    replyToProviderMessageId: reply?.providerMessageId
                )
            )
            applySendResult(result, to: externalId)
            await refreshSilently()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    private func sendHighLevel(text: String, drafts: [ComposerAttachmentDraft]) async {
        let externalId = MessageExternalIdFactory.highLevel()
        var optimistic = makeOptimisticMessage(id: externalId, text: text, transport: "ghl_sms")
        if let first = drafts.first {
            optimistic.attachment = ChatAttachment(
                type: attachmentKind(for: first.kind),
                dataUrl: first.kind == .image ? first.media.dataUrl : nil,
                name: first.filename,
                mimeType: first.media.mimeType
            )
        }
        appendOptimistic(optimistic, restore: FailedSendPayload(text: text, attachment: drafts.first))
        clearComposerAfterSend()

        do {
            let result = try await messagingService.sendHighLevelMessage(
                HighLevelMessageSendRequest(
                    contactId: contactID,
                    channel: "sms_qr",
                    message: text.isEmpty ? nil : text,
                    attachmentDataUrls: drafts.isEmpty ? nil : drafts.map {
                        HighLevelAttachmentDataUrl(
                            dataUrl: $0.media.dataUrl,
                            filename: $0.filename,
                            mimeType: $0.media.mimeType,
                            kind: $0.kind.rawValue
                        )
                    },
                    externalId: externalId
                )
            )
            applySendResult(result, to: externalId)
            await refreshSilently()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    // MARK: Plantillas

    func sendTemplate(_ template: WhatsAppTemplate) async {
        guard let phone = contactPhone, !phone.isEmpty else {
            alert = ConversationAlert(
                title: "Falta el teléfono",
                message: "Guarda el número del contacto antes de escribir por WhatsApp."
            )
            return
        }
        let externalId = MessageExternalIdFactory.template()
        let optimistic = makeOptimisticMessage(id: externalId, text: template.previewText, transport: "api")
        appendOptimistic(optimistic, restore: FailedSendPayload(text: "", attachment: nil))
        isTemplatesSheetPresented = false

        do {
            let result = try await messagingService.sendTemplate(
                TemplateSendRequest(
                    to: phone,
                    from: selectedWhatsAppPhone?.phoneNumber,
                    contactId: contactID,
                    templateId: template.id,
                    templateName: template.officialName ?? template.name,
                    language: template.language ?? "es_MX",
                    externalId: externalId,
                    phoneNumberId: selectedWhatsAppPhone?.id
                )
            )
            applySendResult(result, to: externalId)
            await refreshSilently()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    func fetchSendableTemplates() async throws -> [WhatsAppTemplate] {
        try await templatesService.fetchSendableTemplates()
    }

    // MARK: Ubicación

    func sendCurrentLocation() {
        guard !isSending else { return }
        if !attachments.isEmpty || voiceRecorder.phase != .idle {
            alert = ConversationAlert(
                title: "Termina el adjunto",
                message: "Envía o quita los adjuntos pendientes antes de compartir ubicación."
            )
            return
        }
        if replyTarget != nil {
            alert = ConversationAlert(
                title: "Respuesta solo con texto",
                message: "Para contestar un globo específico, manda texto. Para archivos o ubicación, cancela la respuesta primero."
            )
            return
        }
        Task { await performSendLocation() }
    }

    private func performSendLocation() async {
        let coordinate: CLLocationCoordinate2DBox
        do {
            let raw = try await locationSender.currentCoordinate()
            coordinate = CLLocationCoordinate2DBox(latitude: raw.latitude, longitude: raw.longitude)
        } catch let error as LocationSender.LocationError {
            let title = error == .denied ? "Ubicación bloqueada" : "Ubicación"
            alert = ConversationAlert(title: title, message: error.localizedDescription)
            return
        } catch {
            alert = ConversationAlert(title: "Ubicación", message: "No se pudo obtener tu ubicación. Intenta de nuevo.")
            return
        }

        // Meta/SMS: la ubicación viaja como texto con link (doc 05 §2.3).
        if !selectedChannel.isWhatsApp {
            let link = ChatLocation.googleMapsURL(latitude: coordinate.latitude, longitude: coordinate.longitude)
            draftText = "📍 Mi ubicación: \(link)"
            sendCurrentDraft()
            return
        }

        guard let phone = contactPhone, !phone.isEmpty else {
            alert = ConversationAlert(
                title: "Falta el teléfono",
                message: "Guarda el número del contacto antes de escribir por WhatsApp."
            )
            return
        }

        let externalId = MessageExternalIdFactory.location()
        var optimistic = makeOptimisticMessage(id: externalId, text: "", transport: resolveWhatsAppTransport().rawValue)
        optimistic.messageType = "location"
        optimistic.location = ChatLocation(
            latitude: coordinate.latitude,
            longitude: coordinate.longitude,
            url: ChatLocation.googleMapsURL(latitude: coordinate.latitude, longitude: coordinate.longitude)
        )
        appendOptimistic(optimistic, restore: FailedSendPayload(text: "", attachment: nil))

        do {
            let result = try await messagingService.sendLocation(
                LocationSendRequest(
                    to: phone,
                    from: selectedWhatsAppPhone?.phoneNumber,
                    contactId: contactID,
                    latitude: coordinate.latitude,
                    longitude: coordinate.longitude,
                    externalId: externalId,
                    transport: resolveWhatsAppTransport(),
                    phoneNumberId: selectedWhatsAppPhone?.id
                )
            )
            applySendResult(result, to: externalId)
            await refreshSilently()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    private struct CLLocationCoordinate2DBox {
        let latitude: Double
        let longitude: Double
    }

    // MARK: - Optimistas / resultado / fallo

    private func makeOptimisticMessage(id: String, text: String, transport: String) -> ChatMessage {
        ChatMessage(
            id: id,
            contactId: contactID,
            date: RistakDateParsing.isoString(from: Date()),
            direction: .outbound,
            text: text,
            channel: transport,
            status: "enviando",
            transport: transport,
            businessPhone: selectedWhatsAppPhone?.phoneNumber,
            businessPhoneNumberId: selectedWhatsAppPhone?.id,
            pending: true
        )
    }

    private func appendOptimistic(_ message: ChatMessage, restore: FailedSendPayload) {
        optimisticMessages.append(message)
        failedPayloads[message.id] = restore
        rebuildCombined()
        scrollToBottomSignal &+= 1
    }

    private func applySendResult(_ result: MessageSendResult, to externalId: String) {
        mutateMessage(id: externalId) { message in
            message.pending = false
            message.failed = false
            message.status = result.status?.isEmpty == false ? result.status : "sent"
            if let transport = result.transport, !transport.isEmpty {
                message.transport = transport
                message.channel = transport
            }
            message.routingReason = result.resolvedRoutingReason
            if let provider = result.wamid ?? result.remoteMessageId ?? result.id, !provider.isEmpty {
                message.providerMessageId = provider
            }
            if var attachment = message.attachment {
                let echo = result.image ?? result.video ?? result.audio ?? result.document ?? result.localMedia
                if let url = echo?.bestUrl {
                    attachment.url = url
                    attachment.dataUrl = nil
                    message.attachment = attachment
                }
            }
        }
        failedPayloads.removeValue(forKey: externalId)
    }

    private func handleSendFailure(_ error: Error, externalId: String, restoreOnWindowError: String?) {
        // 400 de ventana de 24 h → quitar burbuja, reponer texto y ofrecer
        // plantillas (doc 05 §1.1 / gap §10.5).
        if WhatsAppReplyWindowRules.isReplyWindowError(error) {
            removeOptimistic(id: externalId)
            if let restoreOnWindowError, draftText.isEmpty {
                draftText = restoreOnWindowError
            }
            presentTemplatesSheet(reason: (error as? RistakAPIError)?.message)
            return
        }

        let message = (error as? RistakAPIError)?.message ?? "No se pudo enviar el mensaje."
        mutateMessage(id: externalId) { bubble in
            bubble.pending = false
            bubble.failed = true
            bubble.status = "error"
            bubble.errorReason = message
        }
        alert = ConversationAlert(title: "No se envió el mensaje", message: message)
    }

    private func removeOptimistic(id: String) {
        optimisticMessages.removeAll { $0.id == id }
        failedPayloads.removeValue(forKey: id)
        rebuildCombined()
    }

    /// Reintentar un envío fallido: repone texto/adjunto al composer y quita
    /// la burbuja (paridad RN, doc 04 §7.2).
    func retryFailedMessage(_ message: ChatMessage) {
        guard message.failed else { return }
        if let payload = failedPayloads[message.id] {
            if !payload.text.isEmpty { draftText = payload.text }
            if let attachment = payload.attachment, attachments.count < ChatMediaLimits.maxDraftAttachments {
                attachments.append(attachment)
            }
        } else if !message.text.isEmpty {
            draftText = message.text
        }
        removeOptimistic(id: message.id)
    }

    private func clearComposerAfterSend() {
        draftText = ""
        attachments = []
        replyTarget = nil
        scrollToBottomSignal &+= 1
    }

    /// Muta un mensaje por id (optimistas o del servidor).
    private func mutateMessage(id: String, _ transform: (inout ChatMessage) -> Void) {
        if let index = optimisticMessages.firstIndex(where: { $0.id == id }) {
            var message = optimisticMessages[index]
            transform(&message)
            optimisticMessages[index] = message
            rebuildCombined()
            return
        }
        if let index = serverMessages.firstIndex(where: { $0.id == id }) {
            var message = serverMessages[index]
            transform(&message)
            serverMessages[index] = message
            rebuildCombined()
        }
    }

    // MARK: - Reacciones (doc 04 §5)

    func reactionCapability(for message: ChatMessage) -> ReactionCapability {
        guard message.direction == .inbound else {
            return .blocked(
                title: "Solo mensajes recibidos",
                message: "Las APIs oficiales reaccionan a mensajes que te mandó el contacto."
            )
        }
        let probe = "\(message.channel) \(message.transport ?? "")".lowercased()
        if message.isComment || probe.contains("ghl") || probe.contains("sms")
            || probe.contains("mail") || probe.contains("email") {
            return .blocked(
                title: "Canal sin reacción nativa",
                message: "Ese canal no expone una reacción real al globo desde su API."
            )
        }
        guard let provider = message.providerMessageId, !provider.isEmpty else {
            return .blocked(
                title: "Falta ID del mensaje",
                message: "Este mensaje no tiene el ID remoto necesario para reaccionar."
            )
        }
        if probe.contains("messenger") || probe.contains("instagram") || probe.contains("facebook") {
            return .metaHeartOnly
        }
        return .whatsapp
    }

    func react(to message: ChatMessage, emoji: String) {
        switch reactionCapability(for: message) {
        case .blocked(let title, let body):
            alert = ConversationAlert(title: title, message: body)
            return
        case .metaHeartOnly where emoji != "❤️":
            alert = ConversationAlert(
                title: "Reacción no disponible",
                message: "Meta solo permite reaccionar con corazón desde la API."
            )
            return
        default:
            break
        }
        Task { await performReaction(message: message, emoji: emoji) }
    }

    private func performReaction(message: ChatMessage, emoji: String) async {
        let reactionId = "local-reaction-\(Int(Date().timeIntervalSince1970 * 1000))"
        let previousReactions = message.reactions

        // Optimista: reemplaza cualquier reacción saliente previa.
        mutateMessage(id: message.id) { target in
            target.reactions.removeAll { $0.direction == .outbound }
            target.reactions.append(ChatMessageReaction(id: reactionId, emoji: emoji, direction: .outbound))
        }

        do {
            let probe = "\(message.channel) \(message.transport ?? "")".lowercased()
            if probe.contains("messenger") || probe.contains("instagram") || probe.contains("facebook") {
                let platform: MetaSocialPlatform = probe.contains("instagram") ? .instagram : .messenger
                _ = try await messagingService.sendMetaSocialReaction(
                    MetaSocialReactionSendRequest(
                        contactId: contactID,
                        platform: platform,
                        emoji: emoji,
                        targetMessageId: message.id,
                        targetProviderMessageId: message.providerMessageId
                    )
                )
            } else {
                let transport: WhatsAppSendTransport = probe.contains("qr") ? .qr : .api
                _ = try await messagingService.sendReaction(
                    ReactionSendRequest(
                        to: contactPhone ?? "",
                        from: message.businessPhone ?? selectedWhatsAppPhone?.phoneNumber,
                        contactId: contactID,
                        emoji: emoji,
                        targetMessageId: message.id,
                        targetProviderMessageId: message.providerMessageId,
                        transport: transport,
                        phoneNumberId: message.businessPhoneNumberId ?? selectedWhatsAppPhone?.id
                    )
                )
            }
        } catch {
            mutateMessage(id: message.id) { target in
                target.reactions = previousReactions
            }
            alert = ConversationAlert(title: "Reacción", message: "No se pudo mandar la reacción.")
        }
    }

    // MARK: - Responder / copiar

    func beginReply(to message: ChatMessage) {
        guard message.direction != .system, !message.isScheduled else { return }
        replyTarget = message
    }

    func cancelReply() {
        replyTarget = nil
    }

    func copyMessage(_ message: ChatMessage) {
        UIPasteboard.general.string = MessagePreviewText.preview(for: message)
    }

    /// Busca el original citado en la ventana cargada (RN `findNativeReplyTarget`).
    func findReplyTarget(for message: ChatMessage) -> ChatMessage? {
        let localId = message.replyToMessageId
        let providerId = message.replyToProviderMessageId
        guard localId != nil || providerId != nil else { return nil }
        return combinedMessages.first { candidate in
            if let localId, candidate.id == localId { return true }
            if let localId, candidate.scheduledMessageId == localId { return true }
            if let providerId, candidate.providerMessageId == providerId { return true }
            if let providerId, candidate.id == providerId { return true }
            return false
        }
    }

    // MARK: - Adjuntos del composer

    private func canAddAttachment() -> Bool {
        if replyTarget != nil {
            alert = ConversationAlert(
                title: "Respuesta solo con texto",
                message: "Para contestar un globo específico, manda texto. Para archivos, ubicación o notas de voz, cancela la respuesta primero."
            )
            return false
        }
        if voiceRecorder.phase != .idle {
            alert = ConversationAlert(
                title: "Termina la nota de voz",
                message: "Termina o elimina la nota de voz antes de agregar archivos."
            )
            return false
        }
        guard selectedChannel.isWhatsApp || selectedChannel == .sms else {
            alert = ConversationAlert(
                title: "Adjuntos por WhatsApp",
                message: "Los adjuntos nativos se envían por WhatsApp API/QR. Cambia el canal a WhatsApp para mandar este archivo."
            )
            return false
        }
        guard attachments.count < ChatMediaLimits.maxDraftAttachments else {
            alert = ConversationAlert(
                title: "Límite de adjuntos",
                message: "Puedes mandar hasta 4 adjuntos por mensaje."
            )
            return false
        }
        return true
    }

    func addCameraImage(_ image: UIImage) {
        guard canAddAttachment() else { return }
        do {
            let encoded = try MediaEncoder.encodeImage(image)
            attachments.append(
                ComposerAttachmentDraft(id: UUID().uuidString, media: encoded, previewImage: image)
            )
        } catch {
            alert = ConversationAlert(title: "Foto", message: error.localizedDescription)
        }
    }

    /// Media elegida de la fototeca (imagen o video ya en Data).
    func addPickedMedia(data: Data, mimeType: String?, filename: String?) {
        guard canAddAttachment() else { return }
        let mime = MediaEncoder.normalizeMime(mimeType)
        do {
            if mime.hasPrefix("video/") {
                // Video: escribir a tmp para validación por archivo.
                let ext = MediaEncoder.fileExtension(forMime: mime) ?? "mp4"
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent(filename ?? "video-\(Int(Date().timeIntervalSince1970)).\(ext)")
                try data.write(to: url)
                let encoded = try MediaEncoder.encodeVideoFile(at: url)
                attachments.append(ComposerAttachmentDraft(id: UUID().uuidString, media: encoded, previewImage: nil))
            } else {
                let encoded = try MediaEncoder.encodeImageData(data, mimeType: mime, filename: filename)
                attachments.append(
                    ComposerAttachmentDraft(id: UUID().uuidString, media: encoded, previewImage: UIImage(data: data))
                )
            }
        } catch {
            alert = ConversationAlert(title: "Adjunto", message: error.localizedDescription)
        }
    }

    func addDocument(at url: URL) {
        guard canAddAttachment() else { return }
        do {
            let encoded = try MediaEncoder.encodeDocumentFile(at: url)
            attachments.append(ComposerAttachmentDraft(id: UUID().uuidString, media: encoded, previewImage: nil))
        } catch {
            alert = ConversationAlert(title: "Documento", message: error.localizedDescription)
        }
    }

    func removeAttachment(_ id: String) {
        attachments.removeAll { $0.id == id }
    }

    // MARK: - Nota de voz (composer)

    func toggleVoiceRecording() {
        switch voiceRecorder.phase {
        case .idle:
            if !draftText.trimmingCharacters(in: .whitespaces).isEmpty || !attachments.isEmpty {
                alert = ConversationAlert(
                    title: "Manda primero lo que ya tienes",
                    message: "Envía o borra el texto y los adjuntos antes de grabar una nota de voz."
                )
                return
            }
            if replyTarget != nil {
                alert = ConversationAlert(
                    title: "Respuesta solo con texto",
                    message: "Para contestar un globo específico, manda texto. Para archivos, ubicación o notas de voz, cancela la respuesta primero."
                )
                return
            }
            guard let phone = contactPhone, !phone.isEmpty else {
                alert = ConversationAlert(title: "Falta el teléfono", message: "Guarda el número del contacto antes de escribir por WhatsApp.")
                return
            }
            Task {
                let granted = await voiceRecorder.requestPermission()
                guard granted else {
                    alert = ConversationAlert(
                        title: "Micrófono",
                        message: "Necesito permiso de micrófono para grabar notas de voz."
                    )
                    return
                }
                do {
                    try voiceRecorder.start()
                } catch {
                    alert = ConversationAlert(title: "Micrófono", message: error.localizedDescription)
                }
            }
        case .recording:
            let ok = voiceRecorder.stop()
            if !ok {
                alert = ConversationAlert(title: "Audio muy corto", message: "Graba un poquito más para poder enviarlo.")
            }
        case .preview:
            break
        }
    }

    // MARK: - Programados (doc 04 §4)

    func presentScheduleSheet() {
        if !attachments.isEmpty || voiceRecorder.phase != .idle {
            alert = ConversationAlert(
                title: "Programado",
                message: "Por ahora sólo se pueden programar mensajes escritos."
            )
            return
        }
        if selectedChannel.isMetaSocial {
            alert = ConversationAlert(
                title: "Programado",
                message: "La programación para Messenger e Instagram todavía no está disponible en Meta nativo. Puedes enviarlo al momento desde Ristak."
            )
            return
        }
        scheduleSheet = ScheduleSheetState(
            editingId: nil,
            externalId: nil,
            text: draftText,
            date: Date().addingTimeInterval(15 * 60)
        )
    }

    func beginEditingScheduled(message: ChatMessage) {
        guard let scheduledId = message.scheduledMessageId,
              let item = scheduledItems.first(where: { $0.id == scheduledId }) else {
            alert = ConversationAlert(title: "Programado", message: "No encontré el ID de esta programación.")
            return
        }
        scheduleSheet = ScheduleSheetState(
            editingId: item.id,
            externalId: item.externalId.isEmpty ? nil : item.externalId,
            text: item.text,
            date: RistakDateParsing.date(fromISO: item.scheduledAt) ?? Date().addingTimeInterval(15 * 60)
        )
    }

    /// Guarda la programación. `true` = éxito (cerrar sheet).
    func submitSchedule(_ state: ScheduleSheetState) async -> Bool {
        let text = state.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            alert = ConversationAlert(title: "Programado", message: "Escribe el mensaje que quieres programar.")
            return false
        }
        guard state.date.timeIntervalSinceNow > 10 else {
            alert = ConversationAlert(title: "Programado", message: "Elige una hora futura para programar el mensaje.")
            return false
        }
        guard let phone = contactPhone, !phone.isEmpty else {
            alert = ConversationAlert(title: "Programado", message: "Este contacto necesita teléfono para programar el mensaje.")
            return false
        }
        let fromPhone = selectedWhatsAppPhone?.phoneNumber ?? selectedWhatsAppPhone?.displayPhoneNumber
        guard let fromPhone, !fromPhone.isEmpty else {
            alert = ConversationAlert(title: "Programado", message: "Elige el WhatsApp del negocio que mandará el mensaje.")
            return false
        }

        do {
            _ = try await scheduledService.upsert(
                ScheduledMessageUpsertRequest(
                    id: state.editingId,
                    contactId: contactID,
                    provider: "whatsapp_api",
                    transport: resolveWhatsAppTransport().rawValue,
                    messageType: "text",
                    text: text,
                    toPhone: phone,
                    fromPhone: fromPhone,
                    businessPhoneNumberId: selectedWhatsAppPhone?.id,
                    scheduledAt: RistakDateParsing.isoString(from: state.date),
                    externalId: state.externalId
                )
            )
            if state.editingId == nil, draftText == state.text {
                draftText = ""
            }
            applyScheduled(await fetchScheduledSafely())
            rebuildCombined()
            return true
        } catch {
            alert = ConversationAlert(
                title: "Programado",
                message: (error as? RistakAPIError)?.message ?? "No se pudo programar el mensaje."
            )
            return false
        }
    }

    func cancelScheduled(message: ChatMessage) {
        guard let scheduledId = message.scheduledMessageId else {
            alert = ConversationAlert(title: "Programado", message: "No encontré el ID de esta programación.")
            return
        }
        // Remoción local optimista + DELETE (doc 04 §4.2).
        scheduledItems.removeAll { $0.id == scheduledId }
        rebuildCombined()
        Task {
            do {
                _ = try await scheduledService.cancel(id: scheduledId, contactId: contactID)
            } catch {
                alert = ConversationAlert(title: "Programado", message: "No se pudo cancelar el mensaje.")
                applyScheduled(await fetchScheduledSafely())
            }
        }
    }

    // MARK: - Agente conversacional (doc 05 §6.4)

    var agentBannerText: String? {
        guard !agentStates.isEmpty else { return nil }
        if agentStates.count > 1 {
            return "\(agentStates.count) agentes asignados"
        }
        switch agentStates[0].status.lowercased() {
        case "active": return "El agente atiende este chat."
        case "paused": return "Agente pausado por 24hrs en este chat."
        case "human": return "Conversación tomada por un humano."
        case "skipped": return "Agente omitido en este chat."
        case "completed": return "El agente ya cumplió el objetivo aquí."
        case "discarded": return "Conversación descartada por el agente."
        default: return nil
        }
    }

    func performAgentAction(_ action: ConversationAgentAction, state: ConversationAgentState) {
        guard !agentActionInFlight else { return }
        agentActionInFlight = true
        Task {
            defer { agentActionInFlight = false }
            do {
                _ = try await agentService.updateState(contactId: contactID, action: action, agentId: state.agentId)
                await loadAgentStates()
                let name = state.agentName ?? "El agente"
                switch action {
                case .pause:
                    alert = ConversationAlert(title: "Agente", message: "\(name) quedó pausado por 24hrs en este chat.")
                case .skip:
                    alert = ConversationAlert(title: "Agente", message: "\(name) quedó omitido en este chat.")
                case .activate, .resume:
                    alert = ConversationAlert(title: "Agente", message: "\(name) volvió a atender este chat.")
                case .takeOver:
                    alert = ConversationAlert(title: "Agente", message: "La conversación quedó en manos humanas.")
                case .clearSignal:
                    break
                }
            } catch {
                alert = ConversationAlert(
                    title: "Agente",
                    message: (error as? RistakAPIError)?.message ?? "No se pudo actualizar el agente."
                )
            }
        }
    }

    // MARK: - Sugerencia IA (doc 05 §7.1)

    var aiSuggestionsEnabled: Bool {
        appConfig?.aiReplySuggestionsEnabled ?? false
    }

    func suggestReply() {
        guard !aiSuggestInFlight else { return }
        aiSuggestInFlight = true
        Task {
            defer { aiSuggestInFlight = false }
            let history = combinedMessages.filter { !$0.isScheduled }.suffix(10).map { message -> String in
                let role: String
                switch message.direction {
                case .outbound: role = "Negocio"
                case .inbound: role = "Cliente"
                case .system: role = "Sistema"
                }
                return "\(role): \(MessagePreviewText.preview(for: message))"
            }
            let prompt = """
            Sugiere la siguiente respuesta breve del negocio para este chat. \
            Responde SOLO con el texto sugerido, sin comillas ni explicación.

            \(history.joined(separator: "\n"))
            """
            do {
                let result = try await AIAgentService.chat(
                    AIAgentChatRequest(messages: [AIAgentChatMessagePayload(role: "user", content: prompt)])
                )
                if let reply = result.reply?.trimmingCharacters(in: .whitespacesAndNewlines), !reply.isEmpty {
                    draftText = reply
                } else {
                    alert = ConversationAlert(title: "No se pudo sugerir", message: "El agente no devolvió una sugerencia.")
                }
            } catch let error as RistakAPIError where error.isOpenAIConfigurationIssue {
                alert = ConversationAlert(title: "OpenAI no está listo", message: error.message)
            } catch {
                alert = ConversationAlert(
                    title: "No se pudo sugerir",
                    message: (error as? RistakAPIError)?.message ?? "Intenta de nuevo."
                )
            }
        }
    }

    // MARK: - Etiquetas

    func fetchTags() async throws -> [ContactTag] {
        try await tagsService.fetchTags()
    }

    func addTag(_ tagIdOrName: String) async -> Bool {
        do {
            _ = try await tagsService.addTag(tagIdOrName, toContact: contactID)
            alert = ConversationAlert(title: "Etiqueta", message: "Etiqueta agregada al contacto.")
            return true
        } catch {
            alert = ConversationAlert(
                title: "Etiqueta",
                message: (error as? RistakAPIError)?.message ?? "No se pudo agregar la etiqueta."
            )
            return false
        }
    }
}
