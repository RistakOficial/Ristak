import Combine
import SwiftUI
import UIKit

/// Pantalla de conversación (contrato cross-agente: el inbox navega aquí).
///
/// - Hilo con ids estables y merges identity-preserving (memoria del
///   proyecto): jamás scroll-jumps en refresh; «bajar al final» flotante.
/// - Historial y compositor comparten la región que deja libre el teclado.
/// - Presencia (start/stop con scenePhase + appear), SSE + nudges de push en
///   foreground y fallback de 25 s solo durante desconexión.
struct ConversationScreen: View {
    @State private var viewModel: ConversationViewModel
    @State private var presence = PresenceReporter()
    /// Coordinador de cascada de notas de voz (autoplay encadenado entre audios
    /// contiguos). Conoce el orden del timeline para decidir el siguiente audio.
    @State private var audioCascade = AudioCascadeCoordinator()
    @State private var showsContactInfo = false
    /// Id del mensaje citado al que hay que saltar (tap en el quote).
    @State private var quoteScrollTargetID: String?
    /// Proxies del header: agendar cita / cobrar EN SITIO para este contacto
    /// (no saltan a las pestañas de Calendarios/Pagos, User #2).
    @State private var showsScheduleForContact = false
    @State private var showsPaymentForContact = false
    /// Invalida reposicionamientos tardíos de una animación anterior del teclado.
    @State private var keyboardReanchorGeneration = 0
    // El borde sigue al último mensaje durante el primer layout, incluso si
    // SwiftUI todavía está calculando las alturas de las secciones.
    @State private var threadPosition = ScrollPosition(idType: String.self, edge: .bottom)
    @State private var historyScrollIntent = ConversationHistoryScrollIntent()
    /// El historial sólo pagina al llegar aquí después de un gesto vertical
    /// real. Un relayout o una descarga de media nunca deben dispararlo.
    @State private var historyBoundaryIsNear = false
    @State private var conversationDragIsActive = false
    @State private var pendingAppointmentConfirmationAction: AppointmentConfirmationAction?

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access
    @Environment(NotificationRouter.self) private var notificationRouter
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(
        contactID: String,
        seedContact: ChatContact?,
        onInboxActivity: @escaping (ChatInboxActivity) -> Void
    ) {
        _viewModel = State(initialValue: ConversationViewModel(
            contactID: contactID,
            seedContact: seedContact,
            onInboxActivity: onInboxActivity
        ))
    }

    var body: some View {
        // El dueño del stream y de la primera carga permanece montado aunque
        // el contenido cambie de carga a mensajes o a respaldo local.
        ZStack { content }
            .navigationBarTitleDisplayMode(.inline)
            // Dentro del hilo el dock estorba (paridad mobile/: la conversación
            // toma toda la pantalla). Solo se oculta en compacto (iPhone); en el
            // split de iPad la barra lateral se queda visible.
            .toolbar(horizontalSizeClass == .compact ? .hidden : .automatic, for: .tabBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    headerButton
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    headerToolActions
                }
            }
            .navigationDestination(isPresented: $showsContactInfo) {
                ContactInfoScreen(contactID: viewModel.contactID, conversation: viewModel)
            }
            .task {
                viewModel.bind(appConfig: appConfig)
                // SSE primero: si el mensaje entra mientras `/conversation`
                // carga, el ViewModel conserva el nudge y reconcilia al quedar
                // listo. No espera a journey/agentes/catálogos secundarios.
                viewModel.startRealtimeBootstrap()
                // Agenda desde ahora el fallback desconectado. Su primer tick es
                // a 25 s y el bootstrap gate lo coalesce si el GET inicial sigue
                // en vuelo; no hay una ventana muerta por catálogos secundarios.
                viewModel.startPolling()
                await viewModel.loadInitial()
                // En un pop rápido la `.task` se cancela durante `loadInitial`:
                // no arranques presencia después (fuga de tareas). SSE y fallback
                // tempranos ya quedaron detenidos por `onDisappear`.
                guard !Task.isCancelled else { return }
                presence.startViewing(contactID: viewModel.contactID)
            }
            .onDisappear {
                keyboardReanchorGeneration &+= 1
                historyScrollIntent.cancel()
                viewModel.stopPolling()
                presence.stopViewing()
            }
            .onChange(of: scenePhase) { _, phase in
                let active = phase == .active
                presence.setForeground(active)
                viewModel.setScenePaused(!active)
            }
            .onChange(of: notificationRouter.foregroundNudgeCount) { _, _ in
                viewModel.handleForegroundNudge(contactID: notificationRouter.lastForegroundContactID)
            }
            .alert(
                viewModel.alert?.title ?? "",
                isPresented: Binding(
                    get: { viewModel.alert != nil },
                    set: { if !$0 { viewModel.alert = nil } }
                ),
                presenting: viewModel.alert
            ) { _ in
                Button("Entendido", role: .cancel) {}
            } message: { alert in
                Text(alert.message)
            }
            .confirmationDialog(
                pendingAppointmentConfirmationAction == .confirm ? "Confirmar cita" : "Cancelar cita",
                isPresented: Binding(
                    get: { pendingAppointmentConfirmationAction != nil },
                    set: { if !$0 { pendingAppointmentConfirmationAction = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let action = pendingAppointmentConfirmationAction {
                    Button(
                        action == .confirm ? "Confirmar" : "Cancelar",
                        role: action == .cancel ? .destructive : nil
                    ) {
                        pendingAppointmentConfirmationAction = nil
                        Task { await viewModel.resolveAppointmentConfirmation(action) }
                    }
                }
                Button("Volver", role: .cancel) {
                    pendingAppointmentConfirmationAction = nil
                }
            } message: {
                if let action = pendingAppointmentConfirmationAction,
                   let confirmation = viewModel.activeAppointmentConfirmation {
                    Text(appointmentConfirmationPrompt(confirmation, action: action))
                }
            }
            .sheet(item: bindableViewModel.infoMessage) { message in
                MessageInfoSheet(message: message, formatters: appConfig.formatters)
            }
            .sheet(item: bindableViewModel.scheduleSheet) { state in
                ThreadScheduleMessageSheet(viewModel: viewModel, state: state)
            }
            .sheet(isPresented: bindableViewModel.isTemplatesSheetPresented) {
                TemplatesPickerSheet(viewModel: viewModel)
            }
            .sheet(isPresented: bindableViewModel.isTagSheetPresented) {
                TagPickerSheet(viewModel: viewModel)
            }
            .sheet(isPresented: bindableViewModel.agentControlsPresented) {
                AgentControlsSheet(viewModel: viewModel)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            // Proxy «Agendar cita»: formulario de cita para ESTE contacto,
            // presentado en sitio (no salta a Calendarios).
            .sheet(isPresented: $showsScheduleForContact) {
                AppointmentComposeSheet(
                    contactID: viewModel.contactID,
                    contactName: viewModel.displayName,
                    contactPhone: viewModel.contactPhone,
                    onSaved: {}
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
            // Proxy «Cobrar»: opciones de cobro + formulario para ESTE contacto,
            // presentado en sitio (no salta a Pagos).
            .sheet(isPresented: $showsPaymentForContact) {
                PaymentComposeSheet(
                    contactID: viewModel.contactID,
                    contactName: viewModel.displayName,
                    contactEmail: viewModel.contactEmail,
                    contactPhone: viewModel.contactPhone,
                    onDone: {}
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
    }

    private var bindableViewModel: Bindable<ConversationViewModel> {
        Bindable(viewModel)
    }

    // MARK: - Contenido por estado

    @ViewBuilder
    private var content: some View {
        switch ConversationInitialPresentation.resolve(
            accessDenied: viewModel.accessDenied,
            loadErrorMessage: viewModel.loadErrorMessage,
            hasLoadedOnce: viewModel.hasLoadedOnce,
            timelineIsEmpty: viewModel.timeline.isEmpty,
            blocksCachedHistory: viewModel.blocksCachedHistory
        ) {
        case .accessDenied:
            RistakEmptyState(
                icon: "lock.fill",
                title: "Sin acceso",
                message: "No tienes acceso a esta sección."
            )
        case .error(let errorMessage):
            RistakErrorState(message: errorMessage) {
                viewModel.retryInitialLoad()
            }
        case .loading:
            RistakLoadingView(message: "Cargando conversación…")
        case .content:
            threadContent
        }
    }

    private var threadContent: some View {
        VStack(spacing: 0) {
            messageHistory
            if access.canWrite(module: .chat) {
                if let confirmation = viewModel.activeAppointmentConfirmation {
                    appointmentConfirmationBar(confirmation)
                }
                ComposerView(viewModel: viewModel)
            }
        }
        .searchable(
            text: bindableViewModel.searchQuery,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: "Buscar en este chat"
        )
    }

    private var messageHistory: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Cabeceras de día pegajosas (paridad /movil `position: sticky`):
                // una `Section` por día cuya cabecera es la píldora de fecha que
                // flota arriba mientras te desplazas dentro de ese día.
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if viewModel.isShowingCachedData {
                        CacheRefreshPillRow()
                            .padding(.vertical, RistakTheme.Spacing.xs)
                    }
                    olderMessagesHeader

                    if viewModel.timeline.isEmpty {
                        emptyState
                            .padding(.top, 80)
                    } else {
                        ForEach(dayGroups) { group in
                            Section {
                                ForEach(group.items) { item in
                                    timelineRow(item)
                                        .id(item.id)
                                }
                                // Respiro inferior del grupo: sumado al inset de
                                // la siguiente cabecera da ~18 pt entre días
                                // (paridad `.messageDayGroup + { margin-top:18px }`).
                                if group.id != dayGroups.last?.id {
                                    Color.clear.frame(height: 10)
                                }
                            } header: {
                                dayGroupHeader(group)
                            }
                        }
                    }
                }
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .scrollTargetLayout()
            }
            .accessibilityIdentifier("ristak-conversation-history")
            .contentMargins(.bottom, 0, for: .scrollContent)
            .background { ChatWallpaperBackground() }
            // El borde es una posición del scroll, disponible incluso si SwiftUI
            // todavía no ha materializado la última burbuja. El gesto del usuario
            // reemplaza esa posición cuando decide leer el historial.
            .scrollPosition($threadPosition)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            // Cuando el historial es más corto que el viewport, el aire sobrante
            // va ARRIBA. El último globo queda pegado al composer, no flotando en
            // medio de la pantalla.
            .defaultScrollAnchor(.bottom, for: .alignment)
            // El teclado se cierra al arrastrar el hilo…
            .scrollDismissesKeyboard(.interactively)
            // …y también al tocar fuera del composer/campo de texto (paridad
            // mobile/: `Keyboard.dismiss`). Simultáneo para no robarle el tap a
            // botones ni burbujas.
            .simultaneousGesture(
                TapGesture().onEnded { KeyboardDismisser.dismiss() }
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 6)
                    .onChanged { value in
                        guard abs(value.translation.height) > abs(value.translation.width),
                              !conversationDragIsActive else { return }
                        conversationDragIsActive = true
                        keyboardReanchorGeneration &+= 1
                        historyScrollIntent.beginDrag(towardHistory: value.translation.height > 0)
                        if historyBoundaryIsNear, historyScrollIntent.consume() {
                            viewModel.loadOlderIfNeeded()
                        }
                    }
                    .onEnded { _ in
                        conversationDragIsActive = false
                    }
            )
            .onScrollPhaseChange { _, phase in
                if phase == .idle { historyScrollIntent.cancel() }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 140
            } action: { _, isNearBottom in
                viewModel.isNearBottom = isNearBottom
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y <= 140
            } action: { _, isNearHistoryBoundary in
                historyBoundaryIsNear = isNearHistoryBoundary
                if isNearHistoryBoundary,
                   historyScrollIntent.consume() {
                    viewModel.loadOlderIfNeeded()
                }
            }
            .refreshable {
                await viewModel.refreshSilently()
            }
            .conversationScrollToBottomControl(
                isNearBottom: Binding(
                    get: { viewModel.isNearBottom },
                    set: { viewModel.isNearBottom = $0 }
                ),
                onJumpStarted: prepareForManualJump,
                scrollToBottom: {
                    threadPosition.scrollTo(edge: .bottom)
                }
            )
            .onChange(of: viewModel.scrollToBottomSignal) { _, _ in
                guard !conversationDragIsActive else { return }
                if threadPosition.edge != .bottom {
                    withAnimation(.snappy(duration: 0.25)) {
                        threadPosition.scrollTo(edge: .bottom)
                    }
                }
            }
            .onChange(of: viewModel.pendingScrollAnchorID) { _, anchorID in
                guard let anchorID else { return }
                proxy.scrollTo(anchorID, anchor: .top)
                viewModel.pendingScrollAnchorID = nil
            }
            .onChange(of: quoteScrollTargetID) { _, targetID in
                guard let targetID else { return }
                prepareForManualJump()
                withAnimation(.snappy(duration: 0.3)) {
                    proxy.scrollTo(targetID, anchor: .center)
                }
                quoteScrollTargetID = nil
            }
            // `willChangeFrame` cubre abrir, cerrar, QuickType y cambios de
            // teclado. Capturamos el estado ANTES del relayout y estabilizamos el
            // fondo al principio y al terminar la animación del teclado.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
                stabilizeForKeyboardTransition(notification)
            }
            // La cascada necesita el ORDEN de mensajes (solo mensajes, sin días ni
            // markers) para saber cuál audio encadenar al terminar el actual.
            .onChange(of: viewModel.timeline, initial: true) { _, timeline in
                audioCascade.updateOrder(cascadeEntries(from: timeline))
            }
            .environment(audioCascade)
        }
    }

    /// Invalida cualquier salto de teclado pendiente y la intención de paginar.
    private func prepareForManualJump() {
        historyScrollIntent.cancel()
        keyboardReanchorGeneration &+= 1
    }

    /// Conserva visible el final si el usuario estaba abajo antes de que el
    /// teclado cambiara el viewport. El segundo salto ocurre después de la
    /// duración reportada por UIKit: ahí el `LazyVStack` ya conoce su geometría
    /// definitiva y no puede quedarse apuntando a un hueco sin materializar.
    private func stabilizeForKeyboardTransition(_ notification: Notification) {
        guard viewModel.isNearBottom, !conversationDragIsActive else { return }
        keyboardReanchorGeneration &+= 1
        let generation = keyboardReanchorGeneration
        let duration = (notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25

        threadPosition.scrollTo(edge: .bottom)
        DispatchQueue.main.async {
            guard generation == keyboardReanchorGeneration else { return }
            threadPosition.scrollTo(edge: .bottom)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, duration) + 0.05) {
            guard generation == keyboardReanchorGeneration else { return }
            threadPosition.scrollTo(edge: .bottom)
        }
    }

    // MARK: - Agrupación por día (cabeceras pegajosas)

    /// Timeline plano reagrupado en días. Ahora se computa UNA vez por cambio real
    /// de timeline dentro del ViewModel (`rebuildTimeline`), no en cada render del
    /// body — antes re-agrupaba O(n) todo el hilo en cada flip de scroll/tick/poll.
    private var dayGroups: [ConversationDayGroup] {
        viewModel.dayGroups
    }

    /// Orden de SOLO mensajes (sin días ni markers) para la cascada de audios:
    /// un audio encadena con el siguiente si ese siguiente mensaje también lo es.
    private func cascadeEntries(from timeline: [ConversationTimelineItem]) -> [AudioCascadeCoordinator.Entry] {
        timeline.compactMap { item in
            guard case .message(let message) = item else { return nil }
            return AudioCascadeCoordinator.Entry(
                id: message.id,
                isAudio: message.attachment?.type == .audio
            )
        }
    }

    @ViewBuilder
    private func dayGroupHeader(_ group: ConversationDayGroup) -> some View {
        if group.label.isEmpty {
            // Grupo sin fecha (timestamps inválidos): sin píldora.
            Color.clear.frame(height: 0)
        } else {
            StickyDaySeparator(label: group.label)
        }
    }

    // MARK: - Filas

    @ViewBuilder
    private func timelineRow(_ item: ConversationTimelineItem) -> some View {
        switch item {
        case .day(_, let label):
            DaySeparatorView(label: label)
        case .activity(let marker):
            ActivityMarkerView(marker: marker, formatters: appConfig.formatters)
        case .message(let message):
            MessageRowView(
                message: message,
                formatters: appConfig.formatters,
                contactName: viewModel.displayName,
                contactPhotoURL: viewModel.avatarURL,
                scheduledCountdown: scheduledCountdown(for: message),
                actions: rowActions
            )
            // Salta el re-render de burbujas sin cambios cuando el padre re-evalúa
            // por poll/tick/scroll (ver `MessageRowView.==`).
            .equatable()
        }
    }

    private func scheduledCountdown(for message: ChatMessage) -> String? {
        guard message.isScheduled,
              let target = RistakDateParsing.date(fromISO: message.scheduledAt ?? message.date) else {
            return nil
        }
        return ChatJourneyParser.scheduledCountdownLabel(until: target, now: viewModel.scheduledTickNow)
    }

    private var rowActions: MessageRowActions {
        MessageRowActions(
            reply: { viewModel.beginReply(to: $0) },
            react: { message, emoji in viewModel.react(to: message, emoji: emoji) },
            copy: { viewModel.copyMessage($0) },
            info: { viewModel.infoMessage = $0 },
            retry: { viewModel.retryFailedMessage($0) },
            editScheduled: { viewModel.beginEditingScheduled(message: $0) },
            deleteScheduled: { viewModel.cancelScheduled(message: $0) },
            scrollTo: { quoteScrollTargetID = $0 },
            reactionCapability: { viewModel.reactionCapability(for: $0) },
            findReplyTarget: { viewModel.findReplyTarget(for: $0) },
            commentContext: { message in
                viewModel.commentContexts[message.id]
                    ?? message.providerMessageId.flatMap { viewModel.commentContexts[$0] }
            }
        )
    }

    private func appointmentConfirmationBar(_ confirmation: ActiveAppointmentConfirmation) -> some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            Image(systemName: "calendar.badge.exclamationmark")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(RistakTheme.accent)
                .frame(width: 32, height: 32)
                .background(RistakTheme.accentSoft, in: Circle())

            VStack(alignment: .leading, spacing: 1) {
                Text(confirmation.currentStatus == "confirmed" ? "RECONFIRMACIÓN PENDIENTE" : "CONFIRMACIÓN PENDIENTE")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(RistakTheme.accent)
                    .lineLimit(1)
                Text(confirmation.title.isEmpty ? "Cita" : confirmation.title)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)
                Text(appointmentConfirmationMeta(confirmation))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 5) {
                Button {
                    pendingAppointmentConfirmationAction = .confirm
                } label: {
                    appointmentConfirmationButtonLabel(
                        "Confirmar",
                        icon: "checkmark.circle",
                        action: .confirm
                    )
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(RistakTheme.accent)
                .disabled(viewModel.appointmentConfirmationAction != nil)

                Button {
                    pendingAppointmentConfirmationAction = .cancel
                } label: {
                    appointmentConfirmationButtonLabel(
                        "Cancelar",
                        icon: "xmark.circle",
                        action: .cancel
                    )
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(RistakTheme.neg)
                .disabled(viewModel.appointmentConfirmationAction != nil)
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.sm)
        .padding(.vertical, RistakTheme.Spacing.xs)
        .background(RistakTheme.surface)
        .overlay(alignment: .top) {
            Divider()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ristak-appointment-confirmation-control")
    }

    @ViewBuilder
    private func appointmentConfirmationButtonLabel(
        _ title: String,
        icon: String,
        action: AppointmentConfirmationAction
    ) -> some View {
        if viewModel.appointmentConfirmationAction == action {
            ProgressView()
                .controlSize(.small)
                .frame(minWidth: 70)
        } else {
            Label(title, systemImage: icon)
                .font(.system(size: 11, weight: .bold))
                .frame(minWidth: 70)
        }
    }

    private func appointmentConfirmationMeta(_ confirmation: ActiveAppointmentConfirmation) -> String {
        let source = confirmation.sourceType == "automation"
            ? "Automatización"
            : "Recordatorio del calendario"
        let date = appointmentConfirmationDate(confirmation)
        return [date, source].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func appointmentConfirmationDate(_ confirmation: ActiveAppointmentConfirmation) -> String {
        guard let date = RistakDateParsing.date(fromISO: confirmation.startTime) else { return "" }
        return [
            appConfig.formatters.daySeparatorLabel(date),
            appConfig.formatters.messageTime(date)
        ].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func appointmentConfirmationPrompt(
        _ confirmation: ActiveAppointmentConfirmation,
        action: AppointmentConfirmationAction
    ) -> String {
        let title = confirmation.title.isEmpty ? "Cita" : confirmation.title
        let date = appointmentConfirmationDate(confirmation)
        if action == .confirm {
            return "Vas a confirmar “\(title)”\(date.isEmpty ? "" : " para \(date)") y cerrar su espera automática."
        }
        return "Vas a cancelar “\(title)”\(date.isEmpty ? "" : " de \(date)") y cerrar su espera automática."
    }

    // MARK: - Piezas

    @ViewBuilder
    private var olderMessagesHeader: some View {
        if viewModel.isLoadingOlder {
            ProgressView()
                .controlSize(.small)
                .padding(.vertical, RistakTheme.Spacing.sm)
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !viewModel.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
            RistakEmptyState(
                icon: "magnifyingglass",
                title: "Sin resultados",
                message: "Cambia la búsqueda para ver otros mensajes."
            )
            .frame(height: 280)
        } else {
            RistakEmptyState(
                icon: "bubble.left.and.bubble.right",
                title: "Aún no hay mensajes",
                message: "Escribe el primer mensaje o usa + para tomar acciones."
            )
            .frame(height: 280)
        }
    }

    /// Acciones rápidas de la esquina superior derecha (paridad mobile/
    /// `conversationCallActions`): agendar cita (CalendarDays) y cobrar
    /// (CircleDollarSign). Son PROXIES: presentan el formulario EN SITIO para
    /// este contacto (User #2), sin sacar al usuario del chat.
    @ViewBuilder
    private var headerToolActions: some View {
        if viewModel.hasAgentControls {
            // Botcito del agente conversacional: prendido (acento) cuando algún
            // agente atiende activamente este chat; si sigue asignado pero está
            // pausado conserva el robot y agrega la marca de pausa. Los estados
            // humanos/omitidos/terminales ya no montan este control.
            Button {
                viewModel.agentControlsPresented = true
            } label: {
                AgentBotGlyph(
                    color: viewModel.agentControllerActive ? RistakTheme.accent : RistakTheme.textDim,
                    size: 22,
                    paused: viewModel.agentControllerPaused
                )
            }
            .accessibilityLabel("Controles del agente")

            // Con agente asignado, su botcito ocupa el header y el nombre (que abre
            // la info del contacto) queda apretado/difícil de tocar. Este botón de
            // "persona" garantiza siempre poder abrir la info del contacto.
            Button {
                showsContactInfo = true
            } label: {
                Image(systemName: "person.crop.circle")
            }
            .accessibilityLabel("Info del contacto")
        }

        Button {
            showsScheduleForContact = true
        } label: {
            Image(systemName: "calendar")
        }
        .accessibilityLabel("Agendar cita")

        Button {
            showsPaymentForContact = true
        } label: {
            Image(systemName: "dollarsign.circle")
        }
        .accessibilityLabel("Cobrar")
    }

    private var headerButton: some View {
        Button {
            showsContactInfo = true
        } label: {
            HStack(spacing: RistakTheme.Spacing.xs) {
                ContactAvatarView(
                    name: viewModel.displayName,
                    photoURL: viewModel.avatarURL,
                    size: 34,
                    channel: viewModel.headerChannel
                )
                VStack(alignment: .leading, spacing: 0) {
                    Text(viewModel.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)
                    if !viewModel.headerDetail.isEmpty {
                        Text(viewModel.headerDetail)
                            .font(.caption2)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Info del contacto: \(viewModel.displayName)")
    }
}
