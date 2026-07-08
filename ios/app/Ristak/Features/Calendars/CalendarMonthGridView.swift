import SwiftUI

/// Grilla mensual con matemática de día de negocio: fila `D L M M J V S`,
/// puntos de eventos, bolita sólida de acento en el día seleccionado (regla de
/// selección de Ristak) y swipe horizontal entre meses. Tap = seleccionar;
/// doble-tap (≤320 ms) = Nueva cita en ese día (paridad RN `handleDayPress`).
struct CalendarMonthGridView: View {
    let model: CalendarsViewModel
    /// Mes concreto a renderizar (el pager le pasa el mes ±1). Por defecto el
    /// mes visible del modelo.
    var month: CalendarBusinessDay
    /// Doble-tap en un día (nil = sin permiso de escritura).
    var onCreateDay: ((CalendarBusinessDay) -> Void)?

    @State private var lastTap: (day: CalendarBusinessDay, at: Date)?

    /// Altura reservada por el pager: fila de letras + 6 semanas (celda 40 pt).
    static let pagerHeight: CGFloat = 20 + (6 * 40)

    private var weeks: [[CalendarDateMath.GridDay]] {
        CalendarDateMath.monthGrid(
            year: month.year,
            month: month.month,
            timeZone: model.timeZone
        )
    }

    var body: some View {
        // Filas compactas (sin gap vertical entre semanas) para que la agenda
        // del día quede visible sin scrollear (paridad RN: celdas de 40 pt).
        // El swipe entre meses lo maneja `CalendarPeriodPager` (User #8).
        VStack(spacing: 0) {
            weekdayRow
                .padding(.bottom, 2)

            ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 0) {
                    ForEach(week) { cell in
                        dayCell(cell)
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .sensoryFeedback(.selection, trigger: model.selectedDay)
        .accessibilityElement(children: .contain)
    }

    // MARK: - Filas

    private var weekdayRow: some View {
        HStack(spacing: 0) {
            ForEach(Array(CalendarDateMath.weekdayLetters.enumerated()), id: \.offset) { _, letter in
                Text(letter)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(RistakTheme.textDim)
                    .frame(maxWidth: .infinity)
            }
        }
        .accessibilityHidden(true)
    }

    private func dayCell(_ cell: CalendarDateMath.GridDay) -> some View {
        let isSelected = cell.day == model.selectedDay
        let isToday = cell.day == model.today
        let eventCount = model.events(on: cell.day).count

        return Button {
            handleTap(on: cell.day)
        } label: {
            ZStack {
                Text("\(cell.day.day)")
                    .font(.callout.weight(isSelected || isToday ? .semibold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(numberColor(cell, isSelected: isSelected, isToday: isToday))

                if eventCount > 0 {
                    // Puntos de evento superpuestos al pie del número (dentro
                    // del círculo) para no ocupar altura extra — así la fila es
                    // compacta y la agenda cabe debajo (paridad RN).
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        dotsRow(count: eventCount, isSelected: isSelected)
                    }
                    .padding(.bottom, 3)
                }
            }
            .frame(width: 34, height: 34)
            .background {
                if isSelected {
                    // Regla de selección: relleno sólido de acento,
                    // plano, sin glass ni contorno.
                    Circle().fill(RistakTheme.accent)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel(for: cell.day, eventCount: eventCount))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private func dotsRow(count: Int, isSelected: Bool) -> some View {
        HStack(spacing: 3) {
            ForEach(0..<min(count, 3), id: \.self) { _ in
                // Puntos superpuestos al pie del número: acento sobre fondo
                // plano; blanco cuando el día está seleccionado (círculo de
                // acento) para que sigan visibles (paridad RN `calendarDayMarker`).
                Circle()
                    .fill(isSelected ? RistakTheme.onAccent : RistakTheme.accent)
                    .frame(width: 4, height: 4)
            }
        }
        .frame(height: 5)
    }

    private func numberColor(_ cell: CalendarDateMath.GridDay, isSelected: Bool, isToday: Bool) -> Color {
        if isSelected { return RistakTheme.onAccent }
        if isToday { return RistakTheme.accent }
        return cell.inMonth ? RistakTheme.textPrimary : RistakTheme.textMute
    }

    private func accessibilityLabel(for day: CalendarBusinessDay, eventCount: Int) -> String {
        let base = CalendarDateMath.dayHeader(day, timeZone: model.timeZone)
        if eventCount == 0 { return base }
        return "\(base), \(eventCount) \(eventCount == 1 ? "cita" : "citas")"
    }

    // MARK: - Gestos

    /// Tap = seleccionar; segundo tap en el MISMO día dentro de 320 ms abre
    /// Nueva cita (evita el retraso del doble-tap del sistema).
    private func handleTap(on day: CalendarBusinessDay) {
        let now = Date()
        if let last = lastTap, last.day == day, now.timeIntervalSince(last.at) <= 0.32 {
            lastTap = nil
            onCreateDay?(day)
            return
        }
        lastTap = (day, now)
        withAnimation(.snappy(duration: 0.18)) {
            model.select(day: day)
        }
    }
}

// MARK: - Vista Año (rejilla de 12 meses)

/// Rejilla de 12 mini-calendarios del año visible. Tap en un mes baja a la
/// vista Mes (paridad RN `CalendarYearOverview`). Swipe horizontal cambia de año.
struct CalendarYearGridView: View {
    let model: CalendarsViewModel

    private var year: Int { model.visibleMonth.year }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(1...12, id: \.self) { month in
                monthCell(month: month)
            }
        }
        .contentShape(Rectangle())
        .gesture(periodSwipeGesture)
        .sensoryFeedback(.selection, trigger: model.visibleMonth)
    }

    private func monthCell(month: Int) -> some View {
        let containsSelected = model.selectedDay.year == year && model.selectedDay.month == month
        let containsToday = model.today.year == year && model.today.month == month
        let weeks = CalendarDateMath.monthGrid(year: year, month: month, timeZone: model.timeZone)

        return Button {
            withAnimation(.snappy) { model.selectMonth(monthIndex: month - 1) }
        } label: {
            VStack(spacing: 6) {
                Text(CalendarDateMath.monthShortTitle(month: month))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(containsSelected || containsToday ? RistakTheme.accent : RistakTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                miniMonth(weeks: weeks)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 8)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(containsSelected ? RistakTheme.accentSoft : RistakTheme.controlRest)
            )
            .overlay(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .strokeBorder(containsSelected ? RistakTheme.accent.opacity(0.6) : Color.clear, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(CalendarDateMath.monthShortTitle(month: month)) \(year)")
        .accessibilityAddTraits(containsSelected ? .isSelected : [])
    }

    private func miniMonth(weeks: [[CalendarDateMath.GridDay]]) -> some View {
        VStack(spacing: 2) {
            ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 1) {
                    ForEach(week) { cell in
                        miniDay(cell)
                    }
                }
            }
        }
    }

    private func miniDay(_ cell: CalendarDateMath.GridDay) -> some View {
        let inMonth = cell.inMonth
        let isToday = cell.day == model.today
        let hasEvents = inMonth && model.hasEvents(on: cell.day)
        return Text("\(cell.day.day)")
            .font(.system(size: 8, weight: hasEvents ? .bold : .regular))
            .monospacedDigit()
            .foregroundStyle(
                !inMonth ? RistakTheme.textMute
                : isToday ? RistakTheme.accent
                : hasEvents ? RistakTheme.accent
                : RistakTheme.textDim
            )
            .frame(maxWidth: .infinity, minHeight: 11)
    }

    private var periodSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                if value.translation.width <= -56 {
                    withAnimation(.snappy) { model.shiftPeriod(1) }
                } else if value.translation.width >= 56 {
                    withAnimation(.snappy) { model.shiftPeriod(-1) }
                }
            }
    }
}

// MARK: - Vista Años (rejilla de la década)

/// Rejilla de años de la década visible. Tap en un año baja a la vista Año
/// (paridad RN `CalendarYearsOverview`). El año seleccionado usa relleno sólido
/// de acento (regla de selección de Ristak). Swipe horizontal cambia de década.
struct CalendarYearsGridView: View {
    let model: CalendarsViewModel

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(model.yearsGrid, id: \.self) { year in
                yearCell(year)
            }
        }
        .contentShape(Rectangle())
        .gesture(periodSwipeGesture)
        .sensoryFeedback(.selection, trigger: model.visibleMonth)
    }

    private func yearCell(_ year: Int) -> some View {
        let isSelected = year == model.selectedDay.year
        let isCurrent = year == model.today.year

        return Button {
            withAnimation(.snappy) { model.selectYear(year) }
        } label: {
            Text(String(year))
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(isSelected ? RistakTheme.onAccent : (isCurrent ? RistakTheme.accent : RistakTheme.textPrimary))
                .frame(maxWidth: .infinity)
                .frame(height: 64)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                        .fill(isSelected ? AnyShapeStyle(RistakTheme.accent) : AnyShapeStyle(RistakTheme.controlRest))
                )
                .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(String(year))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var periodSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                if value.translation.width <= -56 {
                    withAnimation(.snappy) { model.shiftPeriod(1) }
                } else if value.translation.width >= 56 {
                    withAnimation(.snappy) { model.shiftPeriod(-1) }
                }
            }
    }
}

// MARK: - Agenda del día seleccionado

/// Lista de citas del día seleccionado (debajo de la grilla en iPhone, panel
/// derecho en iPad). Vacío: icono de calendario + «No hay citas este día».
struct CalendarDayAgendaView: View {
    let model: CalendarsViewModel
    let onEventTap: (CalendarAppointment) -> Void

    private var events: [CalendarAppointment] {
        model.events(on: model.selectedDay)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
            header

            if events.isEmpty {
                RistakEmptyState(
                    icon: "calendar",
                    title: "No hay citas este día",
                    message: "Cambia de calendario o crea una cita nueva."
                )
                .frame(minHeight: 220)
            } else {
                VStack(spacing: RistakTheme.Spacing.xs) {
                    ForEach(events) { event in
                        AppointmentCardView(
                            event: event,
                            timeZone: model.timeZone
                        ) {
                            onEventTap(event)
                        }
                    }
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(CalendarDateMath.dayHeader(model.selectedDay, timeZone: model.timeZone))
                .font(.headline)
                .foregroundStyle(RistakTheme.textPrimary)

            Spacer()

            Text(events.isEmpty ? "Sin citas" : "\(events.count) \(events.count == 1 ? "cita" : "citas")")
                .font(.subheadline)
                .foregroundStyle(RistakTheme.textDim)
        }
    }
}

// MARK: - Card de cita

/// Tarjeta de cita de la agenda: barra de color del estado, hora, título y
/// contacto (campo suave, borde tenue — paridad visual RN).
struct AppointmentCardView: View {
    let event: CalendarAppointment
    let timeZone: TimeZone
    var onTap: () -> Void = {}

    private var formatters: BusinessFormatters {
        BusinessFormatters(timeZone: timeZone)
    }

    private var timeLabel: String {
        guard let start = event.startDate else { return "Sin hora" }
        let startLabel = formatters.messageTime(start)
        guard let end = event.endDate, end > start else { return startLabel }
        return "\(startLabel) – \(formatters.messageTime(end))"
    }

    private var statusColor: Color {
        event.appointmentStatus?.displayColor ?? RistakTheme.info
    }

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .center, spacing: RistakTheme.Spacing.sm) {
                Capsule()
                    .fill(statusColor)
                    .frame(width: 4)
                    .frame(minHeight: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(event.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(RistakTheme.textPrimary)
                        .lineLimit(1)

                    if !event.contactName.isEmpty {
                        Text(event.contactName)
                            .font(.footnote)
                            .foregroundStyle(RistakTheme.textDim)
                            .lineLimit(1)
                    }

                    Text(timeLabel)
                        .font(.footnote)
                        .foregroundStyle(RistakTheme.textDim)
                }

                Spacer(minLength: RistakTheme.Spacing.xs)

                if let status = event.appointmentStatus {
                    TagPillView(text: status.displayLabel, dotColor: status.displayColor)
                }
            }
            .padding(RistakTheme.Spacing.sm)
            .background(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .fill(RistakTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous)
                    .strokeBorder(RistakTheme.border.opacity(0.6), lineWidth: 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: RistakTheme.Radius.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}
