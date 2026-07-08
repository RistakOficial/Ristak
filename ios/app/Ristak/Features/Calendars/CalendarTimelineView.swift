import SwiftUI

/// Panel de timeline Día/Semana:
/// - Tira de semana (dom–sáb) para elegir día; swipe horizontal cambia de
///   día/semana (paridad RN, ≥56 pt).
/// - Rejilla de 24 h (54 pt/h) con etiquetas `12 a.m. … 11 p.m.`.
/// - Tap en un hueco → Nueva cita en ese minuto snapeado al `slotInterval`.
/// - Long-press (0.38 s) → haptic + arrastrar estira el rango → Nueva cita.
/// - En ancho regular (iPad) el modo Semana muestra 7 columnas reales.
struct CalendarTimelinePane: View {
    let model: CalendarsViewModel
    /// Semana con columnas reales (iPad regular).
    let showsWeekColumns: Bool
    let canCreate: Bool
    let onCreate: (AppointmentPrefill) -> Void
    let onEventTap: (CalendarAppointment) -> Void

    private var isWeekMode: Bool { model.viewMode == .week }

    private var timelineDays: [CalendarBusinessDay] {
        if isWeekMode && showsWeekColumns {
            return CalendarDateMath.weekDays(containing: model.selectedDay, timeZone: model.timeZone)
        }
        return [model.selectedDay]
    }

    var body: some View {
        VStack(spacing: RistakTheme.Spacing.sm) {
            weekStrip

            CalendarTimelineGridView(
                days: timelineDays,
                model: model,
                canCreate: canCreate,
                onCreate: onCreate,
                onEventTap: onEventTap
            )
        }
    }

    // MARK: - Tira de semana

    private var weekStrip: some View {
        HStack(spacing: 4) {
            ForEach(Array(CalendarDateMath.weekDays(containing: model.selectedDay, timeZone: model.timeZone).enumerated()), id: \.element) { index, day in
                let isSelected = day == model.selectedDay
                Button {
                    withAnimation(.snappy(duration: 0.18)) { model.select(day: day) }
                } label: {
                    VStack(spacing: 2) {
                        Text(CalendarDateMath.weekdayLetters[index % 7])
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textDim)
                        Text("\(day.day)")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(isSelected ? RistakTheme.onAccent : RistakTheme.textPrimary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background {
                        // Selección = relleno sólido de acento (regla Ristak).
                        if isSelected {
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                                .fill(RistakTheme.accent)
                        } else {
                            RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                                .fill(RistakTheme.controlRest)
                        }
                    }
                    .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(CalendarDateMath.dayHeader(day, timeZone: model.timeZone))
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(.horizontal, RistakTheme.Spacing.md)
        .contentShape(Rectangle())
        .gesture(stripSwipeGesture)
    }

    private var stripSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let step = isWeekMode ? 7 : 1
                if value.translation.width <= -56 {
                    withAnimation(.snappy) { model.shiftSelectedDay(by: step) }
                } else if value.translation.width >= 56 {
                    withAnimation(.snappy) { model.shiftSelectedDay(by: -step) }
                }
            }
    }
}

// MARK: - Rejilla de horas

private struct CalendarTimelineGridView: View {
    let days: [CalendarBusinessDay]
    let model: CalendarsViewModel
    let canCreate: Bool
    let onCreate: (AppointmentPrefill) -> Void
    let onEventTap: (CalendarAppointment) -> Void

    /// Alto por hora (paridad RN: 54).
    private let hourHeight: CGFloat = 54
    private let labelColumnWidth: CGFloat = 56

    private var totalHeight: CGFloat { hourHeight * 24 }

    /// Selección en vivo del long-press + arrastre.
    @State private var selection: TimelineDragSelection?

    var body: some View {
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
            .onAppear {
                // Arranca cerca de las 8 a.m. para no abrir en medianoche.
                proxy.scrollTo("timeline-hour-8", anchor: .top)
            }
        }
        .sensoryFeedback(.selection, trigger: selection != nil)
    }

    private var hourLabels: some View {
        ZStack(alignment: .topTrailing) {
            Color.clear
                .frame(width: labelColumnWidth, height: totalHeight)

            ForEach(0..<24, id: \.self) { hour in
                Text(CalendarDateMath.hourLabel(hour))
                    .font(.caption2)
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(width: labelColumnWidth - 8, alignment: .trailing)
                    .offset(y: CGFloat(hour) * hourHeight - 6)
                    .id("timeline-hour-\(hour)")
            }
        }
        .accessibilityHidden(true)
    }

    // MARK: Columna de un día

    private func dayColumn(_ day: CalendarBusinessDay) -> some View {
        GeometryReader { geometry in
            let width = geometry.size.width

            ZStack(alignment: .topLeading) {
                // Líneas de hora.
                ForEach(0..<25, id: \.self) { hour in
                    Rectangle()
                        .fill(RistakTheme.border.opacity(hour % 24 == 0 ? 0.7 : 0.35))
                        .frame(height: 0.5)
                        .offset(y: CGFloat(hour) * hourHeight)
                }

                // Capa interactiva de huecos.
                Color.clear
                    .frame(height: totalHeight)
                    .contentShape(Rectangle())
                    .onTapGesture { location in
                        guard canCreate else { return }
                        let minute = snappedMinute(fromY: location.y)
                        onCreate(AppointmentPrefill(
                            day: day,
                            startMinutes: minute,
                            durationMinutes: model.defaultDurationMinutes
                        ))
                    }
                    .gesture(rangeGesture(for: day))

                // Indicador de hora actual (solo el día de hoy).
                if day == model.today {
                    nowIndicator(width: width)
                }

                // Eventos.
                ForEach(positionedEvents(for: day)) { positioned in
                    eventCard(positioned, columnWidth: width)
                }

                // Rango en vivo del long-press.
                if let selection, selection.day == day {
                    selectionOverlay(selection, width: width)
                }
            }
        }
        .frame(height: totalHeight)
        .frame(maxWidth: .infinity)
    }

    private func nowIndicator(width: CGFloat) -> some View {
        let minutes = CalendarDateMath.minutesFromMidnight(of: Date(), timeZone: model.timeZone)
        return HStack(spacing: 0) {
            Circle()
                .fill(RistakTheme.neg)
                .frame(width: 7, height: 7)
            Rectangle()
                .fill(RistakTheme.neg)
                .frame(height: 1.5)
        }
        .frame(width: width)
        .offset(y: yPosition(forMinute: minutes) - 3.5)
        .accessibilityHidden(true)
    }

    private func selectionOverlay(_ selection: TimelineDragSelection, width: CGFloat) -> some View {
        let range = selection.normalizedRange(minimumMinutes: model.slotStepMinutes)
        let top = yPosition(forMinute: range.lowerBound)
        let height = max(hourHeight * CGFloat(range.upperBound - range.lowerBound) / 60, 24)
        let formatters = BusinessFormatters(timeZone: model.timeZone)

        return RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
            .fill(RistakTheme.accent)
            .frame(width: max(width - 8, 0), height: height)
            .overlay(alignment: .topLeading) {
                if let start = CalendarDateMath.date(day: selection.day, minutes: range.lowerBound, timeZone: model.timeZone),
                   let end = CalendarDateMath.date(day: selection.day, minutes: range.upperBound, timeZone: model.timeZone) {
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

    // MARK: Gesto long-press + arrastre

    private func rangeGesture(for day: CalendarBusinessDay) -> some Gesture {
        LongPressGesture(minimumDuration: 0.38)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
            .onChanged { value in
                guard canCreate, case .second(true, let drag?) = value else { return }
                let anchor = snappedMinute(fromY: drag.startLocation.y)
                let current = rawMinute(fromY: drag.location.y)
                if var live = selection, live.day == day {
                    live.currentMinute = current
                    selection = live
                } else {
                    selection = TimelineDragSelection(day: day, anchorMinute: anchor, currentMinute: current)
                }
            }
            .onEnded { value in
                defer { selection = nil }
                guard canCreate, case .second(true, _) = value, let live = selection, live.day == day else { return }
                let range = live.normalizedRange(minimumMinutes: model.slotStepMinutes)
                // +gracia: la duración nunca queda menor a la del calendario.
                let duration = max(range.upperBound - range.lowerBound, model.defaultDurationMinutes)
                onCreate(AppointmentPrefill(
                    day: day,
                    startMinutes: range.lowerBound,
                    durationMinutes: duration
                ))
            }
    }

    private func rawMinute(fromY y: CGFloat) -> Int {
        let minute = Int((y / hourHeight) * 60)
        return min(max(minute, 0), 24 * 60)
    }

    private func snappedMinute(fromY y: CGFloat) -> Int {
        let step = model.slotStepMinutes
        let minute = rawMinute(fromY: y)
        return min(max((minute / step) * step, 0), 24 * 60 - step)
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
        let height = max(hourHeight * CGFloat(positioned.durationMinutes) / 60 - 2, 24)
        let statusColor = positioned.event.appointmentStatus?.displayColor ?? RistakTheme.info
        let formatters = BusinessFormatters(timeZone: model.timeZone)

        return Button {
            onEventTap(positioned.event)
        } label: {
            HStack(alignment: .top, spacing: 6) {
                Capsule()
                    .fill(statusColor)
                    .frame(width: 3)

                VStack(alignment: .leading, spacing: 1) {
                    Text(positioned.event.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    if let start = positioned.event.startDate {
                        Text(formatters.messageTime(start))
                            .font(.caption2)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(4)
            .frame(width: max(width - 2, 20), height: height, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                    .fill(RistakTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                    .strokeBorder(statusColor.opacity(0.45), lineWidth: 0.8)
            )
            .clipped()
        }
        .buttonStyle(.plain)
        .offset(
            x: 4 + CGFloat(positioned.column) * width,
            y: yPosition(forMinute: positioned.startMinute) + 1
        )
        .accessibilityLabel("\(positioned.event.title), \(positioned.event.appointmentStatus?.displayLabel ?? "")")
    }
}

// MARK: - Selección en vivo

private struct TimelineDragSelection: Equatable {
    let day: CalendarBusinessDay
    var anchorMinute: Int
    var currentMinute: Int

    /// Rango normalizado (mínimo un paso de slot).
    func normalizedRange(minimumMinutes: Int) -> ClosedRange<Int> {
        let lower = min(anchorMinute, currentMinute)
        let upper = max(anchorMinute, currentMinute)
        let clampedLower = max(0, lower)
        let clampedUpper = min(24 * 60, max(upper, clampedLower + minimumMinutes))
        return clampedLower...clampedUpper
    }
}
