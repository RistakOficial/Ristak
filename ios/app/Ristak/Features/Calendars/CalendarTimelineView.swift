import SwiftUI

/// Panel de timeline Día/Semana:
/// - Tira de semana (dom–sáb) para elegir día; swipe horizontal cambia de
///   día/semana (paridad RN, ≥56 pt).
/// - Rejilla de 24 h (54 pt/h) con etiquetas `12 a.m. … 11 p.m.`, scrolleable
///   por todo el día.
/// - Día = una sola columna; Semana = 7 columnas reales (paridad RN).
/// - Tap en un hueco → Nueva cita en ese minuto snapeado al `slotInterval`.
/// - Long-press → haptic + arrastrar estira el rango → Nueva cita (el scroll se
///   deshabilita mientras hay selección viva, como en RN).
struct CalendarTimelinePane: View {
    let model: CalendarsViewModel
    /// Día ancla de esta página (el pager pasa el día ±1 / semana ±1). Por
    /// defecto el día seleccionado del modelo.
    var anchorDay: CalendarBusinessDay
    /// `false` en las páginas contiguas del pager: solo lectura para el
    /// descubrimiento durante el arrastre (User #8).
    var interactive: Bool = true
    let canCreate: Bool
    let onCreate: (AppointmentPrefill) -> Void
    let onEventTap: (CalendarAppointment) -> Void

    private var isWeekMode: Bool { model.viewMode == .week }

    /// Día = una columna (con tira de círculos arriba para elegir el día).
    /// Semana = 7 columnas reales (dom–sáb), cada una con su fecha.
    private var timelineDays: [CalendarBusinessDay] {
        isWeekMode
            ? CalendarDateMath.weekDays(containing: anchorDay, timeZone: model.timeZone)
            : [anchorDay]
    }

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            // La tira de círculos solo en Día (en Semana cada columna trae su
            // propia fecha en el encabezado de la rejilla).
            if !isWeekMode {
                weekStrip
            }

            CalendarTimelineGridView(
                days: timelineDays,
                model: model,
                canCreate: interactive && canCreate,
                onCreate: onCreate,
                onEventTap: interactive ? onEventTap : { _ in }
            )
        }
    }

    // MARK: - Tira de semana (círculos estilo iPhone)

    /// Fila de 7 días como en el calendario de iPhone: letra del día arriba y el
    /// número abajo dentro de un CÍRCULO cuando está seleccionado (relleno de
    /// acento + texto blanco). Hoy sin seleccionar se tiñe de acento. Sin
    /// contenedores/cajas. El swipe entre día/semana lo maneja el pager.
    private var weekStrip: some View {
        HStack(spacing: 0) {
            ForEach(Array(CalendarDateMath.weekDays(containing: anchorDay, timeZone: model.timeZone).enumerated()), id: \.element) { index, day in
                let isSelected = day == model.selectedDay
                let isToday = day == model.today
                Button {
                    withAnimation(.snappy(duration: 0.18)) { model.select(day: day) }
                } label: {
                    VStack(spacing: 4) {
                        Text(CalendarDateMath.weekdayLetters[index % 7])
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(RistakTheme.textDim)
                        Text("\(day.day)")
                            .font(.body.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(dayNumberColor(isSelected: isSelected, isToday: isToday))
                            .frame(width: 34, height: 34)
                            .background {
                                if isSelected {
                                    Circle().fill(RistakTheme.accent)
                                }
                            }
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!interactive)
                .accessibilityLabel(CalendarDateMath.dayHeader(day, timeZone: model.timeZone))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.md)
    }

    private func dayNumberColor(isSelected: Bool, isToday: Bool) -> Color {
        if isSelected { return RistakTheme.onAccent }
        if isToday { return RistakTheme.accent }
        return RistakTheme.textPrimary
    }
}

// MARK: - Rejilla de horas

private struct CalendarTimelineGridView: View {
    let days: [CalendarBusinessDay]
    let model: CalendarsViewModel
    let canCreate: Bool
    let onCreate: (AppointmentPrefill) -> Void
    let onEventTap: (CalendarAppointment) -> Void

    /// Alto por hora (vista Día estilo Apple Calendar: filas espaciadas).
    private let hourHeight: CGFloat = 60
    private let labelColumnWidth: CGFloat = 60

    private var totalHeight: CGFloat { hourHeight * 24 }

    /// Háptico al crear/seleccionar.
    @State private var createHaptic = 0
    /// Selección de rango en vivo (UILongPress + arrastre). Mientras existe, el
    /// scroll se congela para que el arrastre estire el rango.
    @State private var dragSelection: TimelineRange?
    /// Reloj para la posición VIVA de la línea roja de "ahora" (tic cada 60 s).
    @State private var nowDate = Date()
    /// Anima el fundido/escala de entrada de las citas (al cargar y al cambiar de día).
    @State private var eventsAppeared = false

    /// Minutos desde medianoche de negocio del instante actual.
    private var nowMinutes: Int {
        CalendarDateMath.minutesFromMidnight(of: nowDate, timeZone: model.timeZone)
    }

    /// ¿Hoy está entre las columnas visibles? (línea + burbuja de "ahora").
    private var todayInView: Bool { days.contains(model.today) }

    var body: some View {
        VStack(spacing: 0) {
            // Encabezado de columnas SOLO en Semana: fecha de cada día arriba de
            // su columna (dom–sáb), sin caja/contenedor.
            if days.count > 1 {
                columnHeaders
            }

            ScrollViewReader { proxy in
                ScrollView {
                    HStack(alignment: .top, spacing: 0) {
                        hourLabels
                        ForEach(days, id: \.self) { day in
                            dayColumn(day)
                                .overlay(alignment: .leading) {
                                    Rectangle()
                                        .fill(RistakTheme.border.opacity(0.5))
                                        .frame(width: 0.5)
                                }
                        }
                    }
                    .padding(.vertical, RistakTheme.Spacing.sm)
                    .padding(.trailing, RistakTheme.Spacing.md)
                }
                // El scroll solo se congela MIENTRAS hay una selección de rango
                // viva (para que el arrastre estire el rango). El gesto de
                // selección es un `UILongPressGestureRecognizer` (UIKit) que
                // convive con el pan del ScrollView: un swipe normal desplaza y
                // solo un long-press quieto arranca la selección.
                .scrollDisabled(dragSelection != nil)
                .onAppear {
                    scrollToInitialHour(proxy)
                    animateEventsIn()
                }
            }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: createHaptic)
        // Tic del indicador de "ahora": mueve la línea roja a su posición viva.
        .task {
            while !Task.isCancelled {
                nowDate = Date()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        // Cambiar de día (swipe del pager o tap en la tira) reanima las citas.
        .onChange(of: days) { _, _ in
            animateEventsIn()
        }
    }

    /// Abre desplazado ~1 h antes de la hora actual (si hoy está a la vista);
    /// si no, cerca de las 8 a.m. para no arrancar en medianoche.
    private func scrollToInitialHour(_ proxy: ScrollViewProxy) {
        let targetHour: Int
        if todayInView {
            let hour = CalendarDateMath.minutesFromMidnight(of: Date(), timeZone: model.timeZone) / 60
            targetHour = min(max(hour - 1, 0), 21)
        } else {
            targetHour = 8
        }
        proxy.scrollTo("timeline-hour-\(targetHour)", anchor: .top)
    }

    /// Reinicia y dispara el fundido + escala de entrada de las citas.
    private func animateEventsIn() {
        eventsAppeared = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(16))
            withAnimation(.easeOut(duration: 0.3)) { eventsAppeared = true }
        }
    }

    private var hourLabels: some View {
        ZStack(alignment: .topTrailing) {
            Color.clear
                .frame(width: labelColumnWidth, height: totalHeight)

            ForEach(0..<24, id: \.self) { hour in
                // Estilo Apple: se atenúa la etiqueta que quede detrás de la
                // burbuja de "ahora" para que no se encimen.
                let hiddenByNow = todayInView && abs(hour * 60 - nowMinutes) < 24
                Text(CalendarDateMath.hourLabel(hour))
                    .font(.caption2)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(width: labelColumnWidth - 8, alignment: .trailing)
                    .opacity(hiddenByNow ? 0 : 1)
                    .offset(y: CGFloat(hour) * hourHeight - 6)
                    .id("timeline-hour-\(hour)")
            }

            // Burbuja roja con la hora actual, anclada a la posición viva.
            if todayInView {
                Text(CalendarDateMath.shortClock(minutesFromMidnight: nowMinutes))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(RistakTheme.onAccent)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(RistakTheme.neg))
                    .offset(x: -2, y: yPosition(forMinute: nowMinutes) - 9)
                    .allowsHitTesting(false)
            }
        }
        .accessibilityHidden(true)
    }

    // MARK: Columna de un día

    private func dayColumn(_ day: CalendarBusinessDay) -> some View {
        GeometryReader { geometry in
            let width = geometry.size.width

            ZStack(alignment: .topLeading) {
                // Líneas de hora (más marcadas para ver la separación).
                ForEach(0..<25, id: \.self) { hour in
                    Rectangle()
                        .fill(RistakTheme.border.opacity(hour % 24 == 0 ? 0.75 : 0.5))
                        .frame(height: hour % 24 == 0 ? 1 : 0.75)
                        .offset(y: CGFloat(hour) * hourHeight)
                }

                // Capa interactiva (#2): un UILongPressGestureRecognizer (UIKit)
                // que CONVIVE con el scroll nativo — mantener presionado (0.28 s)
                // arranca la selección, arrastrar estira el rango y al soltar se
                // abre Nueva cita con ese rango (que luego pide contacto); un swipe
                // normal solo desplaza. Doble-tap crea un hueco rápido. Va DEBAJO
                // de las citas para que tocar una cita abra su detalle.
                if canCreate {
                    TimelineGestureOverlay(
                        onBegan: { y in beginSelection(day: day, y: y) },
                        onChanged: { y in extendSelection(y: y) },
                        onEnded: { commitSelection() },
                        onDoubleTap: { y in quickCreate(day: day, y: y) }
                    )
                    .frame(height: totalHeight)
                }

                // Indicador de hora actual (solo el día de hoy), posición viva.
                if day == model.today {
                    nowLine(width: width)
                }

                // Rango en vivo de la selección.
                if let sel = dragSelection, sel.day == day {
                    selectionOverlay(sel, width: width)
                }

                // Eventos.
                ForEach(positionedEvents(for: day)) { positioned in
                    eventCard(positioned, columnWidth: width)
                }
            }
        }
        .frame(height: totalHeight)
        .frame(maxWidth: .infinity)
    }

    private func nowLine(width: CGFloat) -> some View {
        HStack(spacing: 0) {
            Circle()
                .fill(RistakTheme.neg)
                .frame(width: 8, height: 8)
            Rectangle()
                .fill(RistakTheme.neg)
                .frame(height: 2)
        }
        .frame(width: width)
        .offset(y: yPosition(forMinute: nowMinutes) - 4)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: Encabezado de columnas (Semana)

    /// Fila de fechas arriba de cada columna en la vista Semana (dom–sáb): letra
    /// del día + número, sin caja. Hoy en círculo de acento.
    private var columnHeaders: some View {
        HStack(alignment: .top, spacing: 0) {
            Color.clear.frame(width: labelColumnWidth, height: 1)
            ForEach(Array(days.enumerated()), id: \.element) { index, day in
                let isToday = day == model.today
                VStack(spacing: 2) {
                    Text(CalendarDateMath.weekdayLetters[index % 7])
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(RistakTheme.textDim)
                    Text("\(day.day)")
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(isToday ? RistakTheme.onAccent : RistakTheme.textPrimary)
                        .frame(width: 28, height: 28)
                        .background { if isToday { Circle().fill(RistakTheme.accent) } }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.trailing, RistakTheme.Spacing.md)
        .padding(.bottom, 4)
    }

    // MARK: Selección de rango (UILongPress + arrastre) que CONVIVE con el scroll

    /// Arranca la selección en el minuto snapeado bajo el dedo.
    private func beginSelection(day: CalendarBusinessDay, y: CGFloat) {
        guard canCreate else { return }
        let anchor = snappedMinute(fromY: y)
        dragSelection = TimelineRange(
            day: day,
            anchorMinute: anchor,
            currentMinute: min(anchor + model.slotStepMinutes, 24 * 60)
        )
        createHaptic &+= 1
    }

    /// Estira el rango mientras el dedo se arrastra.
    private func extendSelection(y: CGFloat) {
        guard dragSelection != nil else { return }
        dragSelection?.currentMinute = rawMinute(fromY: y)
    }

    /// Al soltar: abre Nueva cita con el rango (que luego pide el contacto).
    private func commitSelection() {
        guard let sel = dragSelection else { return }
        defer { dragSelection = nil }
        let lo = min(sel.anchorMinute, sel.currentMinute)
        let hi = max(sel.anchorMinute, sel.currentMinute)
        let duration = max(hi - lo, model.defaultDurationMinutes)
        onCreate(AppointmentPrefill(day: sel.day, startMinutes: lo, durationMinutes: duration))
    }

    /// Doble-tap: cita rápida de duración por defecto en el minuto tocado.
    private func quickCreate(day: CalendarBusinessDay, y: CGFloat) {
        guard canCreate else { return }
        createHaptic &+= 1
        onCreate(AppointmentPrefill(
            day: day,
            startMinutes: snappedMinute(fromY: y),
            durationMinutes: model.defaultDurationMinutes
        ))
    }

    private func rawMinute(fromY y: CGFloat) -> Int {
        let minute = Int((y / hourHeight) * 60)
        return min(max(minute, 0), 24 * 60)
    }

    private func snappedMinute(fromY y: CGFloat) -> Int {
        let step = max(model.slotStepMinutes, 5)
        let minute = rawMinute(fromY: y)
        return min(max((minute / step) * step, 0), 24 * 60 - step)
    }

    private func selectionOverlay(_ sel: TimelineRange, width: CGFloat) -> some View {
        let lo = min(sel.anchorMinute, sel.currentMinute)
        let hi = max(sel.anchorMinute, sel.currentMinute, lo + model.slotStepMinutes)
        let top = yPosition(forMinute: lo)
        let height = max(hourHeight * CGFloat(hi - lo) / 60, 22)
        let formatters = BusinessFormatters(timeZone: model.timeZone)

        return RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
            .fill(RistakTheme.accent.opacity(0.9))
            .frame(width: max(width - 8, 0), height: height)
            .overlay(alignment: .topLeading) {
                if let start = CalendarDateMath.date(day: sel.day, minutes: lo, timeZone: model.timeZone),
                   let end = CalendarDateMath.date(day: sel.day, minutes: hi, timeZone: model.timeZone) {
                    Text("\(formatters.messageTime(start)) – \(formatters.messageTime(end))")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.onAccent)
                        .padding(6)
                        .lineLimit(1)
                }
            }
            .offset(x: 4, y: top)
            .allowsHitTesting(false)
    }

    private func yPosition(forMinute minute: Int) -> CGFloat {
        hourHeight * CGFloat(minute) / 60
    }

    // MARK: Posicionamiento de eventos

    private struct PositionedEvent: Identifiable {
        let event: CalendarAppointment
        let startMinute: Int
        let durationMinutes: Int
        let column: Int
        let columnCount: Int
        var id: String { event.id.isEmpty ? "\(startMinute)-\(event.title)" : event.id }
    }

    /// Asignación de columnas por clúster de solape (greedy).
    private func positionedEvents(for day: CalendarBusinessDay) -> [PositionedEvent] {
        let events = model.events(on: day)
        guard !events.isEmpty else { return [] }

        struct Slot {
            let event: CalendarAppointment
            let start: Int
            let end: Int
            var column = 0
        }

        var slots: [Slot] = events.compactMap { event in
            guard let start = event.startDate else { return nil }
            let startMinute = min(max(CalendarDateMath.minutesFromMidnight(of: start, timeZone: model.timeZone), 0), 24 * 60 - 15)
            var endMinute = startMinute + 30
            if let end = event.endDate, end > start {
                endMinute = startMinute + Int(end.timeIntervalSince(start) / 60)
            }
            endMinute = min(max(endMinute, startMinute + 20), 24 * 60)
            return Slot(event: event, start: startMinute, end: endMinute)
        }
        slots.sort { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }

        var result: [PositionedEvent] = []
        var clusterEnd = -1
        var columnEnds: [Int] = []
        var pendingCluster: [Slot] = []

        func flushCluster() {
            guard !pendingCluster.isEmpty else { return }
            let columnCount = columnEnds.count
            for slot in pendingCluster {
                result.append(PositionedEvent(
                    event: slot.event,
                    startMinute: slot.start,
                    durationMinutes: slot.end - slot.start,
                    column: slot.column,
                    columnCount: max(columnCount, 1)
                ))
            }
            pendingCluster = []
            columnEnds = []
        }

        for var slot in slots {
            if slot.start >= clusterEnd {
                flushCluster()
                clusterEnd = slot.end
            }
            clusterEnd = max(clusterEnd, slot.end)

            if let free = columnEnds.firstIndex(where: { $0 <= slot.start }) {
                slot.column = free
                columnEnds[free] = slot.end
            } else {
                slot.column = columnEnds.count
                columnEnds.append(slot.end)
            }
            pendingCluster.append(slot)
        }
        flushCluster()
        return result
    }

    private func eventCard(_ positioned: PositionedEvent, columnWidth: CGFloat) -> some View {
        let usable = max(columnWidth - 8, 0)
        let width = usable / CGFloat(positioned.columnCount)
        let height = max(hourHeight * CGFloat(positioned.durationMinutes) / 60 - 3, 22)
        let statusColor = positioned.event.appointmentStatus?.displayColor ?? RistakTheme.accent
        let formatters = BusinessFormatters(timeZone: model.timeZone)
        let showTime = height >= 32
        let titleLines = height >= 48 ? 2 : 1

        return Button {
            onEventTap(positioned.event)
        } label: {
            // Estilo Apple Calendar: bloque redondeado con relleno suave teñido
            // (SIN borde) + barra de acento del color del estado a la izquierda;
            // título y hora en el color del evento, dentro del bloque.
            HStack(spacing: 0) {
                Rectangle()
                    .fill(statusColor)
                    .frame(width: 3)

                VStack(alignment: .leading, spacing: 1) {
                    Text(positioned.event.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(statusColor)
                        .lineLimit(titleLines)

                    if showTime, let start = positioned.event.startDate {
                        Text(formatters.messageTime(start))
                            .font(.caption2)
                            .foregroundStyle(statusColor.opacity(0.85))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, 6)
                .padding(.trailing, 6)
                .padding(.vertical, 4)
            }
            .frame(width: max(width - 2, 22), height: height, alignment: .topLeading)
            .background(statusColor.opacity(0.16))
            .clipShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
        // Entrada suave (fundido + leve escala) al cargar / cambiar de día.
        .opacity(eventsAppeared ? 1 : 0)
        .scaleEffect(eventsAppeared ? 1 : 0.96, anchor: .topLeading)
        .offset(
            x: 4 + CGFloat(positioned.column) * width,
            y: yPosition(forMinute: positioned.startMinute) + 1
        )
        .accessibilityLabel("\(positioned.event.title), \(positioned.event.appointmentStatus?.displayLabel ?? "")")
    }
}


// MARK: - Rango de selección en vivo

private struct TimelineRange: Equatable {
    let day: CalendarBusinessDay
    var anchorMinute: Int
    var currentMinute: Int
}

// MARK: - Overlay de gestos (UIKit) que CONVIVE con el scroll

/// Capa transparente con un `UILongPressGestureRecognizer` + doble-tap. El
/// long-press (0.28 s) convive con el pan del `ScrollView` de SwiftUI (UIKit los
/// reconoce en simultáneo): un swipe normal desplaza y solo un long-press quieto
/// arranca la selección de rango. Reporta la coordenada Y del dedo dentro del
/// contenido (mapeable a minutos por el consumidor).
private struct TimelineGestureOverlay: UIViewRepresentable {
    let onBegan: (CGFloat) -> Void
    let onChanged: (CGFloat) -> Void
    let onEnded: () -> Void
    let onDoubleTap: (CGFloat) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear

        let longPress = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleLongPress(_:))
        )
        longPress.minimumPressDuration = 0.28
        longPress.delegate = context.coordinator
        view.addGestureRecognizer(longPress)

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = context.coordinator
        view.addGestureRecognizer(doubleTap)

        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: TimelineGestureOverlay
        init(_ parent: TimelineGestureOverlay) { self.parent = parent }

        @objc func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
            let y = gesture.location(in: gesture.view).y
            switch gesture.state {
            case .began: parent.onBegan(y)
            case .changed: parent.onChanged(y)
            case .ended, .cancelled, .failed: parent.onEnded()
            default: break
            }
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard gesture.state == .ended else { return }
            parent.onDoubleTap(gesture.location(in: gesture.view).y)
        }

        // Deja que el pan del ScrollView (y demás gestos) se reconozcan a la vez:
        // el long-press solo "gana" al mantener quieto; un swipe desplaza.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }
}
