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
    /// Puente directo hacia la bandeja: el hilo puede estar cubriendola en
    /// iPhone, pero sus filas deben seguir reaccionando en tiempo real.
    private let onInboxActivity: (ChatInboxActivity) -> Void
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
        if let selected = seedContact?.matchedPhone,
           !selected.isEmpty {
            if let contactDetail {
                if ChatNavigationDestinationResolver.validationStatus(
                    phone: selected,
                    contact: contactDetail
                ) == .valid {
                    return selected
                }
            } else if seedContact?.destinationPhoneRequiresValidation == true {
                return nil
            } else {
                return selected
            }
        }
        let phone = contactDetail?.phone ?? seedContact?.phone ?? ""
        return phone.isEmpty ? nil : phone
    }

    /// Correo del contacto (para el proxy de cobro presentado desde el header).
    var contactEmail: String? {
        let email = contactDetail?.email ?? seedContact?.email ?? ""
        return email.isEmpty ? nil : email
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
    /// Filas del servidor ya absorbidas por un globo optimista estable. Se
    /// excluyen del combinado para no pintar dos veces el mismo envío.
    private var reconciledServerMessageIDs: Set<String> = []
    private(set) var scheduledItems: [ScheduledChatMessage] = []
    private(set) var activityMarkers: [ConversationActivityMarker] = []
    private(set) var commentContexts: [String: CommentPostContext] = [:]

    private(set) var timeline: [ConversationTimelineItem] = []
    /// Timeline reagrupado por día para la lista con cabeceras pegajosas. Se
    /// computa UNA vez aquí cada vez que `timeline` cambia (en `rebuildTimeline`),
    /// para que la vista no re-agrupe O(n) en cada render.
    private(set) var dayGroups: [ConversationDayGroup] = []
    private(set) var combinedMessages: [ChatMessage] = []

    private(set) var isLoadingInitial = false
    private(set) var hasLoadedOnce = false
    private(set) var loadErrorMessage: String?
    private(set) var accessDenied = false
    /// La hidratación desde caché instantánea corre una sola vez por hilo.
    private var threadCacheHydrated = false

    /// Coalescing del refresh silencioso: el poll de 4 s, el de acuses (12 s), cada
    /// evento SSE, el nudge de push y cada envío disparan `refreshSilently`. Sin
    /// guard, un burst lanzaba N fetches completos solapados. Con estos flags se
    /// colapsa a lo sumo uno en vuelo + uno encolado (paridad con la bandeja).
    private var refreshInFlight = false
    private var refreshQueued = false

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
    private(set) var attachmentPreparationCount = 0
    var isPreparingAttachments: Bool { attachmentPreparationCount > 0 }
    @ObservationIgnored private var attachmentPreparationTasks: [UUID: Task<Void, Never>] = [:]
    let voiceRecorder = VoiceRecorderController()
    private(set) var isSending = false

    private(set) var whatsAppStatus: WhatsAppAPIStatus?
    private(set) var selectedChannel: ComposerChannel = .whatsapp(phoneNumberId: "")
    private var channelResolved = false

    private(set) var agentStates: [ConversationAgentState] = []
    private(set) var agentActionInFlight = false
    private(set) var clearingAgentSignal = false
    /// Última vez que el poll/SSE refrescó el estado del agente (throttle 10 s).
    private var lastAgentStatesFetch: Date?
    /// Controla la presentación del sheet de controles del agente (header robot).
    var agentControlsPresented = false
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

    /// `externalId`s cuyo POST sigue en vuelo (aún sin respuesta ni fallo). La
    /// reconciliación JAMÁS elimina una burbuja en vuelo: evita que un eco
    /// "ok" previo borre el globo que aún se está enviando (y con él su estado
    /// de reintento/fallo).
    private var inFlightExternalIds: Set<String> = []

    private var lastFullJourneyFetch: Date?
    private var realtimeTask: Task<Void, Never>?
    /// Cadena serial de operaciones start/stop del engine SSE.
    private var realtimeControl: Task<Void, Never>?

    struct FailedSendPayload {
        var text: String
        var attachment: ComposerAttachmentDraft?
    }

    // MARK: Init

    init(
        contactID: String,
        seedContact: ChatContact?,
        onInboxActivity: @escaping (ChatInboxActivity) -> Void
    ) {
        self.contactID = contactID
        self.seedContact = seedContact
        self.onInboxActivity = onInboxActivity
        // Caché instantánea: hidrata ANTES del primer render para que el hilo
        // se pinte con los últimos mensajes sin flash de vacío/spinner.
        hydrateThreadFromCache()
        // Igual para el estado del agente: el robot del header se pinta en el
        // PRIMER frame desde caché, sin esperar el fetch en frío (~10 s).
        hydrateAgentStatesFromCache()
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
        let performanceSpan = RistakObservability.begin(.conversationInitialLoad)
        var performanceOutcome: RistakPerformanceOutcome = .failed
        var performanceSpanFinished = false
        if !timeline.isEmpty {
            performanceSpan.finish(
                outcome: .success,
                itemCount: combinedMessages.count
            )
            performanceSpanFinished = true
        }
        // Caché instantánea (Round 6 #4): pinta los últimos mensajes guardados
        // al instante; el spinner solo aparece si NO hay nada cacheado. Luego se
        // revalida contra la red (merge identity-preserving con ids estables).
        hydrateThreadFromCache()
        // Robot del header al instante desde caché (idempotente vs. el hidrato
        // del init). La revalidación de red sigue corriendo abajo.
        hydrateAgentStatesFromCache()
        isLoadingInitial = timeline.isEmpty
        loadErrorMessage = nil
        accessDenied = false
        defer { isLoadingInitial = false }

        // El estado del agente NO depende de la conversación: láncalo EN PARALELO
        // al fetch del hilo para que un server frío no lo serialice detrás de él
        // (antes corría DESPUÉS de cargar la conversación → robot ~10 s tarde).
        async let agentTask: Void = loadAgentStates()

        do {
            try await loadConversation(reset: true)
            hasLoadedOnce = true
            performanceOutcome = .success
        } catch let error as RistakAPIError {
            if error.isAccessDenied {
                accessDenied = true
                performanceOutcome = .unavailable
            } else if error.kind == .featureUnavailable {
                // Silencioso en cargas: se queda el vacío estándar.
                hasLoadedOnce = true
                performanceOutcome = .unavailable
            } else {
                loadErrorMessage = error.message
                if error.kind == .network || error.kind == .starting || error.kind == .notConfigured {
                    performanceOutcome = .unavailable
                }
            }
        } catch is CancellationError {
            performanceOutcome = .cancelled
        } catch {
            loadErrorMessage = "No se pudo cargar la conversación."
        }

        if !performanceSpanFinished {
            performanceSpan.finish(
                outcome: performanceOutcome,
                itemCount: combinedMessages.count
            )
        }

        // Espera SIEMPRE el fetch del agente ya en vuelo (aunque la conversación
        // falle) para no dejar una tarea hija colgada.
        await agentTask

        guard hasLoadedOnce else { return }
        markRead()
        async let contactTask: Void = hydrateContactDetail()
        async let statusTask: Void = loadWhatsAppStatus()
        _ = await (contactTask, statusTask)
        resolveDefaultChannelIfNeeded()
    }

    func retryInitialLoad() {
        hasLoadedOnce = false
        Task { await loadInitial() }
    }

    /// Poll silencioso (4 s / foreground / SSE). Nunca alerta ni muestra spinner.
    /// Coalescido: si ya hay uno en vuelo, encola UNO más y regresa; el que está
    /// corriendo repite al terminar. Así un burst de eventos SSE + poll + envío no
    /// dispara fetches completos solapados. (`@MainActor` → los flags no compiten.)
    func refreshSilently() async {
        guard hasLoadedOnce else { return }
        if refreshInFlight {
            refreshQueued = true
            return
        }
        refreshInFlight = true
        defer { refreshInFlight = false }
        repeat {
            refreshQueued = false
            try? await loadConversation(reset: false)
        } while refreshQueued
        // El estado del agente puede cambiar por detrás (el bot responde, marca
        // objetivo, otro dispositivo lo pausa): refréscalo junto al poll/SSE para
        // que el header y el banner no se queden pegados. Throttled y sin bloquear.
        Task { await refreshAgentStatesIfStale() }
    }

    /// El POST aceptado ya deja la burbuja optimista y la fila de bandeja en su
    /// estado correcto. La descarga autoritativa corre aparte para no mantener
    /// `isSending` ni el composer bloqueados durante otra vuelta de red.
    private func scheduleServerReconciliation() {
        Task { [weak self] in
            await self?.refreshSilently()
        }
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
        // Los markers (pagos/citas del journey completo) viven en una SEGUNDA
        // petición; lánzala EN PARALELO a la de eventos —no en serie después del
        // primer pintado— para que su inserción quepa en el MISMO relayout y no
        // reacomode el hilo una vez más al entrar.
        async let markersTask = fetchMarkersIfNeeded(needsMarkers)

        let events = try await eventsTask
        let appBaseURL = await journeyService.currentBaseURL()
        let fresh = ChatJourneyParser.buildMessages(contactId: contactID, events: events, appBaseURL: appBaseURL)
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

        // Primer pintado: los mensajes visibles no deben esperar al journey
        // completo ni a programados. En un contacto sin caché esta suspensión
        // permite que SwiftUI pinte el hilo apenas responde `/conversation`.
        applyServerMessages(merged, contexts: freshContexts)
        hasOlderMessages = !oldestPageExhausted && serverMessages.count >= JourneyService.defaultMessageLimit
        await Task.yield()

        // Los datos secundarios ya estaban en vuelo en paralelo. Se aplican
        // después del primer frame para que pagos/citas/programados completen el
        // timeline sin bloquear la conversación principal.
        let scheduled = await scheduledTask
        let freshMarkers = await markersTask

        if needsMarkers, let markers = freshMarkers {
            lastFullJourneyFetch = Date()
            if markers != activityMarkers {
                activityMarkers = markers
                persistThreadMarkers()
            }
        }

        applyScheduled(scheduled)
        rebuildTimeline()
    }

    private func fetchScheduledSafely() async -> [ScheduledChatMessage]? {
        try? await scheduledService.fetchScheduledMessages(contactId: contactID)
    }

    /// Fetch + build de markers SIN efectos secundarios (para lanzarlo en
    /// paralelo con la petición de eventos). Devuelve nil si no toca refrescar
    /// (deja intactos los markers cacheados) o si la red falla —en ese caso
    /// `lastFullJourneyFetch` no se toca y se reintenta en el siguiente poll—.
    private func fetchMarkersIfNeeded(_ needed: Bool) async -> [ConversationActivityMarker]? {
        guard needed else { return nil }
        guard let events = try? await journeyService.fetchFullJourney(contactId: contactID) else { return nil }
        return ConversationTimelineBuilder.buildMarkers(from: events, formatters: formatters)
    }

    /// Hidrata el hilo desde la caché instantánea (los mensajes del servidor
    /// que se vieron por última vez). No marca `hasLoadedOnce`: la revalidación
    /// contra la red sigue corriendo normal.
    private func hydrateThreadFromCache() {
        guard !threadCacheHydrated else { return }
        threadCacheHydrated = true
        guard serverMessages.isEmpty else { return }
        let cached = ChatThreadSnapshotCache.load(contactID: contactID)
        guard !cached.isEmpty else { return }
        serverMessages = cached
        // Markers cacheados: el PRIMER pintado ya incluye pagos/citas en su sitio,
        // así se elimina la segunda pasada de red tardía que reacomodaba el hilo
        // al entrar. Se fija antes de `rebuildCombined` para que el timeline se
        // construya una sola vez con todo dentro.
        activityMarkers = ChatThreadSnapshotCache.loadMarkers(contactID: contactID)
        rebuildCombined()
    }

    /// Guarda los markers de actividad para que el próximo arranque del hilo los
    /// pinte al instante (sin esperar el journey completo).
    private func persistThreadMarkers() {
        ChatThreadSnapshotCache.saveMarkers(activityMarkers, contactID: contactID)
    }

    /// Guarda los últimos mensajes del servidor (nunca optimistas) para reabrir
    /// el hilo al instante la próxima vez.
    private func persistThreadCache() {
        ChatThreadSnapshotCache.save(serverMessages, contactID: contactID)
    }

    /// Hidrata el estado del agente desde la caché instantánea para pintar el
    /// robot del header (controles/activo/señal) AL INSTANTE, sin esperar los
    /// ~10 s del fetch en frío. Idempotente y no destructivo: solo hidrata si aún
    /// no hay estados en memoria (una recarga no pisa un fetch reciente).
    private func hydrateAgentStatesFromCache() {
        guard agentStates.isEmpty else { return }
        let cached = ChatThreadSnapshotCache.load(agentStatesContactID: contactID)
        guard !cached.isEmpty else { return }
        agentStates = cached
    }

    /// Persiste el estado RAW del agente (sin filtrar phantoms) para que el
    /// próximo arranque del hilo pinte el robot al instante. `assignedAgentStates`
    /// decide qué se MUESTRA; guardar el RAW conserva el historial sin cambiar lo
    /// visible.
    private func persistAgentStatesCache() {
        ChatThreadSnapshotCache.save(agentStates, contactID: contactID)
    }

    /// Aplica mensajes del servidor con identidad preservada + reconciliación
    /// de optimistas (ventana ±4 min, RN `NATIVE_OPTIMISTIC_RECONCILE_WINDOW_MS`).
    private func applyServerMessages(_ messages: [ChatMessage], contexts: [String: CommentPostContext]) {
        let messagesChanged = messages != serverMessages
        let contextsChanged = contexts != commentContexts

        // Poll idéntico y sin optimistas que reconciliar: no hay nada que hacer.
        // Evita el merge+sort del hilo (reconcileOptimisticMessages/rebuildCombined)
        // en el hilo principal cada 4 s cuando el servidor devuelve lo mismo. NO se
        // puede saltar si hay optimistas: un eco maduro necesita esa pasada para
        // borrar el globo optimista.
        guard messagesChanged || contextsChanged || !optimisticMessages.isEmpty else { return }

        let previousLatest = combinedMessages.last?.id

        if messagesChanged {
            serverMessages = messages
            persistThreadCache()
        }
        if contextsChanged {
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
        guard !optimisticMessages.isEmpty else {
            reconciledServerMessageIDs.removeAll()
            return
        }
        let window: TimeInterval = 4 * 60
        let outboundServer = serverMessages.filter { $0.direction == .outbound }
        var availableServerIndexes = Set(outboundServer.indices)
        var matchedServerByOptimisticIndex: [Int: Int] = [:]
        let candidateIndexes = optimisticMessages.indices.filter { index in
            let message = optimisticMessages[index]
            return !message.failed && !inFlightExternalIds.contains(message.id)
        }

        // Primera pasada: identidad definitiva. Se hace antes del fallback para
        // que un mensaje de texto parecido nunca consuma el eco que pertenece a
        // otro optimista con providerMessageId conocido.
        for optimisticIndex in candidateIndexes {
            let optimistic = optimisticMessages[optimisticIndex]
            guard let provider = optimistic.providerMessageId, !provider.isEmpty else { continue }
            guard let match = availableServerIndexes.first(where: { index in
                outboundServer[index].providerMessageId == provider
            }) else { continue }
            availableServerIndexes.remove(match)
            matchedServerByOptimisticIndex[optimisticIndex] = match
        }

        // Segunda pasada: fallback estricto para los que aun no tienen match.
        // Cada eco puede satisfacer exactamente una burbuja local.
        for optimisticIndex in candidateIndexes where matchedServerByOptimisticIndex[optimisticIndex] == nil {
            let optimistic = optimisticMessages[optimisticIndex]
            guard let optimisticDate = optimistic.parsedDate else { continue }
            let orderedIndexes = availableServerIndexes.sorted { lhs, rhs in
                let left = outboundServer[lhs].parsedDate ?? .distantFuture
                let right = outboundServer[rhs].parsedDate ?? .distantFuture
                return abs(left.timeIntervalSince(optimisticDate))
                    < abs(right.timeIntervalSince(optimisticDate))
            }
            guard let match = orderedIndexes.first(where: { index in
                let server = outboundServer[index]
                guard let serverDate = server.parsedDate else { return false }
                guard abs(serverDate.timeIntervalSince(optimisticDate)) <= window else { return false }
                guard serverDate.timeIntervalSince(optimisticDate) >= -5 else { return false }
                let sameText = !optimistic.text.isEmpty
                    && optimistic.text.trimmingCharacters(in: .whitespacesAndNewlines)
                        == server.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let bothAttachments = optimistic.attachment?.type == server.attachment?.type
                    && optimistic.attachment != nil
                let bothLocations = optimistic.location != nil && server.location != nil
                return sameText || bothAttachments || bothLocations
            }) else { continue }
            availableServerIndexes.remove(match)
            matchedServerByOptimisticIndex[optimisticIndex] = match
        }

        var consumedServerIDs: Set<String> = []
        for (optimisticIndex, serverIndex) in matchedServerByOptimisticIndex {
            let optimistic = optimisticMessages[optimisticIndex]
            let server = outboundServer[serverIndex]
            consumedServerIDs.insert(server.id)

            // La fila remota trae status/ACK/URL autoritativos, pero la identidad,
            // fecha y data URL local permanecen. SwiftUI conserva la misma fila y
            // la foto no desaparece para volver a descargarse.
            var stable = server
            stable.id = optimistic.id
            stable.date = optimistic.date
            stable.text = server.text.isEmpty ? optimistic.text : server.text
            stable.pending = false
            stable.failed = false
            if stable.providerMessageId?.isEmpty != false {
                stable.providerMessageId = optimistic.providerMessageId
            }
            stable.attachment = Self.reconciledAttachment(
                server: server.attachment,
                optimistic: optimistic.attachment
            )
            optimisticMessages[optimisticIndex] = stable
        }

        reconciledServerMessageIDs = consumedServerIDs
    }

    /// Conserva el preview binario únicamente mientras el servidor todavía no
    /// devuelve una URL HTTP(S) remota. Un `data:` base64 no es remoto: ocupa
    /// más memoria que el binario y no debe provocar que se conserve esa copia
    /// inflada en vez del preview local.
    nonisolated static func reconciledAttachment(
        server: ChatAttachment?,
        optimistic: ChatAttachment?
    ) -> ChatAttachment? {
        guard var merged = server else { return optimistic }
        guard let optimistic else { return merged }

        let hasRemoteSource: Bool = {
            guard let raw = merged.url?.trimmingCharacters(in: .whitespacesAndNewlines),
                  let url = URL(string: raw),
                  let scheme = url.scheme?.lowercased(),
                  url.host?.isEmpty == false else { return false }
            return scheme == "http" || scheme == "https"
        }()
        merged.localPreviewData = hasRemoteSource ? nil : optimistic.localPreviewData
        if hasRemoteSource,
           ChatThreadSnapshotCache.persistableDataURL(merged.dataUrl) == nil {
            // Ya existe CDN: no retener además el fallback base64.
            merged.dataUrl = nil
        } else if optimistic.localPreviewData != nil {
            if ChatThreadSnapshotCache.persistableMediaURL(merged.url) == nil {
                merged.url = nil
            }
            if ChatThreadSnapshotCache.persistableDataURL(merged.dataUrl) == nil {
                // El preview binario ya pinta la burbuja; no retener además el
                // mismo archivo como String base64 (~33 % más grande).
                merged.dataUrl = nil
            }
        }
        if merged.name?.isEmpty != false { merged.name = optimistic.name }
        if merged.mimeType?.isEmpty != false { merged.mimeType = optimistic.mimeType }
        if merged.durationMs == nil { merged.durationMs = optimistic.durationMs }
        if merged.size == nil { merged.size = optimistic.size }
        return merged
    }

    private func rebuildCombined() {
        let visibleServerMessages = serverMessages.filter { !reconciledServerMessageIDs.contains($0.id) }
        var all = ChatJourneyParser.mergeById(visibleServerMessages + optimisticMessages)
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
            dayGroups = ConversationTimelineBuilder.groupByDay(items)
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
            let appBaseURL = await journeyService.currentBaseURL()
            let older = ChatJourneyParser.buildMessages(contactId: contactID, events: events, appBaseURL: appBaseURL)
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
        attachmentPreparationTasks.values.forEach { $0.cancel() }
        attachmentPreparationTasks.removeAll()
        attachmentPreparationCount = 0
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

    /// Start/stop del engine SSE encadenados en serie: un `stop()` suelto que
    /// aterrizara después de un `start()` nuevo mataría la conexión recién
    /// abierta y el hilo se quedaría sin realtime.
    private func startRealtime() {
        guard realtimeTask == nil else { return }
        let client = chatEventsClient
        let previous = realtimeControl
        let task = Task { [weak self] in
            await previous?.value
            if Task.isCancelled { return }
            let stream = await client.start()
            for await event in stream {
                if Task.isCancelled { return }
                guard let self else { return }
                if case .message(let payload) = event {
                    let belongsToVisibleThread = payload.contactId == self.contactID
                    self.onInboxActivity(ChatInboxActivity(
                        event: payload,
                        conversationIsVisible: belongsToVisibleThread
                    ))
                    if belongsToVisibleThread {
                        await self.refreshSilently()
                    }
                }
            }
            // Fin NATURAL del stream (p. ej. 401/403 de módulo que el engine trata
            // como cierre permanente): liberar la referencia para que el próximo
            // `startRealtime()` pueda reconectar sin depender de un ciclo
            // background→foreground. Si `stopRealtime()` lo canceló, no tocar nada
            // (ya lo nilificó).
            guard let self, !Task.isCancelled else { return }
            self.realtimeTask = nil
        }
        realtimeTask = task
        realtimeControl = task
    }

    private func stopRealtime() {
        realtimeTask?.cancel()
        realtimeTask = nil
        let client = chatEventsClient
        let previous = realtimeControl
        realtimeControl = Task {
            await previous?.value
            await client.stop()
        }
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
            if var seed = seedContact,
               let selected = seed.matchedPhone,
               !selected.isEmpty {
                if ChatNavigationDestinationResolver.validationStatus(
                    phone: selected,
                    contact: detail
                ) != .valid {
                    seed.matchedPhone = nil
                }
                seed.destinationPhoneRequiresValidation = false
                seedContact = seed
            }
        }
    }

    private func loadWhatsAppStatus() async {
        whatsAppStatus = try? await WhatsAppNumbersService.status()
    }

    func loadAgentStates() async {
        guard let fresh = try? await agentService.fetchAllStates(contactId: contactID) else {
            // Red caída en frío: NO pises lo hidratado desde caché (el robot
            // conserva el último estado conocido). Si nunca hubo nada, sigue vacío.
            return
        }
        // No pises una acción del usuario en vuelo (pausar/tomar/omitir): paridad
        // con refreshAgentStatesIfStale. `applyUpdatedAgentState` ya dejó el estado
        // correcto; un fetch que salió antes traería el estado ANTERIOR.
        if agentActionInFlight { return }
        agentStates = fresh
        lastAgentStatesFetch = Date()
        persistAgentStatesCache()
    }

    /// Refresco silencioso del estado del agente desde el poll/SSE. Throttled
    /// (≥10 s) para no martillar la red; nunca pisa una acción en vuelo ni borra
    /// lo que ya se ve si la red falla (a diferencia de la carga inicial).
    private func refreshAgentStatesIfStale() async {
        if agentActionInFlight { return }
        if let last = lastAgentStatesFetch, Date().timeIntervalSince(last) < 10 { return }
        guard let fresh = try? await agentService.fetchAllStates(contactId: contactID) else { return }
        agentStates = fresh
        lastAgentStatesFetch = Date()
        persistAgentStatesCache()
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
        !isPreparingAttachments && (
            !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty
            || voiceRecorder.hasPreview
        )
    }

    /// Solo agentes asignados y que aún existen. TODO lo que muestra, cuenta,
    /// controla o acciona agentes lee de aquí; `agentStates` crudo es solo store
    /// (conserva las filas legado como historial sin mostrarlas como asignadas).
    var assignedAgentStates: [ConversationAgentState] {
        agentStates.filter { $0.isAssignedExistingAgent }
    }

    var activeAgentStates: [ConversationAgentState] {
        assignedAgentStates.filter { $0.status.lowercased() == "active" }
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
            if pendingAttachments.count == 1, pendingAttachments[0].kind == .audio {
                guard text.isEmpty else {
                    alert = ConversationAlert(
                        title: "Audio sin texto",
                        message: "Messenger e Instagram desde Meta nativo no combinan texto y audio en el mismo envío."
                    )
                    return
                }
                await sendMetaAudioDraft(pendingAttachments[0])
                return
            }
            guard pendingAttachments.isEmpty else {
                alert = ConversationAlert(
                    title: "Adjunto no disponible",
                    message: "Messenger e Instagram desde Meta nativo mandan texto o audio en este chat."
                )
                return
            }
            guard !text.isEmpty else {
                alert = ConversationAlert(title: "Escribe o graba algo", message: "Manda texto o una nota de voz desde este chat.")
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
            scheduleServerReconciliation()
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
                localPreviewData: media.kind == .image ? media.binaryData : nil,
                name: media.filename,
                mimeType: media.mimeType,
                durationMs: media.durationMs,
                size: Double(media.sizeBytes)
            )
            appendOptimistic(optimistic, restore: FailedSendPayload(text: messageCaption, attachment: draft))

            do {
                let mediaReference = try await messagingService.prepareMediaReference(
                    media,
                    clientUploadID: "ios-chat-\(draft.id)",
                    contactID: contactID
                )
                let result: MessageSendResult
                switch media.kind {
                case .image:
                    result = try await messagingService.sendImage(
                        ImageMessageSendRequest(
                            to: phone,
                            from: selectedWhatsAppPhone?.phoneNumber,
                            contactId: contactID,
                            imageDataUrl: mediaReference.legacyDataURL,
                            imageUrl: mediaReference.publicURL,
                            imageMediaAssetId: mediaReference.mediaAssetID,
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
                            videoDataUrl: mediaReference.legacyDataURL,
                            videoUrl: mediaReference.publicURL,
                            videoMediaAssetId: mediaReference.mediaAssetID,
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
                            audioDataUrl: mediaReference.legacyDataURL,
                            audioUrl: mediaReference.publicURL,
                            audioMediaAssetId: mediaReference.mediaAssetID,
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
                            documentDataUrl: mediaReference.legacyDataURL,
                            documentUrl: mediaReference.publicURL,
                            documentMediaAssetId: mediaReference.mediaAssetID,
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
        scheduleServerReconciliation()
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
        guard selectedChannel.isWhatsApp || selectedChannel == .sms || selectedChannel.isMetaSocial else {
            alert = ConversationAlert(
                title: "Adjunto no disponible",
                message: "Este canal acepta texto o audio en este chat."
            )
            return
        }
        if selectedChannel.isWhatsApp || selectedChannel == .sms {
            guard let phone = contactPhone, !phone.isEmpty else {
                alert = ConversationAlert(
                    title: "Falta el teléfono",
                    message: "Guarda el número del contacto antes de escribir por WhatsApp."
                )
                return
            }
        }
        guard let preview = voiceRecorder.consumePreview() else { return }

        let encoded: EncodedChatMedia
        do {
            encoded = try await Task.detached(priority: .userInitiated) {
                try MediaEncoder.encodeAudioFile(at: preview.url, durationMs: preview.durationMs)
            }.value
        } catch {
            alert = ConversationAlert(title: "Audio", message: error.localizedDescription)
            return
        }

        let voiceDraft = ComposerAttachmentDraft(id: UUID().uuidString, media: encoded, previewImage: nil)
        if selectedChannel.isMetaSocial {
            await sendMetaAudio(media: encoded, localURL: preview.url, restoreDraft: voiceDraft)
            return
        }

        guard let phone = contactPhone, !phone.isEmpty else {
            alert = ConversationAlert(
                title: "Falta el teléfono",
                message: "Guarda el número del contacto antes de escribir por WhatsApp."
            )
            return
        }

        let externalId = MessageExternalIdFactory.audio()
        let optimisticTransport = selectedChannel == .sms ? "ghl_sms" : resolveWhatsAppTransport().rawValue
        var optimistic = makeOptimisticMessage(id: externalId, text: "", transport: optimisticTransport)
        optimistic.messageType = "audio"
        optimistic.attachment = ChatAttachment(
            type: .audio,
            url: preview.url.absoluteString,
            name: encoded.filename,
            mimeType: encoded.mimeType,
            durationMs: preview.durationMs
        )
        // Guardamos el audio ya codificado como borrador recuperable: si el
        // envío falla, «Reintentar» rearma el composer con la nota de voz en
        // vez de perderla (doc 05 §7.6).
        appendOptimistic(optimistic, restore: FailedSendPayload(text: "", attachment: voiceDraft))

        do {
            let mediaReference = try await messagingService.prepareMediaReference(
                encoded,
                clientUploadID: "ios-chat-\(voiceDraft.id)",
                contactID: contactID
            )
            if selectedChannel == .sms {
                let result = try await messagingService.sendHighLevelMessage(
                    HighLevelMessageSendRequest(
                        contactId: contactID,
                        channel: "sms_qr",
                        audioDataUrl: mediaReference.legacyDataURL,
                        audioUrl: mediaReference.publicURL,
                        audioMediaAssetId: mediaReference.mediaAssetID,
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
                        audioDataUrl: mediaReference.legacyDataURL,
                        audioUrl: mediaReference.publicURL,
                        audioMediaAssetId: mediaReference.mediaAssetID,
                        durationMs: preview.durationMs,
                        voice: true,
                        externalId: externalId,
                        transport: resolveWhatsAppTransport(),
                        phoneNumberId: selectedWhatsAppPhone?.id
                    )
                )
                applySendResult(result, to: externalId)
                // Guarda el m4a original indexado por la URL (opus) que asigna el
                // servidor: iOS no reproduce opus, así que la burbuja saliente
                // reproducirá ESTE m4a local en su lugar.
                if let remote = result.audio?.bestUrl ?? result.localMedia?.bestUrl {
                    VoiceNoteLocalStore.store(m4aData: encoded.binaryData, forRemoteURL: remote)
                }
            }
            scheduleServerReconciliation()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    // MARK: Meta social / HighLevel

    private func sendMetaAudioDraft(_ draft: ComposerAttachmentDraft) async {
        await sendMetaAudio(media: draft.media, localURL: nil, restoreDraft: draft)
    }

    private func sendMetaAudio(media: EncodedChatMedia, localURL: URL?, restoreDraft: ComposerAttachmentDraft) async {
        guard let platform = selectedChannel.metaPlatform else { return }
        let externalId = MessageExternalIdFactory.metaAudio()
        let transport = platform == .instagram ? "instagram" : "messenger"
        let reply = replyTarget

        var optimistic = makeOptimisticMessage(id: externalId, text: "", transport: transport)
        optimistic.messageType = "audio"
        optimistic.replyToMessageId = reply?.id
        optimistic.replyToProviderMessageId = reply?.providerMessageId
        optimistic.attachment = ChatAttachment(
            type: .audio,
            url: localURL?.absoluteString,
            name: media.filename,
            mimeType: media.mimeType,
            durationMs: media.durationMs,
            size: Double(media.sizeBytes)
        )
        appendOptimistic(optimistic, restore: FailedSendPayload(text: "", attachment: restoreDraft))
        clearComposerAfterSend()

        do {
            let mediaReference = try await messagingService.prepareMediaReference(
                media,
                clientUploadID: "ios-chat-\(restoreDraft.id)",
                contactID: contactID
            )
            let result = try await messagingService.sendMetaSocialAudio(
                MetaSocialAudioSendRequest(
                    contactId: contactID,
                    platform: platform,
                    audioDataUrl: mediaReference.legacyDataURL,
                    audioUrl: mediaReference.publicURL,
                    audioMediaAssetId: mediaReference.mediaAssetID,
                    durationMs: media.durationMs,
                    externalId: externalId,
                    replyToMessageId: reply?.id,
                    replyToProviderMessageId: reply?.providerMessageId
                )
            )
            applySendResult(result, to: externalId)
            scheduleServerReconciliation()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    private func sendMetaText(_ text: String, preserveComposer: Bool = false) async {
        guard let platform = selectedChannel.metaPlatform else { return }
        let externalId = MessageExternalIdFactory.meta()
        let reply = preserveComposer ? nil : replyTarget

        var optimistic = makeOptimisticMessage(
            id: externalId,
            text: text,
            transport: platform == .instagram ? "instagram" : "messenger"
        )
        optimistic.replyToMessageId = reply?.id
        optimistic.replyToProviderMessageId = reply?.providerMessageId
        appendOptimistic(optimistic, restore: FailedSendPayload(text: text, attachment: nil))
        if preserveComposer {
            scrollToBottomSignal &+= 1
        } else {
            clearComposerAfterSend()
        }

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
            scheduleServerReconciliation()
        } catch {
            handleSendFailure(error, externalId: externalId, restoreOnWindowError: nil)
        }
    }

    private func sendHighLevel(text: String, drafts: [ComposerAttachmentDraft], preserveComposer: Bool = false) async {
        let externalId = MessageExternalIdFactory.highLevel()
        var optimistic = makeOptimisticMessage(id: externalId, text: text, transport: "ghl_sms")
        if let first = drafts.first {
            optimistic.attachment = ChatAttachment(
                type: attachmentKind(for: first.kind),
                localPreviewData: first.kind == .image ? first.media.binaryData : nil,
                name: first.filename,
                mimeType: first.media.mimeType
            )
        }
        appendOptimistic(optimistic, restore: FailedSendPayload(text: text, attachment: drafts.first))
        if preserveComposer {
            scrollToBottomSignal &+= 1
        } else {
            clearComposerAfterSend()
        }

        do {
            var mediaReferences: [ChatMediaSendReference] = []
            mediaReferences.reserveCapacity(drafts.count)
            for draft in drafts {
                mediaReferences.append(try await messagingService.prepareMediaReference(
                    draft.media,
                    clientUploadID: "ios-chat-\(draft.id)",
                    contactID: contactID
                ))
            }
            let uploadedURLs = mediaReferences.compactMap(\.publicURL)
            let uploadedAssetIDs = mediaReferences.compactMap(\.mediaAssetID)
            let legacyAttachments = zip(drafts, mediaReferences).compactMap { draft, reference in
                reference.legacyDataURL.map {
                    HighLevelAttachmentDataUrl(
                        dataUrl: $0,
                        filename: draft.filename,
                        mimeType: draft.media.mimeType,
                        kind: draft.kind.rawValue
                    )
                }
            }
            let result = try await messagingService.sendHighLevelMessage(
                HighLevelMessageSendRequest(
                    contactId: contactID,
                    channel: "sms_qr",
                    message: text.isEmpty ? nil : text,
                    attachments: uploadedURLs.isEmpty ? nil : uploadedURLs,
                    attachmentMediaAssetIds: uploadedAssetIDs.isEmpty ? nil : uploadedAssetIDs,
                    attachmentDataUrls: legacyAttachments.isEmpty ? nil : legacyAttachments,
                    externalId: externalId
                )
            )
            applySendResult(result, to: externalId)
            scheduleServerReconciliation()
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
            scheduleServerReconciliation()
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
        // Marca el envío en curso para que el `guard !isSending` de
        // `sendCurrentLocation()` realmente bloquee un segundo tap mientras el GPS
        // resuelve (antes esta ruta no lo marcaba y colisionaba con LocationSender).
        isSending = true
        defer { isSending = false }
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
        // Se envía como override SIN tocar el composer (patrón /movil
        // textOverride + preserveComposer), para no pisar lo que el usuario
        // esté escribiendo.
        if !selectedChannel.isWhatsApp {
            let link = ChatLocation.googleMapsURL(latitude: coordinate.latitude, longitude: coordinate.longitude)
            let text = "📍 Mi ubicación: \(link)"
            switch selectedChannel {
            case .messenger, .instagram:
                await sendMetaText(text, preserveComposer: true)
            default:
                await sendHighLevel(text: text, drafts: [], preserveComposer: true)
            }
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
            scheduleServerReconciliation()
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
        inFlightExternalIds.insert(message.id)
        rebuildCombined()
        onInboxActivity(ChatInboxActivity(message: message))
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
                    message.attachment = attachment
                }
            }
        }
        inFlightExternalIds.remove(externalId)
        failedPayloads.removeValue(forKey: externalId)
    }

    private func handleSendFailure(_ error: Error, externalId: String, restoreOnWindowError: String?) {
        // El POST terminó (con error): sale de "en vuelo".
        inFlightExternalIds.remove(externalId)

        // 400 de ventana de 24 h (doc 05 §1.1 / gap §10.5).
        if WhatsAppReplyWindowRules.isReplyWindowError(error) {
            if let restoreOnWindowError {
                // Envío de texto: quita la burbuja, repone el texto al composer
                // y ofrece plantillas.
                removeOptimistic(id: externalId)
                if draftText.isEmpty { draftText = restoreOnWindowError }
                presentTemplatesSheet(reason: (error as? RistakAPIError)?.message)
                return
            }
            // Adjunto/voz/ubicación: NO destruir el medio. Se conserva la
            // burbuja fallida; «Reintentar» rearma el composer con el borrador
            // guardado (doc 05 §7.6). Cae al marcado de fallo de abajo.
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
        inFlightExternalIds.remove(id)
        reconcileOptimisticMessages()
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
        // El scroll al final lo dispara `appendOptimistic` (después de insertar la
        // burbuja) en todos los paths de envío; hacerlo aquí también provocaba un
        // doble salto/jitter justo al enviar.
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

    private func canAddAttachment(allowMetaSocialAudio: Bool = false) -> Bool {
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
        guard selectedChannel.isWhatsApp || selectedChannel == .sms || (allowMetaSocialAudio && selectedChannel.isMetaSocial) else {
            alert = ConversationAlert(
                title: "Adjuntos por WhatsApp",
                message: "Los adjuntos nativos se envían por WhatsApp API/QR. Cambia el canal a WhatsApp para mandar este archivo."
            )
            return false
        }
        guard attachments.count + attachmentPreparationCount < ChatMediaLimits.maxDraftAttachments else {
            alert = ConversationAlert(
                title: "Límite de adjuntos",
                message: "Puedes mandar hasta 4 adjuntos por mensaje."
            )
            return false
        }
        return true
    }

    private func appendPreparedAttachment(_ draft: ComposerAttachmentDraft) {
        let currentBytes = attachments.reduce(0) { $0 + $1.media.sizeBytes }
        guard currentBytes + draft.media.sizeBytes <= ChatMediaLimits.draftTotalMaxBytes else {
            alert = ConversationAlert(
                title: "Adjuntos demasiado pesados",
                message: "Los archivos juntos pesan demasiado para prepararlos sin trabar el celular. Quita uno o envíalos por separado."
            )
            return
        }
        attachments.append(draft)
    }

    func addCameraImage(_ image: UIImage) {
        guard canAddAttachment() else { return }
        attachmentPreparationCount += 1
        let preparationID = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                self.attachmentPreparationCount = max(0, self.attachmentPreparationCount - 1)
                self.attachmentPreparationTasks.removeValue(forKey: preparationID)
            }
            do {
                let encoded = try await Task.detached(priority: .userInitiated) {
                    try MediaEncoder.encodeImage(image)
                }.value
                try Task.checkCancellation()
                self.appendPreparedAttachment(
                    ComposerAttachmentDraft(id: UUID().uuidString, media: encoded, previewImage: image)
                )
            } catch is CancellationError {
                return
            } catch {
                self.alert = ConversationAlert(title: "Foto", message: error.localizedDescription)
            }
        }
        attachmentPreparationTasks[preparationID] = task
    }

    /// Media elegida de la fototeca (imagen o video ya en Data).
    func addPickedMedia(data: Data, mimeType: String?, filename: String?) {
        guard canAddAttachment() else { return }
        let mime = MediaEncoder.normalizeMime(mimeType)
        attachmentPreparationCount += 1
        let preparationID = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                self.attachmentPreparationCount = max(0, self.attachmentPreparationCount - 1)
                self.attachmentPreparationTasks.removeValue(forKey: preparationID)
            }
            do {
                let result = try await Task.detached(priority: .userInitiated) { () -> (EncodedChatMedia, UIImage?) in
                    if mime.hasPrefix("video/") {
                        let ext = MediaEncoder.fileExtension(forMime: mime) ?? "mp4"
                        let url = FileManager.default.temporaryDirectory
                            .appendingPathComponent(filename ?? "video-\(UUID().uuidString).\(ext)")
                        defer { try? FileManager.default.removeItem(at: url) }
                        try data.write(to: url, options: .atomic)
                        return (try MediaEncoder.encodeVideoFile(at: url), nil)
                    }
                    return (
                        try MediaEncoder.encodeImageData(data, mimeType: mime, filename: filename),
                        UIImage(data: data)
                    )
                }.value
                try Task.checkCancellation()
                self.appendPreparedAttachment(
                    ComposerAttachmentDraft(id: UUID().uuidString, media: result.0, previewImage: result.1)
                )
            } catch is CancellationError {
                return
            } catch {
                self.alert = ConversationAlert(title: "Adjunto", message: error.localizedDescription)
            }
        }
        attachmentPreparationTasks[preparationID] = task
    }

    func addDocument(at url: URL) {
        guard canAddAttachment(allowMetaSocialAudio: true) else { return }
        let isMetaSocial = selectedChannel.isMetaSocial
        // `fileImporter` puede entregar una URL security-scoped. Abrir el scope
        // ANTES de saltar al worker y cerrarlo solo cuando termino la lectura.
        let hasSecurityScope = url.startAccessingSecurityScopedResource()
        attachmentPreparationCount += 1
        let preparationID = UUID()
        let task = Task { [weak self] in
            defer {
                if hasSecurityScope {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            guard let self else { return }
            defer {
                self.attachmentPreparationCount = max(0, self.attachmentPreparationCount - 1)
                self.attachmentPreparationTasks.removeValue(forKey: preparationID)
            }
            do {
                let encoded = try await Task.detached(priority: .userInitiated) {
                    if isMetaSocial {
                        return try MediaEncoder.encodeAudioFile(at: url, durationMs: nil)
                    }
                    return try MediaEncoder.encodeDocumentFile(at: url)
                }.value
                try Task.checkCancellation()
                self.appendPreparedAttachment(
                    ComposerAttachmentDraft(id: UUID().uuidString, media: encoded, previewImage: nil)
                )
            } catch is CancellationError {
                return
            } catch {
                if isMetaSocial {
                    self.alert = ConversationAlert(
                        title: "Adjunto no disponible",
                        message: "Messenger e Instagram desde Meta nativo mandan texto o audio en este chat."
                    )
                } else {
                    self.alert = ConversationAlert(title: "Documento", message: error.localizedDescription)
                }
            }
        }
        attachmentPreparationTasks[preparationID] = task
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
            date: RistakDateParsing.date(fromISO: item.scheduledAt) ?? Date().addingTimeInterval(15 * 60),
            // Conserva el shape original: reprogramar un template o un mensaje
            // HighLevel NO debe reescribirlo como whatsapp_api + text.
            origin: ScheduleSheetState.Origin(
                provider: item.provider,
                channel: item.channel,
                transport: item.transport,
                messageType: item.messageType,
                templateId: item.templateId,
                templateName: item.templateName,
                templateLanguage: item.templateLanguage,
                templateComponents: item.templateComponents,
                templateVariables: item.templateVariables,
                toPhone: item.toPhone,
                fromPhone: item.fromPhone,
                businessPhoneNumberId: item.businessPhoneNumberId
            )
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

        let request: ScheduledMessageUpsertRequest
        if let origin = state.origin, let editingId = state.editingId {
            // EDICIÓN: solo cambian texto y hora. Se conserva EXACTAMENTE el
            // shape original (provider/channel/transport/messageType + payload
            // de plantilla + teléfonos) para no corromper templates ni GHL.
            let isWhatsAppApi = origin.provider == "whatsapp_api"
            let isTemplate = origin.messageType == "template"
            request = ScheduledMessageUpsertRequest(
                id: editingId,
                contactId: contactID,
                provider: origin.provider,
                channel: isWhatsAppApi ? nil : (origin.channel.isEmpty ? nil : origin.channel),
                transport: isWhatsAppApi ? (origin.transport.isEmpty ? resolveWhatsAppTransport().rawValue : origin.transport) : nil,
                messageType: origin.messageType,
                text: text,
                templateId: isTemplate && !origin.templateId.isEmpty ? origin.templateId : nil,
                templateName: isTemplate && !origin.templateName.isEmpty ? origin.templateName : nil,
                templateLanguage: isTemplate && !origin.templateLanguage.isEmpty ? origin.templateLanguage : nil,
                templateComponents: isTemplate ? origin.templateComponents : nil,
                templateVariables: isTemplate ? origin.templateVariables : nil,
                toPhone: origin.toPhone.isEmpty ? contactPhone : origin.toPhone,
                fromPhone: origin.fromPhone.isEmpty ? nil : origin.fromPhone,
                businessPhoneNumberId: origin.businessPhoneNumberId.isEmpty ? nil : origin.businessPhoneNumberId,
                scheduledAt: RistakDateParsing.isoString(from: state.date),
                externalId: state.externalId
            )
        } else {
            // CREACIÓN: WhatsApp API texto (requiere teléfono del contacto y del
            // número de negocio).
            guard let phone = contactPhone, !phone.isEmpty else {
                alert = ConversationAlert(title: "Programado", message: "Este contacto necesita teléfono para programar el mensaje.")
                return false
            }
            let fromPhone = selectedWhatsAppPhone?.phoneNumber ?? selectedWhatsAppPhone?.displayPhoneNumber
            guard let fromPhone, !fromPhone.isEmpty else {
                alert = ConversationAlert(title: "Programado", message: "Elige el WhatsApp del negocio que mandará el mensaje.")
                return false
            }
            request = ScheduledMessageUpsertRequest(
                id: nil,
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
        }

        do {
            _ = try await scheduledService.upsert(request)
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
        let states = assignedAgentStates
        guard !states.isEmpty else { return nil }
        if states.count > 1 {
            return "\(states.count) agentes asignados"
        }
        switch states[0].status.lowercased() {
        case "active": return "El agente atiende este chat."
        case "paused": return "Agente pausado por 24hrs en este chat."
        case "human": return "Conversación tomada por un humano."
        case "skipped": return "Agente omitido en este chat."
        case "completed": return "El agente ya cumplió el objetivo aquí."
        case "discarded": return "Conversación descartada por el agente."
        default: return nil
        }
    }

    /// Estado primario para el header/banner: activo-con-agente > con-señal >
    /// con-agente > cualquiera (paridad `selectPrimaryAgentState` del /movil).
    var primaryAgentState: ConversationAgentState? {
        let states = assignedAgentStates
        if states.isEmpty { return nil }
        func rank(_ s: ConversationAgentState) -> Int {
            let status = s.status.lowercased()
            if status == "active" && (s.agentId?.isEmpty == false) && (s.signal?.isEmpty ?? true) { return 0 }
            if !(s.signal?.isEmpty ?? true) { return 1 }
            if s.agentId?.isEmpty == false { return 2 }
            return 3
        }
        return states.min { rank($0) < rank($1) }
    }

    /// ¿Hay algo del agente que controlar en este chat (mostrar botón robot)?
    var hasAgentControls: Bool { !assignedAgentStates.isEmpty }

    /// El robot del header se prende cuando algún agente atiende activamente.
    var agentControllerActive: Bool {
        assignedAgentStates.contains { $0.status.lowercased() == "active" }
    }

    /// Estado con señal de cierre pendiente (para el banner "objetivo cumplido").
    var agentSignalState: ConversationAgentState? {
        assignedAgentStates.first { $0.hasPendingSignal }
    }

    /// Reemplaza el estado devuelto por el backend en la lista (autoritativo, sin
    /// refetch): más ágil y consistente con el header + el sheet.
    private func applyUpdatedAgentState(_ updated: ConversationAgentState, previous: ConversationAgentState) {
        let key = previous.agentId ?? updated.agentId
        if let index = agentStates.firstIndex(where: { ($0.agentId ?? "") == (key ?? "") }) {
            agentStates[index] = updated
        } else if let index = agentStates.firstIndex(where: { $0.id == previous.id }) {
            agentStates[index] = updated
        } else {
            agentStates.append(updated)
        }
        lastAgentStatesFetch = Date()
        // Persiste tras una acción local (pausar/reanudar/tomar control) para que
        // reabrir el chat no muestre un robot con el estado ANTERIOR.
        persistAgentStatesCache()
    }

    /// Descarta la señal de cierre (paridad `clear_signal`): quita el banner de
    /// "objetivo cumplido" sin cambiar el estado del agente. Optimista.
    func clearAgentSignal() {
        guard !clearingAgentSignal, let state = agentSignalState else { return }
        clearingAgentSignal = true
        Task {
            defer { clearingAgentSignal = false }
            do {
                let updated = try await agentService.updateState(contactId: contactID, action: .clearSignal, agentId: state.agentId)
                applyUpdatedAgentState(updated, previous: state)
            } catch {
                alert = ConversationAlert(
                    title: "Agente",
                    message: (error as? RistakAPIError)?.message ?? "No se pudo descartar el aviso."
                )
            }
        }
    }

    func performAgentAction(_ action: ConversationAgentAction, state: ConversationAgentState) {
        guard !agentActionInFlight else { return }
        agentActionInFlight = true
        Task {
            defer { agentActionInFlight = false }
            do {
                let updated = try await agentService.updateState(contactId: contactID, action: action, agentId: state.agentId)
                applyUpdatedAgentState(updated, previous: state)
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
