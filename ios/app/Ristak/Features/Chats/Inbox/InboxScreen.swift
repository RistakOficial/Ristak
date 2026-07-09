import SwiftUI
import UIKit

/// Pantalla de la bandeja de chats (lista + chips + estados, doc research/03).
/// Se usa igual como raíz del stack (iPhone) y como sidebar del split (iPad).
struct InboxScreen: View {
    @Bindable var viewModel: InboxViewModel
    /// Conversación abierta en el detalle (iPad) para resaltar la fila.
    var selectedContactID: String?
    let onOpenChat: (ChatContact) -> Void
    let onOpenAssistant: () -> Void

    @Environment(ShellState.self) private var shell
    @Environment(AccessStore.self) private var access

    @State private var activeSheet: InboxSheet?
    /// Cámara global (foto/video) del header — flujo separado de `activeSheet`.
    @State private var cameraPickerPresented = false
    @State private var cameraShareVM: CameraShareViewModel?
    /// Hub del agente conversacional (encender/pausar/editar), abierto desde el
    /// botón robot del header (paridad /movil).
    @State private var showsAgentHub = false

    enum InboxSheet: Identifiable {
        case more(ChatContact)
        case tag(ChatContact)
        case schedule(ChatContact)
        case filters
        case newChat

        var id: String {
            switch self {
            case .more(let contact): return "more-\(contact.id)"
            case .tag(let contact): return "tag-\(contact.id)"
            case .schedule(let contact): return "schedule-\(contact.id)"
            case .filters: return "filters"
            case .newChat: return "new-chat"
            }
        }
    }

    var body: some View {
        content
            // Título grande «Chats» de siempre (diseño original intacto).
            // Los refrescos de fondo son silenciosos para no ensuciar la vista.
            .navigationTitle("Chats")
            .navigationSubtitle(inboxSubtitle)
            .searchable(text: $viewModel.searchText, prompt: "Buscar chats")
            .onChange(of: viewModel.searchText) {
                viewModel.searchTextDidChange()
            }
            .toolbar {
                if access.canRead(module: .aiAgent) {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            showsAgentHub = true
                        } label: {
                            AgentBotGlyph(color: RistakTheme.accent, size: 22)
                        }
                        .accessibilityLabel("Agente conversacional")
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // Cámara global (a la IZQUIERDA del «+»): toma foto/video y
                    // lo manda a uno o varios contactos por WhatsApp.
                    Button {
                        cameraPickerPresented = true
                    } label: {
                        Image(systemName: "camera")
                    }
                    .accessibilityLabel("Cámara")

                    Button {
                        activeSheet = .newChat
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Nuevo chat")
                }
            }
            .sheet(isPresented: $showsAgentHub) {
                AgentHubSheet()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: $activeSheet) { sheet in
                sheetContent(sheet)
                    .presentationDetents([.medium, .large])
            }
            .fullScreenCover(isPresented: $cameraPickerPresented) {
                InboxCameraPicker { capture in
                    handleCameraCapture(capture)
                }
                .ignoresSafeArea()
            }
            .sheet(item: $cameraShareVM) { shareVM in
                CameraShareSheet(viewModel: shareVM)
                    .presentationDetents([.large])
            }
            .sensoryFeedback(.selection, trigger: viewModel.selectionHapticTick)
            .sensoryFeedback(.impact(weight: .medium), trigger: viewModel.impactHapticTick)
            .sensoryFeedback(.success, trigger: viewModel.successHapticTick)
            .alert("Aviso", isPresented: transientAlertBinding) {
                Button("Entendido", role: .cancel) {}
            } message: {
                Text(viewModel.transientAlertMessage ?? "")
            }
    }

    /// Subtítulo del header: sólo conteo útil. Los refrescos de fondo no se
    /// anuncian visualmente para mantener limpia la bandeja.
    private var inboxSubtitle: String {
        return viewModel.unreadTotal > 0 ? "\(viewModel.unreadTotal) sin leer" : ""
    }

    // MARK: - Estados raíz

    @ViewBuilder
    private var content: some View {
        // La lista (con su `.searchable`) SIEMPRE está montada: nada de loader a
        // pantalla completa que oculte el buscador. El único estado que sí
        // reemplaza la pantalla es «Sin acceso» (permiso denegado, sin datos).
        if viewModel.isAccessDenied, viewModel.displayRows.isEmpty {
            RistakEmptyState(
                icon: "lock",
                title: "Sin acceso",
                message: "No tienes acceso a esta sección."
            )
        } else {
            inboxList
        }
    }

    // MARK: - Lista

    private var inboxList: some View {
        List {
            if viewModel.isSelecting {
                ChatSelectionPanel(
                    selectedCount: viewModel.selectedIDs.count,
                    allVisibleSelected: viewModel.allVisibleSelected,
                    isArchivedView: viewModel.archivedViewActive,
                    onMarkRead: { viewModel.markSelectedRead() },
                    onArchiveOrRestore: {
                        viewModel.archivedViewActive ? viewModel.restoreSelected() : viewModel.archiveSelected()
                    },
                    onToggleSelectVisible: {
                        viewModel.allVisibleSelected ? viewModel.deselectVisible() : viewModel.selectVisible()
                    },
                    onCancel: { viewModel.cancelSelection() }
                )
                .listRowSeparator(.hidden)
            } else if !viewModel.isSearchActive {
                chipsRow
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }

            if viewModel.showsAssistantRow {
                AssistantChatRow()
                    .onTapGesture { onOpenAssistant() }
                    .ristakRowSeparator()
            }

            if viewModel.archivedViewActive {
                ArchivedAccessRow(count: viewModel.archivedCount, isBackRow: true)
                    .onTapGesture { viewModel.closeArchivedView() }
                    .ristakRowSeparator()
            } else if viewModel.showsArchivedRow {
                ArchivedAccessRow(count: viewModel.archivedCount, isBackRow: false)
                    .onTapGesture { viewModel.openArchivedView() }
                    .ristakRowSeparator()
            }

            ForEach(viewModel.displayRows) { contact in
                chatRow(contact)
            }

            // Centinela de paginación: una sola fila invisible al final dispara la
            // siguiente página al entrar en pantalla. Reemplaza el `.onAppear` por
            // fila (que hacía un firstIndex O(n) sobre displayRows por aparición).
            if viewModel.hasMore, !viewModel.isSearchActive {
                Color.clear
                    .frame(height: 1)
                    .listRowSeparator(.hidden)
                    .onAppear { viewModel.loadMoreIfNeeded() }
            }

            if viewModel.isLoadingMore, !viewModel.isSearchActive {
                HStack(spacing: RistakTheme.Spacing.xs) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Cargando más chats…")
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .listRowSeparator(.hidden)
            }

            if viewModel.isSearchActive {
                // Contactos del servidor no cacheados + estado de la búsqueda.
                searchResults
            } else if viewModel.displayRows.isEmpty {
                defaultEmptyContent
                    .listRowSeparator(.hidden)
            }
        }
        // Reset limpio: cambiar la identidad remonta la List en su posición nativa
        // inicial. Evita `scrollTo` a una fila, que colapsa el header/search.
        .id(shell.chatsScrollTopSignal)
        .listStyle(.plain)
        .refreshable {
            await viewModel.refreshNow()
        }
        // Dock por dirección de scroll (#11): bajar oculta el tab bar, subir lo
        // muestra. Solo compacto; ver `ShellScrollTracking.swift`.
        .reportsShellScroll()
    }

    /// Fila de chat extraída a función para no reventar el type-checker del List
    /// (la fila + overlay + modificadores es demasiado para inferir inline).
    /// Tap + long-press vía UIKit (`RowGestureOverlay`): tap abre el chat;
    /// long-press (0.3s, tolerante) dispara haptic + «Más acciones» AL INSTANTE
    /// (el `.onLongPressGesture` de SwiftUI se sentía lentísimo en un List).
    private func chatRow(_ contact: ChatContact) -> some View {
        ChatRowView(
            contact: contact,
            formatters: viewModel.formatters,
            showPreview: viewModel.showLastPreview,
            showUnreadIndicators: viewModel.showUnreadIndicators,
            isMuted: viewModel.localState.isMuted(contact.id),
            isSelecting: viewModel.isSelecting,
            isSelected: viewModel.selectedIDs.contains(contact.id),
            isActive: selectedContactID == contact.id,
            tagNames: viewModel.tagNames(for: contact)
        )
        .overlay {
            RowGestureOverlay(
                onTap: { handleTap(contact) },
                onLongPress: { handleLongPress(contact) }
            )
        }
        .ristakRowSeparator()
    }

    private func handleTap(_ contact: ChatContact) {
        if viewModel.isSelecting {
            viewModel.toggleSelected(contactID: contact.id)
        } else {
            onOpenChat(contact)
        }
    }

    private func handleLongPress(_ contact: ChatContact) {
        guard !viewModel.isSelecting else { return }
        viewModel.triggerImpactHaptic()
        activeSheet = .more(contact)
    }

    // MARK: - Chips de filtros (doc 03 §4.1)

    private var chipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: RistakTheme.Spacing.xs) {
                if viewModel.activeFilter.isCommentsLens {
                    commentsLensChips
                } else {
                    standardChips
                }

                Button {
                    activeSheet = .filters
                } label: {
                    Image(systemName: "plus")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(RistakTheme.controlRest))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Más filtros")
            }
        }
        .ristakEdgeToEdgeChips(horizontalInset: RistakTheme.Spacing.md)
    }

    @ViewBuilder
    private var standardChips: some View {
        ForEach(viewModel.chipModels) { chip in
            if chip.leadingDivider {
                Rectangle()
                    .fill(RistakTheme.border)
                    .frame(width: 1, height: 22)
                    .accessibilityHidden(true)
            }
            RistakFilterChip(
                title: chip.title,
                count: chip.count,
                isSelected: chip.isSelected
            ) {
                viewModel.select(filter: chip.filter)
            }
        }
    }

    /// Modo lente de comentarios: `Comentarios (tap = salir) · Todas ·
    /// Facebook · Instagram · +` (doc 03 §4.1).
    @ViewBuilder
    private var commentsLensChips: some View {
        RistakFilterChip(
            title: "Comentarios",
            systemImage: "xmark",
            isSelected: true
        ) {
            viewModel.exitCommentsLens()
        }

        ForEach(ChatCommentsPlatform.allCases, id: \.rawValue) { platform in
            RistakFilterChip(
                title: platform.title,
                isSelected: viewModel.commentsPlatform == platform
            ) {
                viewModel.selectCommentsPlatform(platform)
            }
        }
    }

    // MARK: - Vacíos y sugerencias (doc 03 §4.9)

    /// Resultados de búsqueda: contactos del servidor no cacheados + estado
    /// (buscando / sin conexión / sin resultados). Las coincidencias locales ya
    /// se pintaron arriba como filas normales (`displayRows`), al instante.
    @ViewBuilder
    private var searchResults: some View {
        if !viewModel.suggestionRows.isEmpty {
            Section {
                ForEach(viewModel.suggestionRows) { contact in
                    suggestionRow(contact)
                        .ristakRowSeparator()
                }
            } header: {
                Text("Contactos encontrados")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
            }
        }

        if viewModel.displayRows.isEmpty, viewModel.suggestionRows.isEmpty {
            searchStatusContent
                .listRowSeparator(.hidden)
        }
    }

    /// Estado cuando la búsqueda no tiene NADA que mostrar todavía. Sin spinner:
    /// mientras el servidor responde solo hay un texto sutil; el aviso de red
    /// aparece únicamente si la consulta falló y no hubo coincidencias locales.
    @ViewBuilder
    private var searchStatusContent: some View {
        if viewModel.isSearchingContacts {
            Text("Buscando contactos…")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, RistakTheme.Spacing.xl)
        } else if viewModel.searchServerUnavailable {
            RistakEmptyState(
                icon: "wifi.slash",
                title: "Sin conexión con el servidor",
                message: "Encontramos lo que tienes guardado. Revisa tu conexión para buscar más contactos."
            )
            .frame(minHeight: 280)
        } else {
            RistakEmptyState(
                icon: "magnifyingglass",
                title: "Sin resultados",
                message: "No encontramos chats ni contactos con esa búsqueda."
            )
            .frame(minHeight: 280)
        }
    }

    /// Vacío de la vista normal (sin búsqueda). En el PRIMER arranque sin caché
    /// mantenemos el chrome montado y en silencio (nada de spinner) hasta que
    /// llega la primera página; si la carga falla y no hay datos, error inline.
    @ViewBuilder
    private var defaultEmptyContent: some View {
        if viewModel.archivedViewActive {
            RistakEmptyState(
                icon: "archivebox",
                title: "No hay nada archivado",
                message: "Los chats que archives aparecerán aquí."
            )
            .frame(minHeight: 280)
        } else if viewModel.activeFilter != .quick(.all) {
            RistakEmptyState(
                icon: "bubble.left.and.bubble.right",
                title: "No hay chats en este filtro",
                message: "Cambia el filtro o busca un contacto para iniciar una conversación."
            )
            .frame(minHeight: 280)
        } else if viewModel.isInitialLoading {
            // Primer arranque sin caché: chrome visible, en silencio (sin loader).
            Color.clear.frame(height: 1)
        } else if let error = viewModel.loadErrorMessage {
            RistakErrorState(message: error) {
                Task { await viewModel.refreshNow() }
            }
            .frame(minHeight: 280)
        } else {
            VStack(spacing: RistakTheme.Spacing.md) {
                RistakEmptyState(
                    icon: "bubble.left.and.bubble.right",
                    title: "Aún no hay chats",
                    message: "Cuando llegue un mensaje de WhatsApp, Messenger o Instagram aparecerá aquí."
                )
                .frame(minHeight: 240)

                Button {
                    activeSheet = .newChat
                } label: {
                    Label("Nuevo chat", systemImage: "plus")
                        .fontWeight(.semibold)
                }
                .buttonStyle(.borderedProminent)
            }
            .frame(maxWidth: .infinity)
            .padding(.bottom, RistakTheme.Spacing.xl)
        }
    }

    private func suggestionRow(_ contact: ChatContact) -> some View {
        HStack(spacing: RistakTheme.Spacing.sm) {
            ContactAvatarView(
                name: ChatRowSignals.displayName(contact),
                photoURL: contact.profilePhotoUrl.flatMap(URL.init(string:)),
                size: 54,
                channel: ChatRowSignals.badgeChannel(contact)
            )
            // Misma huella (48×48) que las filas de chat: alineación de texto y
            // separador uniformes en toda la bandeja.
            .frame(width: 48, height: 48)

            VStack(alignment: .leading, spacing: 2) {
                Text(ChatRowSignals.displayName(contact))
                    .font(.body)
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)

                Text(ChatRowSignals.contactDetailSubtitle(contact))
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { onOpenChat(contact) }
    }

    // MARK: - Sheets

    @ViewBuilder
    private func sheetContent(_ sheet: InboxSheet) -> some View {
        switch sheet {
        case .more(let contact):
            ChatMoreActionsSheet(contact: contact, viewModel: viewModel) { action in
                handleMoreAction(action, contact: contact)
            }
        case .tag(let contact):
            ContactTagSheet(contact: contact, viewModel: viewModel)
        case .schedule(let contact):
            InboxScheduleMessageSheet(
                contact: contact,
                viewModel: viewModel,
                businessTimeZone: viewModel.formatters.timeZone
            )
        case .filters:
            FilterManagerSheet(viewModel: viewModel)
        case .newChat:
            NewChatSheet(viewModel: viewModel) { contact in
                onOpenChat(contact)
            }
        }
    }

    private func handleMoreAction(_ action: ChatMoreAction, contact: ChatContact) {
        switch action {
        case .select:
            viewModel.enterSelection(with: contact.id)
        case .scheduleAppointment:
            // TODO(chats-inbox): cambiar al sheet nativo de cita cuando el
            // módulo Calendarios exponga su formulario embebible; por ahora
            // salta a la sección con el contacto precargado (patrón RN
            // `navigateToContactTool`).
            shell.openCalendars(contactID: contact.id)
        case .registerPayment:
            // TODO(chats-inbox): ídem con el sheet de cobro del módulo Pagos.
            shell.openPayments(contactID: contact.id)
        case .scheduleMessage:
            presentAfterDismiss(.schedule(contact))
        case .addTag:
            presentAfterDismiss(.tag(contact))
        case .toggleMute:
            viewModel.toggleMuted(contactID: contact.id)
        case .markRead:
            viewModel.markRead(contactID: contact.id)
        case .toggleArchive:
            viewModel.setArchived(!viewModel.localState.isArchived(contact.id), contactID: contact.id)
        }
    }

    /// Espera la animación de cierre del sheet anterior antes de abrir otro
    /// (iOS bloquea modal sobre modal).
    private func presentAfterDismiss(_ sheet: InboxSheet) {
        Task {
            try? await Task.sleep(nanoseconds: 420_000_000)
            activeSheet = sheet
        }
    }

    // MARK: - Cámara global (header)

    /// Codifica la foto/video capturado (mismos límites del composer) y abre el
    /// sheet «Enviar media» para elegir destinatarios. El pequeño respiro deja
    /// que la cámara termine de cerrarse antes de presentar el sheet.
    private func handleCameraCapture(_ capture: InboxCameraCapture) {
        cameraPickerPresented = false
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            do {
                let media: EncodedChatMedia
                let preview: UIImage?
                switch capture {
                case .image(let image):
                    media = try MediaEncoder.encodeImage(image)
                    preview = image
                case .video(let url):
                    media = try await Task.detached(priority: .userInitiated) {
                        try MediaEncoder.encodeVideoFile(at: url)
                    }.value
                    preview = InboxCameraThumbnail.generate(from: url)
                }
                cameraShareVM = CameraShareViewModel(media: media, previewImage: preview, inbox: viewModel)
            } catch {
                viewModel.transientAlertMessage = (error as? LocalizedError)?.errorDescription
                    ?? "No pude preparar la foto o video."
            }
        }
    }

    private var transientAlertBinding: Binding<Bool> {
        Binding(
            get: { viewModel.transientAlertMessage != nil },
            set: { if !$0 { viewModel.transientAlertMessage = nil } }
        )
    }
}
