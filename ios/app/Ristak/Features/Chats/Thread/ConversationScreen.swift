import SwiftUI

/// Pantalla de conversación (contrato cross-agente: el inbox navega aquí).
///
/// - Hilo con ids estables y merges identity-preserving (memoria del
///   proyecto): jamás scroll-jumps en refresh; «bajar al final» flotante.
/// - Composer como `safeAreaInset(bottom)` — un solo dueño del teclado.
/// - Presencia (start/stop con scenePhase + appear), polling 7 s/12 s,
///   SSE + nudges de push en foreground.
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

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access
    @Environment(NotificationRouter.self) private var notificationRouter
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private static let bottomAnchorID = "thread-bottom-anchor"

    init(contactID: String, seedContact: ChatContact?) {
        _viewModel = State(initialValue: ConversationViewModel(contactID: contactID, seedContact: seedContact))
    }

    var body: some View {
        content
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
                ContactInfoScreen(contactID: viewModel.contactID)
            }
            .task {
                viewModel.bind(appConfig: appConfig)
                await viewModel.loadInitial()
                // En un pop rápido la `.task` se cancela durante `loadInitial`:
                // no arranques polling/SSE/presencia después (fuga de tareas).
                guard !Task.isCancelled else { return }
                viewModel.startPolling()
                presence.startViewing(contactID: viewModel.contactID)
            }
            .onDisappear {
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
            .sheet(item: bindableViewModel.infoMessage) { message in
                MessageInfoSheet(message: message, formatters: appConfig.formatters)
            }
            .sheet(item: bindableViewModel.scheduleSheet) { state in
                ThreadScheduleMessageSheet(viewModel: viewModel, state: state)
            }
            .sheet(isPresented: bindableViewModel.isTemplatesSheetPresented) {
                TemplatesPickerSheet(viewModel: viewModel)
            }
            .sheet(isPresented: bindableViewModel.isChannelSheetPresented) {
                ChannelPickerSheet(viewModel: viewModel)
            }
            .sheet(isPresented: bindableViewModel.isTagSheetPresented) {
                TagPickerSheet(viewModel: viewModel)
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
        if viewModel.accessDenied {
            RistakEmptyState(
                icon: "lock.fill",
                title: "Sin acceso",
                message: "No tienes acceso a esta sección."
            )
        } else if let errorMessage = viewModel.loadErrorMessage, !viewModel.hasLoadedOnce {
            RistakErrorState(message: errorMessage) {
                viewModel.retryInitialLoad()
            }
        } else if viewModel.isLoadingInitial && !viewModel.hasLoadedOnce {
            RistakLoadingView(message: "Cargando conversación…")
        } else {
            threadContent
        }
    }

    private var threadContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Cabeceras de día pegajosas (paridad /movil `position: sticky`):
                // una `Section` por día cuya cabecera es la píldora de fecha que
                // flota arriba mientras te desplazas dentro de ese día.
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
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
                                Color.clear.frame(height: 10)
                            } header: {
                                dayGroupHeader(group)
                            }
                        }
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchorID)
                }
                .padding(.horizontal, RistakTheme.Spacing.sm)
                .scrollTargetLayout()
            }
            .background { ChatWallpaperBackground() }
            .defaultScrollAnchor(.bottom)
            // El teclado se cierra al arrastrar el hilo…
            .scrollDismissesKeyboard(.interactively)
            // …y también al tocar fuera del composer/campo de texto (paridad
            // mobile/: `Keyboard.dismiss`). Simultáneo para no robarle el tap a
            // botones ni burbujas.
            .simultaneousGesture(
                TapGesture().onEnded { KeyboardDismisser.dismiss() }
            )
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 140
            } action: { _, isNearBottom in
                viewModel.isNearBottom = isNearBottom
            }
            .refreshable {
                await viewModel.refreshSilently()
            }
            .overlay(alignment: .bottomTrailing) {
                scrollToBottomButton(proxy: proxy)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if access.canWrite(module: .chat) {
                    ComposerView(viewModel: viewModel)
                }
            }
            .onChange(of: viewModel.scrollToBottomSignal) { _, _ in
                withAnimation(.snappy(duration: 0.25)) {
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            }
            .onChange(of: viewModel.pendingScrollAnchorID) { _, anchorID in
                guard let anchorID else { return }
                proxy.scrollTo(anchorID, anchor: .top)
                viewModel.pendingScrollAnchorID = nil
            }
            .onChange(of: quoteScrollTargetID) { _, targetID in
                guard let targetID else { return }
                withAnimation(.snappy(duration: 0.3)) {
                    proxy.scrollTo(targetID, anchor: .center)
                }
                quoteScrollTargetID = nil
            }
            // La cascada necesita el ORDEN de mensajes (solo mensajes, sin días ni
            // markers) para saber cuál audio encadenar al terminar el actual.
            .onChange(of: viewModel.timeline, initial: true) { _, timeline in
                audioCascade.updateOrder(cascadeEntries(from: timeline))
            }
            .environment(audioCascade)
        }
        .searchable(
            text: bindableViewModel.searchQuery,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: "Buscar en este chat"
        )
    }

    // MARK: - Agrupación por día (cabeceras pegajosas)

    /// Timeline plano reagrupado en días. Se deriva del `timeline` estable, así
    /// que ids e items siguen siendo identity-preserving (sin scroll-jumps).
    private var dayGroups: [ConversationDayGroup] {
        ConversationTimelineBuilder.groupByDay(viewModel.timeline)
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

    // MARK: - Piezas

    @ViewBuilder
    private var olderMessagesHeader: some View {
        if viewModel.isLoadingOlder {
            ProgressView()
                .controlSize(.small)
                .padding(.vertical, RistakTheme.Spacing.sm)
                .frame(maxWidth: .infinity)
        } else if viewModel.hasOlderMessages {
            Color.clear
                .frame(height: 26)
                .onAppear {
                    viewModel.loadOlderIfNeeded()
                }
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

    @ViewBuilder
    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        if !viewModel.isNearBottom {
            Button {
                withAnimation(.snappy(duration: 0.25)) {
                    proxy.scrollTo(Self.bottomAnchorID, anchor: .bottom)
                }
            } label: {
                Image(systemName: "chevron.down")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .padding(12)
            }
            .glassEffect(.regular.interactive(), in: Circle())
            .padding(.trailing, RistakTheme.Spacing.md)
            .padding(.bottom, RistakTheme.Spacing.md)
            .accessibilityLabel("Bajar al final")
            .transition(.scale.combined(with: .opacity))
        }
    }

    /// Acciones rápidas de la esquina superior derecha (paridad mobile/
    /// `conversationCallActions`): agendar cita (CalendarDays) y cobrar
    /// (CircleDollarSign). Son PROXIES: presentan el formulario EN SITIO para
    /// este contacto (User #2), sin sacar al usuario del chat.
    @ViewBuilder
    private var headerToolActions: some View {
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
