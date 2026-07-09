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
    /// Cadena serial de operaciones start/stop del engine SSE (ver
    /// `startEventsStream`/`enqueueEventsStop`).
    private var realtimeControl: Task<Void, Never>?
    private var isScenePaused = false
    /// La bandeja está tapada por un hilo abierto en pantalla compacta (iPhone).
    /// Mientras lo esté, su realtime propio se suspende para no correr un SSE
    /// duplicado del que ya abre el hilo ni re-bajar la bandeja entera detrás.
    private var isCoveredByThread = false

    // MARK: Búsqueda (instantánea local + servidor en paralelo)

    var searchText = ""
    private var searchDebounceTask: Task<Void, Never>?
    /// Contactos hallados por `/contacts/search` que aún NO están en la bandeja
    /// ya cargada (sección «Contactos encontrados»).
    private(set) var contactSuggestions: [ChatContact] = []
    private(set) var isSearchingContacts = false
    /// La última búsqueda al servidor falló por red → aviso «Sin conexión»
    /// (solo si además NO hubo coincidencias locales).
    private(set) var searchServerUnavailable = false

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
    private(set) var tagsCatalog: [ContactTag] = [] {
        didSet { rebuildTagNameIndex() }
    }
    /// Índice id→nombre para que `tagName(for:)` sea O(1): antes hacía un scan
    /// lineal del catálogo por cada etiqueta de cada fila visible, cada render.
    @ObservationIgnored private var tagNameByID: [String: String] = [:]
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

        // Cache-first: pintar el snapshot guardado al instante (memoria del
        // `RistakSnapshotCache`, ya precargado en el arranque → cero flash).
        let cached = ChatInboxDiskCache.load()
        if !cached.isEmpty {
            rows = cached
            isShowingCachedData = true
            syncUnreadBadge()
            prefetchAvatars(cached)
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

    @ObservationIgnored private var cachedPresetsRaw: String?
    @ObservationIgnored private var cachedPresets: [ChatFilterPreset] = []
    @ObservationIgnored private var hasCachedPresets = false

    /// Presets parseados, memoizados por el JSON crudo. Antes se re-parseaba el
    /// JSON en CADA `matchesActiveFilter`, o sea por fila visible por render.
    var customPresets: [ChatFilterPreset] {
        let raw = appConfig?.customFilterPresetsRaw
        if !hasCachedPresets || cachedPresetsRaw != raw {
            hasCachedPresets = true
            cachedPresetsRaw = raw
            cachedPresets = ChatFilterPreset.parseList(fromJSON: raw)
        }
        return cachedPresets
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
        async let metaFlagsTask = fetchMetaCommentsFlags()
        async let tagsTask = try? tagsService.fetchTags()

        whatsAppStatus = await statusTask
        if let labels = await labelsTask { customLabels = labels }
        if let integrations = await integrationsTask {
            openAIConfigured = integrations.openai?.isUsable == true
        }
        // Chip «Comentarios»: /movil lo gatea con los switches de COMENTARIOS
        // (no los de DMs) y con OR, sin exigir integración Meta conectada
        // (PhoneChat.tsx: commentsFeatureEnabled = fb || ig). Fetch fallido →
        // fail-open (deja `true` por defecto).
        if let flags = await metaFlagsTask {
            commentsFeatureEnabled = flags.facebook || flags.instagram
        }
        if let tags = await tagsTask {
            tagsCatalog = tags
            tagsLoaded = true
        }
    }

    private func fetchMetaCommentsFlags() async -> (facebook: Bool, instagram: Bool)? {
        let payload: RistakKeyedConfigPayload? = try? await APIClient.shared.get(
            "/api/config",
            query: ["keys": "meta_facebook_comments_enabled,meta_instagram_comments_enabled"]
        )
        guard let payload else { return nil }
        let facebook = RistakStringBool.parse(payload.config["meta_facebook_comments_enabled"] ?? nil) ?? false
        let instagram = RistakStringBool.parse(payload.config["meta_instagram_comments_enabled"] ?? nil) ?? false
        return (facebook, instagram)
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
        // La bandeja SIEMPRE trae la vista completa: la búsqueda es local
        // (más `/contacts/search` en paralelo), nunca reemplaza estas filas.
        return try await chatsService.fetchChats(
            query: "",
            limit: ChatsService.defaultPageSize,
            offset: offset,
            businessPhoneNumberId: params.id,
            businessPhone: params.phone
        )
    }

    /// Clave de los parámetros vigentes de fetch (solo el número; la búsqueda
    /// ya no toca la bandeja).
    private var currentFetchKey: String {
        phoneQueryParams().id ?? ""
    }

    /// Recarga completa (primera página) respetando query y filtro de número.
    private func reloadFromServer(showSpinner: Bool) async {
        if showSpinner {
            isInitialLoading = true
        } else {
            // Carga inicial con caché ya pintada: refresco en segundo plano; el
            // spinner del título «Chats» lo refleja sin bloquear la vista.
            isSilentRefreshing = true
        }
        defer {
            isInitialLoading = false
            isSilentRefreshing = false
        }

        let fetchKey = currentFetchKey
        do {
            let page = try await fetchPage(offset: 0)
            // Si el usuario cambió query/número mientras esta carga volaba,
            // descartar el lote (llega otro reload con los params nuevos).
            guard fetchKey == currentFetchKey else { return }
            let isReplace = rows.isEmpty || isShowingCachedData || loadedFetchKey != fetchKey
            if isReplace {
                if page.isEmpty, !rows.isEmpty || isShowingCachedData {
                    // Vacío TRANSITORIO durante bootstrap/replace (un 200 con []
                    // mientras aún hay chats): NO tirar lo que ya se muestra (caché
                    // o filas previas) ni envenenar el snapshot de disco con []. Se
                    // conserva y se espera al siguiente refresh (poll/SSE), igual
                    // que el camino vivo (mergeRefresh) que nunca vacía la bandeja.
                    // No se tocan serverOffset/hasMore.
                } else {
                    if rows != page { rows = page }
                    // Reemplazo total: el offset y hasMore se rebobinan a 1 página.
                    serverOffset = page.count
                    hasMore = ChatInboxPaginator.hasMore(batchCount: page.count, limit: ChatsService.defaultPageSize)
                }
            } else {
                // Refresh vivo: conservar la profundidad de scroll ya cargada.
                // Rehacer serverOffset/hasMore desde la primera página atascaría
                // el scroll infinito (pediría offsets ya cargados) y reviviría
                // fetches fantasma tras llegar al final (doc 03 §4.9).
                // Solo reasigna (y re-renderiza la lista) si algo cambió: un poll
                // de 12 s idéntico ya no fuerza un re-diff completo de la bandeja.
                let merged = ChatInboxPaginator.mergeRefresh(rows, freshFirstPage: page)
                if merged != rows { rows = merged }
                serverOffset = max(serverOffset, page.count)
            }
            loadedFetchKey = fetchKey
            if loadErrorMessage != nil { loadErrorMessage = nil }
            if isAccessDenied { isAccessDenied = false }
            if isShowingCachedData { isShowingCachedData = false }
            persistCacheSnapshot()
            syncUnreadBadge()
            prefetchAvatars(rows)
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

    /// Pre-calienta la caché de imágenes con los avatares de las primeras filas,
    /// para que aparezcan al instante en el primer scroll (no uno por uno). El
    /// loader ya salta URLs cacheadas o en vuelo, así que llamar de más es inocuo.
    private func prefetchAvatars(_ contacts: [ChatContact], limit: Int = 30) {
        let urls = contacts.prefix(limit).compactMap { $0.profilePhotoUrl.flatMap(URL.init(string:)) }
        guard !urls.isEmpty else { return }
        Task { await RistakImageLoader.shared.prefetch(urls) }
    }

    /// Scroll infinito: dispara la siguiente página cuando el centinela del final
    /// de la lista aparece (ver `InboxScreen`). Antes se llamaba desde el
    /// `.onAppear` de CADA fila y hacía un `firstIndex` O(n) sobre `displayRows`
    /// por aparición → coste ~O(n²) al hacer scroll. Ahora es O(1).
    func loadMoreIfNeeded() {
        guard hasMore, !isLoadingMore else { return }
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
            prefetchAvatars(page)
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

    /// Las operaciones start/stop del engine SSE se encadenan en serie: un
    /// `stop()` suelto que aterrizara después de un `start()` nuevo mataría la
    /// conexión recién abierta y el realtime quedaría muerto hasta el próximo
    /// cambio de escena.
    private func startEventsStream() {
        realtimeTask?.cancel()
        let client = eventsClient
        let previous = realtimeControl
        let task = Task { [weak self] in
            await previous?.value
            if Task.isCancelled { return }
            let stream = await client.start()
            for await event in stream {
                if Task.isCancelled { return }
                guard let self else { return }
                if case .message = event {
                    self.requestSilentRefresh()
                }
            }
        }
        realtimeTask = task
        realtimeControl = task
    }

    private func enqueueEventsStop() {
        realtimeTask?.cancel()
        realtimeTask = nil
        let client = eventsClient
        let previous = realtimeControl
        realtimeControl = Task {
            await previous?.value
            await client.stop()
        }
    }

    func stopRealtime() {
        pollingClock.cancelAll()
        enqueueEventsStop()
    }

    /// scenePhase: pausar polls y cortar SSE en background; al volver,
    /// reconectar y disparar un refresh inmediato.
    func setScenePaused(_ paused: Bool) {
        guard isScenePaused != paused else { return }
        isScenePaused = paused
        pollingClock.setPaused(paused)
        if paused {
            enqueueEventsStop()
        } else if configured && !isCoveredByThread {
            startEventsStream()
            // El refresh de reconciliación al volver a foreground ya lo dispara
            // `pollingClock.setPaused(false)`, que re-ejecuta el ticker "inbox"
            // una vez. Llamar aquí de nuevo provocaba DOS recargas back-to-back.
        }
    }

    /// El hilo abierto tapa la bandeja (solo compacto/iPhone): suspende su
    /// realtime propio. En iPad (regular) el sidebar sigue visible, así que NUNCA
    /// se llama con `true` — la bandeja debe mantenerse viva junto al detalle.
    /// Al destaparse, reanuda y reconcilia con un refresh (lo que llegó mientras).
    func setCoveredByThread(_ covered: Bool) {
        guard configured, isCoveredByThread != covered else { return }
        isCoveredByThread = covered
        if covered {
            pollingClock.cancel("inbox")
            enqueueEventsStop()
        } else if !isScenePaused {
            startRealtime()
            requestSilentRefresh()
        }
    }

    private func persistCacheSnapshot() {
        // Solo cacheamos la vista por defecto (sin filtro de número): es lo que
        // se pinta al instante en el arranque en frío. La búsqueda ya no toca
        // `rows`, así que siempre reflejan la bandeja completa.
        guard !activeFilter.isPhoneFilter else { return }
        ChatInboxDiskCache.save(rows)
    }

    // MARK: - Búsqueda instantánea (local primero, servidor en paralelo)

    /// Consulta comprometida (sin espacios) que dispara el filtrado.
    private var trimmedSearch: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var isSearchActive: Bool { !trimmedSearch.isEmpty }

    /// Al teclear, las coincidencias LOCALES se pintan solas (computed
    /// `localSearchMatches`/`displayRows`, cero red). En paralelo, con ≥2
    /// caracteres, se consulta `/contacts/search` para traer contactos que no
    /// estén en la bandeja cargada. Debounce 240 ms (doc 14 §6.2).
    func searchTextDidChange() {
        searchDebounceTask?.cancel()
        let text = trimmedSearch

        guard !text.isEmpty else {
            contactSuggestions = []
            isSearchingContacts = false
            searchServerUnavailable = false
            return
        }

        // Mientras el usuario sigue escribiendo, olvidamos el aviso de red
        // anterior (las locales se muestran igual sin esperar al servidor).
        searchServerUnavailable = false

        // 1 carácter: solo coincidencias locales, no molestamos al servidor.
        guard text.count >= 2 else {
            contactSuggestions = []
            isSearchingContacts = false
            return
        }

        isSearchingContacts = true
        searchDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 240_000_000)
            guard let self, !Task.isCancelled else { return }
            await self.runServerContactSearch(query: text)
        }
    }

    /// Búsqueda de contactos en el servidor (paralela a las locales). Si falla
    /// por red se marca `searchServerUnavailable`; la vista solo enseña el aviso
    /// «Sin conexión» cuando además NO hubo coincidencias locales.
    private func runServerContactSearch(query: String) async {
        defer { if trimmedSearch == query { isSearchingContacts = false } }
        do {
            let found = try await contactsService.searchContacts(query: query)
            guard !Task.isCancelled, trimmedSearch == query else { return }
            contactSuggestions = found
            searchServerUnavailable = false
        } catch {
            guard !Task.isCancelled, trimmedSearch == query else { return }
            contactSuggestions = []
            searchServerUnavailable = true
        }
    }

    /// Coincidencias LOCALES instantáneas sobre la bandeja ya cargada/cacheada
    /// (nombre, teléfono, correo, último mensaje). Sin red — se pintan al vuelo.
    var localSearchMatches: [ChatContact] {
        let query = trimmedSearch
        guard !query.isEmpty else { return [] }
        let folded = ristakFoldedText(query)
        let digits = ChatRowSignals.digitsOnly(query)
        return rows.filter { contact in
            guard !contact.isCommentOnlyChat else { return false }
            if ristakFoldedText(ChatRowSignals.displayName(contact)).contains(folded) { return true }
            if ristakFoldedText(contact.name).contains(folded) { return true }
            if ristakFoldedText(contact.email).contains(folded) { return true }
            if !digits.isEmpty, ChatRowSignals.digitsOnly(contact.phone).contains(digits) { return true }
            if ristakFoldedText(contact.lastMessageText).contains(folded) { return true }
            return false
        }
    }

    /// Contactos del servidor que aún NO aparecen entre las coincidencias
    /// locales (para la sección «Contactos encontrados»).
    var suggestionRows: [ChatContact] {
        guard isSearchActive else { return [] }
        let localIDs = Set(localSearchMatches.map(\.id))
        return contactSuggestions.filter { !localIDs.contains($0.id) }
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
        // Búsqueda: coincidencias LOCALES instantáneas (sin red). Los contactos
        // del servidor no cacheados salen aparte en «Contactos encontrados».
        if isSearchActive { return localSearchMatches }

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

    // MARK: - Editor de filtros condicionales (paridad /movil, App.tsx §filterEditor)

    /// Catálogo de campos para el editor (Chat / Contacto / Etiquetas). Las
    /// opciones de número de WhatsApp y de etiquetas salen del contexto vivo.
    var conditionFieldGroups: [ChatConditionFieldGroup] {
        ChatConditionFieldCatalog.groups(phoneNumbers: phoneNumbers, tags: tagsCatalog)
    }

    var conditionFields: [ChatConditionField] {
        conditionFieldGroups.flatMap(\.fields)
    }

    func conditionField(forKey key: String) -> ChatConditionField? {
        conditionFields.first { $0.key == key }
    }

    var defaultConditionField: ChatConditionField? {
        conditionField(forKey: ChatConditionFieldCatalog.defaultFieldKey) ?? conditionFields.first
    }

    /// Regla nueva con el operador por defecto del campo dado.
    func makeConditionRule(field: ChatConditionField?) -> ChatCustomFilterDraftRule {
        let target = field ?? defaultConditionField
        return ChatCustomFilterDraftRule(
            field: target?.key ?? ChatConditionFieldCatalog.defaultFieldKey,
            op: ChatConditionOperators.defaultOperator(for: target)
        )
    }

    /// Borrador para «Nuevo filtro» (una condición vacía por defecto).
    func makeNewFilterDraft() -> ChatCustomFilterDraft {
        ChatCustomFilterDraft(rules: [makeConditionRule(field: defaultConditionField)])
    }

    /// Borrador para editar un preset existente.
    func makeEditDraft(for preset: ChatFilterPreset) -> ChatCustomFilterDraft {
        let rules = preset.rules.map { rule in
            ChatCustomFilterDraftRule(
                id: rule.id,
                field: rule.field,
                op: rule.op,
                value: rule.values.first ?? "",
                valueTo: rule.valueTo ?? ""
            )
        }
        return ChatCustomFilterDraft(
            id: preset.id,
            label: preset.label,
            matchAll: preset.matchAll,
            rules: rules.isEmpty ? [makeConditionRule(field: defaultConditionField)] : rules
        )
    }

    /// Al cambiar el campo de una regla: reinicia operador y valores (paridad
    /// `setCustomFilterRuleField`).
    func changeRuleField(in draft: inout ChatCustomFilterDraft, ruleID: String, fieldKey: String) {
        let field = conditionField(forKey: fieldKey) ?? defaultConditionField
        guard let index = draft.rules.firstIndex(where: { $0.id == ruleID }) else { return }
        draft.rules[index].field = field?.key ?? ChatConditionFieldCatalog.defaultFieldKey
        draft.rules[index].op = ChatConditionOperators.defaultOperator(for: field)
        draft.rules[index].value = ""
        draft.rules[index].valueTo = ""
    }

    /// Al cambiar el operador de una regla: limpia valores que ya no aplican.
    func changeRuleOperator(in draft: inout ChatCustomFilterDraft, ruleID: String, op: String) {
        guard let index = draft.rules.firstIndex(where: { $0.id == ruleID }) else { return }
        draft.rules[index].op = op
        if !ChatConditionOperators.needsValue(op) { draft.rules[index].value = "" }
        if !ChatConditionOperators.usesRange(op) { draft.rules[index].valueTo = "" }
    }

    func addRule(to draft: inout ChatCustomFilterDraft) {
        draft.rules.append(makeConditionRule(field: defaultConditionField))
    }

    func removeRule(from draft: inout ChatCustomFilterDraft, ruleID: String) {
        draft.rules.removeAll { $0.id == ruleID }
        if draft.rules.isEmpty {
            draft.rules = [makeConditionRule(field: defaultConditionField)]
        }
    }

    /// ¿La regla está completa? (paridad `isPhoneChatConditionRuleComplete`).
    func isRuleComplete(_ rule: ChatCustomFilterDraftRule) -> Bool {
        guard conditionField(forKey: rule.field) != nil else { return false }
        if !ChatConditionOperators.needsValue(rule.op) { return true }
        let value = rule.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if ChatConditionOperators.usesRange(rule.op) {
            let to = rule.valueTo.trimmingCharacters(in: .whitespacesAndNewlines)
            return !value.isEmpty && !to.isEmpty
        }
        return !value.isEmpty
    }

    /// Guarda (crea o edita) un preset condicional en
    /// `mobile_chat_custom_filter_presets`, en el formato que consume el
    /// evaluador y que sincroniza con /movil. Devuelve un mensaje de error para
    /// mostrar en el editor, o `nil` si arrancó el guardado.
    @discardableResult
    func saveCustomPreset(_ draft: ChatCustomFilterDraft) -> String? {
        guard let appConfig else { return "No se pudo guardar el filtro." }
        let label = draft.label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return "Ponle nombre al filtro." }

        let completeRules: [ChatFilterPresetRule] = draft.rules.compactMap { rule in
            guard isRuleComplete(rule) else { return nil }
            let needsValue = ChatConditionOperators.needsValue(rule.op)
            let usesRange = ChatConditionOperators.usesRange(rule.op)
            let value = rule.value.trimmingCharacters(in: .whitespacesAndNewlines)
            let valueTo = rule.valueTo.trimmingCharacters(in: .whitespacesAndNewlines)
            return ChatFilterPresetRule(
                id: rule.id,
                field: rule.field,
                op: rule.op,
                values: needsValue ? [value] : [],
                valueTo: usesRange ? valueTo : nil
            )
        }
        guard !completeRules.isEmpty else { return "Agrega al menos una condición completa." }

        let presetID = draft.id.isEmpty ? Self.makeCustomPresetID() : draft.id
        let preset = ChatFilterPreset(id: presetID, label: label, matchAll: draft.matchAll, rules: completeRules)

        var presets = customPresets
        if let index = presets.firstIndex(where: { $0.id == presetID }) {
            presets[index] = preset
        } else {
            presets.insert(preset, at: 0)
        }
        let json = ChatFilterPreset.serializeList(presets)

        // El chip nuevo queda visible (si no lo estaba) y se activa el filtro.
        var chips = visibleChipIDs
        let chipID = "custom:\(presetID)"
        if !chips.contains(chipID) { chips.append(chipID) }
        persistVisibleChips(chips)

        Task {
            do {
                try await appConfig.setAppConfigValue(json, forKey: RistakAppConfigKey.customFilterPresets)
                self.select(filter: .custom(presetID))
                self.successHapticTick &+= 1
            } catch {
                self.transientAlertMessage = "No se guardó el filtro"
            }
        }
        return nil
    }

    /// Id estable de preset (paridad `makePhoneChatCustomFilterId`).
    private static func makeCustomPresetID() -> String {
        let stamp = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let rand = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(6)).lowercased()
        return "filter_\(stamp)_\(rand)"
    }

    // MARK: - Etiquetas (sheet «Agregar etiqueta», doc 03 §4.4)

    func ensureTagsLoaded() async {
        guard !tagsLoaded else { return }
        if let tags = try? await tagsService.fetchTags() {
            tagsCatalog = tags
            tagsLoaded = true
        }
    }

    private func rebuildTagNameIndex() {
        tagNameByID = Dictionary(
            tagsCatalog.map { ($0.id, $0.name) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    func tagName(for id: String) -> String? {
        tagNameByID[id]
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
