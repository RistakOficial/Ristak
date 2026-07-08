import Foundation
import Observation

// MARK: - Modelos de UI

/// Chip de filtro listo para pintar.
struct ChatFilterChipModel: Identifiable, Equatable {
    let filter: ChatInboxFilter
    let title: String
    var count: Int?
    var isSelected: Bool
    /// Separador vertical antes del chip (`Comentarios`, doc 03 §4.1).
    var leadingDivider: Bool = false

    var id: String { filter.chipID }
}

/// Entrada del manager de filtros («+»).
struct ChatFilterManagerEntry: Identifiable, Equatable {
    let chipID: String
    let title: String
    let subtitle: String
    var isVisible: Bool
    /// `Todos` está bloqueado (no removible).
    var isLocked: Bool = false
    /// Presets condicionales se pueden borrar.
    var isDeletablePreset: Bool = false

    var id: String { chipID }
}

struct ChatFilterManagerSection: Identifiable, Equatable {
    let title: String
    let entries: [ChatFilterManagerEntry]

    var id: String { title }
}

/// Resultado de aplicar una etiqueta desde el sheet.
enum ChatTagApplyOutcome: Equatable {
    case applied
    case alreadyTagged
}

// MARK: - ViewModel

/// ViewModel de la bandeja de chats (doc research/03 completo + realtime doc 11).
@MainActor
@Observable
final class InboxViewModel {
    // MARK: Dependencias

    private let chatsService = ChatsService()
    private let contactsService = ContactsService()
    private let tagsService = TagsService()
    private let scheduledService = ScheduledMessagesService()
    private let agentService = AgentStateService()
    private let eventsClient = ChatEventsClient()
    private let pollingClock = PollingClock()

    let localState = ChatLocalStateStore()

    private var appConfig: AppConfigStore?
    private weak var shell: ShellState?
    private var namespace = ""
    private var configured = false

    // MARK: Estado de datos

    private(set) var rows: [ChatContact] = []
    private(set) var hasMore = false
    private(set) var isInitialLoading = false
    private(set) var isLoadingMore = false
    private(set) var isSilentRefreshing = false
    /// Píldora «Mostrando lo guardado, actualizando chats» (cache-first).
    private(set) var isShowingCachedData = false
    private(set) var loadErrorMessage: String?
    private(set) var isAccessDenied = false

    /// Offset real acumulado del servidor (doc 03 §4.9: descartar dedupe).
    private var serverOffset = 0
    /// Parámetros (query + número) con los que se cargó `rows`; si cambian,
    /// la siguiente recarga REEMPLAZA en vez de fusionar.
    private var loadedFetchKey = ""
    private var refreshInFlight = false
    private var refreshQueued = false
    private var realtimeTask: Task<Void, Never>?
    private var isScenePaused = false

    // MARK: Búsqueda

    var searchText = ""
    private(set) var activeQuery = ""
    private var searchDebounceTask: Task<Void, Never>?
    private(set) var contactSuggestions: [ChatContact] = []
    private(set) var isSearchingContacts = false

    // MARK: Filtros

    private(set) var activeFilter: ChatInboxFilter = .quick(.all)
    private(set) var commentsPlatform: ChatCommentsPlatform = .all
    private(set) var archivedViewActive = false

    // MARK: Contexto satélite

    private(set) var whatsAppStatus: WhatsAppAPIStatus?
    private(set) var customLabels: DashboardCustomLabels = .defaults
    private(set) var openAIConfigured = false
    /// Visibilidad del chip Comentarios (flags Meta, doc 03 §6.11). Fail-open.
    private(set) var commentsFeatureEnabled = true
    private(set) var tagsCatalog: [ContactTag] = []
    private var tagsLoaded = false

    // MARK: Selección múltiple

    private(set) var isSelecting = false
    private(set) var selectedIDs: Set<String> = []

    // MARK: Feedback de UI

    /// Mensaje transitorio para alertas simples («No se guardó el filtro», …).
    var transientAlertMessage: String?
    /// Triggers de hápticos (`sensoryFeedback`).
    private(set) var selectionHapticTick = 0
    private(set) var impactHapticTick = 0
    private(set) var successHapticTick = 0

    init() {}

    // MARK: - Configuración

    func configure(appConfig: AppConfigStore, shell: ShellState, namespace: String) {
        guard !configured else { return }
        configured = true
        self.appConfig = appConfig
        self.shell = shell
        self.namespace = namespace
        localState.configure(namespace: namespace)

        // Cache-first: pintar el snapshot guardado al instante.
        let cached = ChatInboxDiskCache.load(namespace: namespace)
        if !cached.isEmpty {
            rows = cached
            isShowingCachedData = true
            syncUnreadBadge()
        }
    }

    var isConfigured: Bool { configured }

    // MARK: - Derivados de config

    var formatters: BusinessFormatters {
        appConfig?.formatters ?? BusinessFormatters(
            timeZone: TimeZone(identifier: AppConfigStore.defaultTimeZoneIdentifier)!
        )
    }

    var sortMode: RistakChatSortMode { appConfig?.chatSortMode ?? .recent }
    var showLastPreview: Bool { appConfig?.showLastMessagePreview ?? true }
    var showUnreadIndicators: Bool { appConfig?.showUnreadIndicators ?? true }

    /// Números de WhatsApp conectados (chips por número solo con >1, doc 03 §3.2).
    var phoneNumbers: [WhatsAppPhoneNumber] { whatsAppStatus?.phoneNumbers ?? [] }
    var phoneFilterEnabled: Bool { phoneNumbers.count > 1 }

    var customPresets: [ChatFilterPreset] {
        ChatFilterPreset.parseList(fromJSON: appConfig?.customFilterPresetsRaw)
    }

    /// Chips visibles normalizados (config o defaults).
    var visibleChipIDs: [String] {
        let stored = appConfig?.chatFilterChipIDs ?? []
        let base = stored.isEmpty ? ChatFilterChipDefaults.baseChipIDs : stored
        return ChatFilterChipDefaults.normalized(base)
    }

    // MARK: - Carga inicial

    func initialLoad() async {
        guard rows.isEmpty || isShowingCachedData else { return }
        isInitialLoading = rows.isEmpty
        loadErrorMessage = nil
        isAccessDenied = false

        async let contextTask: Void = loadSatelliteContext()
        await reloadFromServer(showSpinner: rows.isEmpty)
        await contextTask
        restorePersistedPhoneFilter()
    }

    /// Contexto satélite: números, labels, integraciones, flags de comentarios
    /// y catálogo de etiquetas. Fallos silenciosos (no bloquean la bandeja).
    private func loadSatelliteContext() async {
        async let statusTask = try? WhatsAppNumbersService.status()
        async let labelsTask = try? AnalyticsService.customLabels()
        async let integrationsTask = try? IntegrationsService.status()
        async let metaFlagsTask = fetchMetaMessagingFlags()
        async let tagsTask = try? tagsService.fetchTags()

        whatsAppStatus = await statusTask
        if let labels = await labelsTask { customLabels = labels }
        if let integrations = await integrationsTask {
            openAIConfigured = integrations.openai?.isUsable == true
            let metaConnected = integrations.meta?.isUsable == true
            if let flags = await metaFlagsTask {
                commentsFeatureEnabled = metaConnected && (flags.messenger || flags.instagram)
            } else {
                commentsFeatureEnabled = metaConnected
            }
        }
        if let tags = await tagsTask {
            tagsCatalog = tags
            tagsLoaded = true
        }
    }

    private func fetchMetaMessagingFlags() async -> (messenger: Bool, instagram: Bool)? {
        let payload: RistakKeyedConfigPayload? = try? await APIClient.shared.get(
            "/api/config",
            query: ["keys": "meta_messenger_messaging_enabled,meta_instagram_messaging_enabled"]
        )
        guard let payload else { return nil }
        let messenger = RistakStringBool.parse(payload.config["meta_messenger_messaging_enabled"] ?? nil) ?? false
        let instagram = RistakStringBool.parse(payload.config["meta_instagram_messaging_enabled"] ?? nil) ?? false
        return (messenger, instagram)
    }

    /// Restaura `mobile_chat_selected_whatsapp_phone_id` al abrir (doc 03 §3.2):
    /// si el número guardado ya no existe o solo hay uno → caer a `Todos`.
    private func restorePersistedPhoneFilter() {
        guard let appConfig else { return }
        let saved = appConfig.selectedWhatsAppPhoneID
        guard saved != "all" else { return }
        guard phoneFilterEnabled, phoneNumbers.contains(where: { $0.id == saved }) else {
            Task { try? await appConfig.setAppConfigValue("all", forKey: RistakAppConfigKey.selectedWhatsAppPhoneID) }
            return
        }
        guard !activeFilter.isPhoneFilter else { return }
        activeFilter = .phone(saved)
        Task { await reloadFromServer(showSpinner: false) }
    }

    // MARK: - Fetch de páginas

    private var activePhoneNumber: WhatsAppPhoneNumber? {
        guard case .phone(let id) = activeFilter else { return nil }
        return phoneNumbers.first { $0.id == id }
    }

    private func phoneQueryParams() -> (id: String?, phone: String?) {
        guard let number = activePhoneNumber else { return (nil, nil) }
        let phone = [number.phoneNumber, number.displayPhoneNumber, number.qrConnectedPhone]
            .compactMap { $0 }
            .first { !$0.isEmpty }
        return (number.id, phone)
    }

    private func fetchPage(offset: Int) async throws -> [ChatContact] {
        let params = phoneQueryParams()
        return try await chatsService.fetchChats(
            query: activeQuery,
            limit: ChatsService.defaultPageSize,
            offset: offset,
            businessPhoneNumberId: params.id,
            businessPhone: params.phone
        )
    }

    /// Clave de los parámetros vigentes de fetch (query + número).
    private var currentFetchKey: String {
        let params = phoneQueryParams()
        return "\(activeQuery)|\(params.id ?? "")"
    }

    /// Recarga completa (primera página) respetando query y filtro de número.
    private func reloadFromServer(showSpinner: Bool) async {
        if showSpinner { isInitialLoading = true }
        defer { isInitialLoading = false }

        let fetchKey = currentFetchKey
        do {
            let page = try await fetchPage(offset: 0)
            // Si el usuario cambió query/número mientras esta carga volaba,
            // descartar el lote (llega otro reload con los params nuevos).
            guard fetchKey == currentFetchKey else { return }
            if rows.isEmpty || isShowingCachedData || loadedFetchKey != fetchKey {
                rows = page
            } else {
                rows = ChatInboxPaginator.mergeRefresh(rows, freshFirstPage: page)
            }
            loadedFetchKey = fetchKey
            serverOffset = page.count
            hasMore = ChatInboxPaginator.hasMore(batchCount: page.count, limit: ChatsService.defaultPageSize)
            loadErrorMessage = nil
            isAccessDenied = false
            isShowingCachedData = false
            persistCacheSnapshot()
            syncUnreadBadge()
            await refreshContactSuggestionsIfNeeded()
        } catch let error as RistakAPIError {
            isAccessDenied = error.isAccessDenied
            if rows.isEmpty {
                loadErrorMessage = error.kind == .featureUnavailable
                    ? nil
                    : "No se pudieron cargar los chats."
            }
        } catch {
            if rows.isEmpty {
                loadErrorMessage = "No se pudieron cargar los chats."
            }
        }
    }

    /// Scroll infinito: pedir la siguiente página al acercarse al final.
    func loadMoreIfNeeded(currentRow contact: ChatContact) {
        guard hasMore, !isLoadingMore else { return }
        let threshold = max(0, displayRows.count - 8)
        guard let index = displayRows.firstIndex(where: { $0.id == contact.id }), index >= threshold else { return }
        Task { await loadMore() }
    }

    private func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let fetchKey = currentFetchKey
        do {
            let page = try await fetchPage(offset: serverOffset)
            // Descartar lotes si una recarga movió los params mientras tanto.
            guard fetchKey == currentFetchKey, fetchKey == loadedFetchKey else { return }
            rows = ChatInboxPaginator.appendPage(rows, page: page)
            serverOffset += page.count
            hasMore = ChatInboxPaginator.hasMore(batchCount: page.count, limit: ChatsService.defaultPageSize)
            syncUnreadBadge()
        } catch {
            hasMore = false
        }
    }

    // MARK: - Refresh vivo (SSE + polling + pull-to-refresh)

    /// Pull-to-refresh explícito.
    func refreshNow() async {
        await reloadFromServer(showSpinner: false)
    }

    /// Refresh coalescido (nudge SSE / push foreground / tick de polling).
    /// Si hay uno en vuelo, encola UNO más (doc 11 §2.4).
    func requestSilentRefresh() {
        guard configured else { return }
        if refreshInFlight {
            refreshQueued = true
            return
        }
        refreshInFlight = true
        isSilentRefreshing = true
        Task { [weak self] in
            guard let self else { return }
            await self.reloadFromServer(showSpinner: false)
            self.refreshInFlight = false
            self.isSilentRefreshing = false
            if self.refreshQueued {
                self.refreshQueued = false
                self.requestSilentRefresh()
            }
        }
    }

    /// Arranca SSE + ticker de bandeja (12 s). Idempotente.
    func startRealtime() {
        guard configured else { return }
        pollingClock.schedule("inbox", every: PollingClock.Cadence.inbox) { [weak self] in
            self?.requestSilentRefresh()
        }
        startEventsStream()
    }

    private func startEventsStream() {
        realtimeTask?.cancel()
        realtimeTask = Task { [weak self] in
            guard let self else { return }
            let stream = await self.eventsClient.start()
            for await event in stream {
                if Task.isCancelled { return }
                if case .message = event {
                    self.requestSilentRefresh()
                }
            }
        }
    }

    func stopRealtime() {
        realtimeTask?.cancel()
        realtimeTask = nil
        pollingClock.cancelAll()
        Task { await eventsClient.stop() }
    }

    /// scenePhase: pausar polls y cortar SSE en background; al volver,
    /// reconectar y disparar un refresh inmediato.
    func setScenePaused(_ paused: Bool) {
        guard isScenePaused != paused else { return }
        isScenePaused = paused
        pollingClock.setPaused(paused)
        if paused {
            realtimeTask?.cancel()
            realtimeTask = nil
            Task { await eventsClient.stop() }
        } else if configured {
            startEventsStream()
            requestSilentRefresh()
        }
    }

    private func persistCacheSnapshot() {
        guard activeQuery.isEmpty, !activeFilter.isPhoneFilter, !namespace.isEmpty else { return }
        ChatInboxDiskCache.save(rows, namespace: namespace)
    }

    // MARK: - Búsqueda (debounce 240 ms, doc 14 §6.2)

    func searchTextDidChange() {
        searchDebounceTask?.cancel()
        let text = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        searchDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 240_000_000)
            guard let self, !Task.isCancelled else { return }
            guard self.activeQuery != text else { return }
            self.activeQuery = text
            self.contactSuggestions = []
            await self.reloadFromServer(showSpinner: true)
        }
    }

    var isSearchActive: Bool { !searchText.isEmpty }

    /// Sugerencias «Contactos encontrados» cuando la búsqueda no halla chats
    /// (≥2 chars, doc 03 §4.9).
    private func refreshContactSuggestionsIfNeeded() async {
        guard activeQuery.count >= 2, rows.isEmpty else {
            contactSuggestions = []
            return
        }
        isSearchingContacts = true
        defer { isSearchingContacts = false }
        contactSuggestions = (try? await contactsService.searchContacts(query: activeQuery)) ?? []
    }

    // MARK: - Filtros activos

    func select(filter: ChatInboxFilter) {
        let wasPhone = activeFilter.isPhoneFilter
        guard activeFilter != filter else { return }
        activeFilter = filter
        commentsPlatform = .all

        switch filter {
        case .phone(let id):
            persistSelectedPhoneID(id)
            Task { await reloadFromServer(showSpinner: true) }
        default:
            // Tocar cualquier filtro no-numérico regresa el número a 'all'.
            if wasPhone {
                persistSelectedPhoneID("all")
                Task { await reloadFromServer(showSpinner: true) }
            }
        }
    }

    func exitCommentsLens() {
        select(filter: .quick(.all))
    }

    func selectCommentsPlatform(_ platform: ChatCommentsPlatform) {
        commentsPlatform = platform
    }

    private func persistSelectedPhoneID(_ id: String) {
        guard let appConfig else { return }
        Task {
            do {
                try await appConfig.setAppConfigValue(id, forKey: RistakAppConfigKey.selectedWhatsAppPhoneID)
            } catch {
                self.transientAlertMessage = "No se guardó el filtro"
            }
        }
    }

    // MARK: - Vista de archivados

    func openArchivedView() {
        archivedViewActive = true
    }

    func closeArchivedView() {
        archivedViewActive = false
    }

    var archivedCount: Int {
        localState.archivedIDs.count
    }

    // MARK: - Filas visibles

    /// Filas a pintar: archivados fuera de la bandeja normal, lente de
    /// comentarios, filtro activo y orden (doc 03 §4.2/§3.1).
    var displayRows: [ChatContact] {
        var list: [ChatContact]
        if archivedViewActive {
            // En archivados se ignoran los filtros rápidos (doc 03 §4.8).
            list = rows.filter { localState.isArchived($0.id) }
        } else {
            list = rows.filter { !localState.isArchived($0.id) }
            list = list.filter { matchesActiveFilter($0) }
        }
        if sortMode == .unread {
            // Orden estable: no leídos primero, fecha del server como desempate.
            list = list.enumerated().sorted { lhs, rhs in
                let lhsUnread = lhs.element.visibleUnreadCount
                let rhsUnread = rhs.element.visibleUnreadCount
                if (lhsUnread > 0) != (rhsUnread > 0) { return lhsUnread > 0 }
                if lhsUnread != rhsUnread { return lhsUnread > rhsUnread }
                return lhs.offset < rhs.offset
            }.map(\.element)
        }
        return list
    }

    private func matchesActiveFilter(_ contact: ChatContact) -> Bool {
        // Lente de comentarios: muestra cualquier contacto con comentario.
        if activeFilter.isCommentsLens {
            return ChatRowSignals.hasCommentSignal(contact)
                && ChatRowSignals.matchesCommentsPlatform(commentsPlatform, contact: contact)
        }

        // Fuera de la lente, los chats de SOLO comentarios nunca aparecen.
        guard !contact.isCommentOnlyChat else { return false }

        switch activeFilter {
        case .quick(let quick):
            return ChatRowSignals.matchesQuick(quick, contact: contact)
        case .phone(let id):
            guard let number = phoneNumbers.first(where: { $0.id == id }) else { return true }
            return ChatRowSignals.matchesBusinessPhone(contact, number: number)
        case .advanced(let group, let value):
            return ChatRowSignals.matchesAdvanced(group: group, value: value, contact: contact)
        case .custom(let presetID):
            guard let preset = customPresets.first(where: { $0.id == presetID }) else { return true }
            return ChatFilterPresetEvaluator.matches(preset, contact: contact)
        }
    }

    func row(for contactID: String) -> ChatContact? {
        rows.first { $0.id == contactID }
    }

    // MARK: - Filas especiales

    /// Fila fija «Asistente Personal AI» (doc 03 §4.2.3).
    var showsAssistantRow: Bool {
        guard openAIConfigured, appConfig?.aiAgentChatEnabled ?? true else { return false }
        guard !isSelecting, !archivedViewActive, activeFilter == .quick(.all) else { return false }
        let query = ristakFoldedText(searchText)
        guard query.isEmpty || "asistente personal ai".contains(query) else { return false }
        return true
    }

    /// Fila «Archivados» (doc 03 §4.2.5).
    var showsArchivedRow: Bool {
        guard appConfig?.showArchivedChats ?? true else { return false }
        guard !isSelecting, !archivedViewActive, activeFilter == .quick(.all), searchText.isEmpty else { return false }
        return !rows.isEmpty || archivedCount > 0
    }

    // MARK: - Badge de no leídos (dock/tab)

    /// Suma de no leídos de chats NO archivados (doc 03 §4.6).
    var unreadTotal: Int {
        rows.reduce(into: 0) { total, contact in
            guard !localState.isArchived(contact.id), !contact.isCommentOnlyChat else { return }
            total += contact.visibleUnreadCount
        }
    }

    private func syncUnreadBadge() {
        shell?.chatUnreadCount = unreadTotal
    }

    // MARK: - Leídos

    /// Al abrir un chat: optimista a 0 + POST fire-and-forget (doc 03 §4.6).
    func markOpened(contactID: String) {
        setUnreadZero(ids: [contactID])
        Task { try? await chatsService.markChatRead(contactId: contactID) }
    }

    func markRead(contactID: String) {
        setUnreadZero(ids: [contactID])
        Task {
            try? await chatsService.markChatRead(contactId: contactID)
        }
        successHapticTick &+= 1
    }

    private func setUnreadZero(ids: [String]) {
        let idSet = Set(ids)
        for index in rows.indices where idSet.contains(rows[index].id) {
            rows[index].unreadCount = 0
        }
        syncUnreadBadge()
    }

    // MARK: - Silenciar / archivar (estado local)

    func toggleMuted(contactID: String) {
        localState.setMuted(!localState.isMuted(contactID), contactIDs: [contactID])
    }

    func setArchived(_ archived: Bool, contactID: String) {
        localState.setArchived(archived, contactIDs: [contactID])
        syncUnreadBadge()
        successHapticTick &+= 1
    }

    // MARK: - Selección múltiple (doc 03 §4.7)

    func enterSelection(with contactID: String? = nil) {
        isSelecting = true
        selectedIDs = []
        if let contactID { selectedIDs.insert(contactID) }
        selectionHapticTick &+= 1
    }

    func cancelSelection() {
        isSelecting = false
        selectedIDs = []
    }

    func toggleSelected(contactID: String) {
        if selectedIDs.contains(contactID) {
            selectedIDs.remove(contactID)
        } else {
            selectedIDs.insert(contactID)
        }
    }

    var allVisibleSelected: Bool {
        let visible = Set(displayRows.map(\.id))
        return !visible.isEmpty && visible.isSubset(of: selectedIDs)
    }

    func selectVisible() {
        selectedIDs.formUnion(displayRows.map(\.id))
    }

    func deselectVisible() {
        selectedIDs.subtract(displayRows.map(\.id))
    }

    /// Bulk `POST /contacts/chats/read` (no dispara vistos de proveedor).
    func markSelectedRead() {
        let ids = Array(selectedIDs)
        guard !ids.isEmpty else { return }
        setUnreadZero(ids: ids)
        Task { try? await chatsService.markChatsRead(contactIds: ids) }
        successHapticTick &+= 1
        cancelSelection()
    }

    func archiveSelected() {
        localState.setArchived(true, contactIDs: Array(selectedIDs))
        syncUnreadBadge()
        successHapticTick &+= 1
        cancelSelection()
    }

    func restoreSelected() {
        localState.setArchived(false, contactIDs: Array(selectedIDs))
        syncUnreadBadge()
        successHapticTick &+= 1
        cancelSelection()
    }

    func triggerImpactHaptic() {
        impactHapticTick &+= 1
    }

    // MARK: - Chips para la UI

    var chipModels: [ChatFilterChipModel] {
        var models: [ChatFilterChipModel] = []
        for chipID in visibleChipIDs {
            guard let filter = ChatInboxFilter(chipID: chipID) else { continue }
            guard let model = chipModel(for: filter) else { continue }
            models.append(model)
        }
        return models
    }

    private func chipModel(for filter: ChatInboxFilter) -> ChatFilterChipModel? {
        switch filter {
        case .quick(let quick):
            if quick == .comments, !commentsFeatureEnabled { return nil }
            return ChatFilterChipModel(
                filter: filter,
                title: quickChipTitle(quick),
                count: quick == .unread ? unreadTotal : nil,
                isSelected: activeFilter == filter,
                leadingDivider: quick == .comments
            )
        case .phone(let id):
            guard phoneFilterEnabled, let number = phoneNumbers.first(where: { $0.id == id }) else { return nil }
            return ChatFilterChipModel(
                filter: filter,
                title: "Número: \(number.displayTitle)",
                count: nil,
                isSelected: activeFilter == filter
            )
        case .advanced(let group, let value):
            guard let groupEnum = ChatAdvancedFilterGroup(rawValue: group) else { return nil }
            return ChatFilterChipModel(
                filter: filter,
                title: groupEnum.label(for: value),
                count: nil,
                isSelected: activeFilter == filter
            )
        case .custom(let presetID):
            guard let preset = customPresets.first(where: { $0.id == presetID }) else { return nil }
            return ChatFilterChipModel(
                filter: filter,
                title: preset.label,
                count: nil,
                isSelected: activeFilter == filter
            )
        }
    }

    private func quickChipTitle(_ quick: ChatQuickFilter) -> String {
        switch quick {
        case .all: return "Todos"
        case .unread: return "No leídos"
        case .appointments: return "Agendados"
        case .customers: return customLabels.customers
        case .leads: return customLabels.leads
        case .comments: return "Comentarios"
        }
    }

    // MARK: - Manager de filtros («+», doc 03 §3.5)

    var managerSections: [ChatFilterManagerSection] {
        let visible = Set(visibleChipIDs)
        var sections: [ChatFilterManagerSection] = []

        let quickEntries = ChatQuickFilter.allCases.map { quick in
            ChatFilterManagerEntry(
                chipID: quick.rawValue,
                title: quickChipTitle(quick),
                subtitle: quick.managerDescription,
                isVisible: visible.contains(quick.rawValue),
                isLocked: quick == .all
            )
        }
        sections.append(ChatFilterManagerSection(title: "Rápidos", entries: quickEntries))

        if phoneFilterEnabled {
            let phoneEntries = phoneNumbers.map { number in
                ChatFilterManagerEntry(
                    chipID: "phone:\(number.id)",
                    title: "Número: \(number.displayTitle)",
                    subtitle: number.displayPhoneNumber ?? number.phoneNumber ?? "",
                    isVisible: visible.contains("phone:\(number.id)")
                )
            }
            sections.append(ChatFilterManagerSection(title: "Números", entries: phoneEntries))
        }

        for group in ChatAdvancedFilterGroup.allCases {
            let entries = group.options.map { option in
                ChatFilterManagerEntry(
                    chipID: "advanced:\(group.rawValue):\(option.value)",
                    title: option.label,
                    subtitle: group.title,
                    isVisible: visible.contains("advanced:\(group.rawValue):\(option.value)")
                )
            }
            sections.append(ChatFilterManagerSection(title: group.title, entries: entries))
        }

        let presetEntries = customPresets.map { preset in
            ChatFilterManagerEntry(
                chipID: "custom:\(preset.id)",
                title: preset.label,
                subtitle: preset.matchAll ? "Cumple todas las condiciones" : "Cumple cualquier condición",
                isVisible: visible.contains("custom:\(preset.id)"),
                isDeletablePreset: true
            )
        }
        if !presetEntries.isEmpty {
            sections.append(ChatFilterManagerSection(title: "Condicionales", entries: presetEntries))
        }

        return sections
    }

    func setChipVisible(_ chipID: String, visible: Bool) {
        guard chipID != "all" else { return }
        var chips = visibleChipIDs
        if visible {
            guard !chips.contains(chipID) else { return }
            chips.append(chipID)
        } else {
            chips.removeAll { $0 == chipID }
            // Quitar el chip activo resetea a Todos (doc 03 §3.5).
            if activeFilter.chipID == chipID {
                select(filter: .quick(.all))
            }
        }
        persistVisibleChips(chips)
    }

    func restoreBaseChips() {
        persistVisibleChips(ChatFilterChipDefaults.baseChipIDs)
        select(filter: .quick(.all))
    }

    private func persistVisibleChips(_ chips: [String]) {
        guard let appConfig else { return }
        let normalized = ChatFilterChipDefaults.normalized(chips)
        Task {
            do {
                try await appConfig.setAppConfigStringArray(normalized, forKey: RistakAppConfigKey.filterChipIDs)
            } catch {
                self.transientAlertMessage = "No se guardó el filtro"
            }
        }
    }

    /// Borra un preset condicional del config (creación/edición de presets se
    /// administra desde /movil o escritorio; sincronizan por `app_config`).
    func deletePreset(id: String) {
        guard let appConfig else { return }
        let remaining = customPresets.filter { $0.id != id }
        let json = ChatFilterPreset.serializeList(remaining)
        if activeFilter == .custom(id) {
            select(filter: .quick(.all))
        }
        var chips = visibleChipIDs
        chips.removeAll { $0 == "custom:\(id)" }
        persistVisibleChips(chips)
        Task {
            do {
                try await appConfig.setAppConfigValue(json, forKey: RistakAppConfigKey.customFilterPresets)
            } catch {
                self.transientAlertMessage = "No se guardó el filtro"
            }
        }
    }

    // MARK: - Etiquetas (sheet «Agregar etiqueta», doc 03 §4.4)

    func ensureTagsLoaded() async {
        guard !tagsLoaded else { return }
        if let tags = try? await tagsService.fetchTags() {
            tagsCatalog = tags
            tagsLoaded = true
        }
    }

    func tagName(for id: String) -> String? {
        tagsCatalog.first { $0.id == id }?.name
    }

    /// Nombres de etiquetas de una fila (para pills; máx los que la vista pida).
    func tagNames(for contact: ChatContact) -> [String] {
        contact.tags.compactMap { tagName(for: $0) }
    }

    /// Aplica una etiqueta existente. Devuelve `.alreadyTagged` si el contacto
    /// ya la tenía (aviso «Etiqueta ya agregada»).
    func applyTag(_ tag: ContactTag, to contact: ChatContact) async throws -> ChatTagApplyOutcome {
        if contact.tags.contains(tag.id) {
            return .alreadyTagged
        }
        try await tagsService.addTag(tag.id, toContact: contact.id)
        successHapticTick &+= 1
        requestSilentRefresh()
        return .applied
    }

    /// Crea (si no existe) y aplica una etiqueta por nombre.
    func createAndApplyTag(named name: String, to contact: ChatContact) async throws {
        let created = try await tagsService.createTag(name: name)
        if !tagsCatalog.contains(where: { $0.id == created.id }) {
            tagsCatalog.append(created)
        }
        try await tagsService.addTag(created.id, toContact: contact.id)
        successHapticTick &+= 1
        requestSilentRefresh()
    }

    // MARK: - Programar mensaje (doc 05 §2.10; default +1 h)

    var scheduleDefaultDate: Date {
        Date().addingTimeInterval(3600)
    }

    func scheduleMessage(for contact: ChatContact, text: String, at date: Date) async throws {
        let cleanText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanText.isEmpty else {
            throw RistakAPIError(kind: .badRequest, status: 0, message: "Escribe el mensaje que quieres programar.")
        }
        guard !contact.phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RistakAPIError(kind: .badRequest, status: 0, message: "Este contacto necesita teléfono para programar el mensaje.")
        }
        let sender = resolveSender(for: contact)
        guard let fromPhone = sender.phone, !fromPhone.isEmpty else {
            throw RistakAPIError(kind: .badRequest, status: 0, message: "Elige el WhatsApp del negocio que mandará el mensaje.")
        }

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        try await scheduledService.upsert(
            ScheduledMessageUpsertRequest(
                contactId: contact.id,
                provider: "whatsapp_api",
                transport: "api",
                messageType: "text",
                text: cleanText,
                toPhone: contact.phone,
                fromPhone: fromPhone,
                businessPhoneNumberId: sender.phoneNumberID,
                scheduledAt: isoFormatter.string(from: date),
                externalId: "native-scheduled-\(Int(Date().timeIntervalSince1970 * 1000))"
            )
        )
        successHapticTick &+= 1
    }

    /// Remitente: último inbound → último saliente → preferido del contacto →
    /// remitente default → primer número conectado.
    private func resolveSender(for contact: ChatContact) -> (phone: String?, phoneNumberID: String?) {
        if !contact.lastInboundBusinessPhone.isEmpty {
            return (contact.lastInboundBusinessPhone, contact.lastInboundBusinessPhoneNumberId.isEmpty ? nil : contact.lastInboundBusinessPhoneNumberId)
        }
        if !contact.lastBusinessPhone.isEmpty {
            return (contact.lastBusinessPhone, contact.lastBusinessPhoneNumberId.isEmpty ? nil : contact.lastBusinessPhoneNumberId)
        }
        if !contact.preferredWhatsAppPhoneNumberId.isEmpty,
           let preferred = phoneNumbers.first(where: { $0.id == contact.preferredWhatsAppPhoneNumberId }) {
            return (preferred.phoneNumber ?? preferred.displayPhoneNumber, preferred.id)
        }
        if let sender = whatsAppStatus?.sender, let phone = sender.phone, !phone.isEmpty {
            return (phone, sender.phoneNumberId)
        }
        if let first = phoneNumbers.first {
            return (first.phoneNumber ?? first.displayPhoneNumber ?? first.qrConnectedPhone, first.id)
        }
        return (nil, nil)
    }

    // MARK: - Agente conversacional (sheet «Más acciones», doc 03 §4.4)

    /// Estados del agente para el contacto; errores/403 silenciosos → [].
    func loadAgentStates(contactID: String) async -> [ConversationAgentState] {
        (try? await agentService.fetchAllStates(contactId: contactID)) ?? []
    }

    /// Ejecuta una acción del agente sobre todos los estados dados (doc 05
    /// §10.11: un POST por agente). Devuelve `true` si todas pasaron.
    func performAgentAction(
        _ action: ConversationAgentAction,
        contactID: String,
        states: [ConversationAgentState]
    ) async -> Bool {
        let agentIDs: [String?] = states.isEmpty ? [nil] : states.map(\.agentId)
        var allOK = true
        for agentID in agentIDs {
            do {
                try await agentService.updateState(contactId: contactID, action: action, agentId: agentID)
            } catch {
                allOK = false
            }
        }
        if allOK { successHapticTick &+= 1 }
        return allOK
    }

    // MARK: - Nuevo chat

    /// Resultados del sheet «Nuevo chat»: chats recientes que matchean +
    /// `/contacts/search`, deduplicados por id (doc 03 §1.3).
    func newChatResults(query: String) async -> [ChatContact] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let folded = ristakFoldedText(trimmed)

        var merged: [ChatContact] = []
        var seen = Set<String>()

        let recents = trimmed.isEmpty
            ? rows
            : rows.filter { contact in
                ristakFoldedText(ChatRowSignals.displayName(contact)).contains(folded)
                    || ChatRowSignals.digitsOnly(contact.phone).contains(ChatRowSignals.digitsOnly(trimmed))
                    || ristakFoldedText(contact.email).contains(folded)
            }
        for contact in recents.prefix(20) where seen.insert(contact.id).inserted {
            merged.append(contact)
        }

        if !trimmed.isEmpty {
            let found = (try? await contactsService.searchContacts(query: trimmed)) ?? []
            for contact in found where seen.insert(contact.id).inserted {
                merged.append(contact)
            }
        }
        return merged
    }
}
