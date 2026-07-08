import SwiftUI

/// Pager horizontal que SIGUE EL DEDO (User #8): un arrastre horizontal, aunque
/// sea lento, mueve el periodo actual y descubre el periodo contiguo por debajo,
/// y confirma al soltar (como un pager normal). Reemplaza la transición
/// «flick»/gradiente anterior.
///
/// Cómo funciona: se renderizan SIEMPRE tres páginas (anterior · actual ·
/// siguiente) en un `HStack` desplazado. El arrastre horizontal actualiza el
/// offset 1:1; al soltar, si cruza el umbral se anima el deslizamiento completo
/// y, al terminar, se intercambia el dato (`onCommit`) y se recentra SIN
/// animación — como la página nueva ya muestra ese contenido, el recentrado es
/// invisible. El bloqueo de eje deja intacto el scroll vertical interno
/// (timeline) y el scroll de la lista externa (mes): un arrastre vertical no
/// pagina, uno horizontal no scrollea.
struct CalendarPeriodPager<Page: View>: View {
    /// Confirmación de página: dirección `-1` (anterior) / `+1` (siguiente).
    let onCommit: (Int) -> Void
    /// Constructor de página para el offset `-1`, `0` o `+1` respecto al actual.
    @ViewBuilder var page: (Int) -> Page

    @State private var dragOffset: CGFloat = 0
    @State private var axis: Axis?
    @State private var committing = false

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            HStack(spacing: 0) {
                page(-1).frame(width: width, height: geo.size.height)
                page(0).frame(width: width, height: geo.size.height)
                page(1).frame(width: width, height: geo.size.height)
            }
            .offset(x: -width + dragOffset)
            .simultaneousGesture(dragGesture(width: width))
        }
        .clipped()
        .contentShape(Rectangle())
    }

    private func dragGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard !committing else { return }
                if axis == nil {
                    let dx = value.translation.width
                    let dy = value.translation.height
                    guard abs(dx) > 8 || abs(dy) > 8 else { return }
                    axis = abs(dx) > abs(dy) ? .horizontal : .vertical
                }
                guard axis == .horizontal else { return }
                dragOffset = value.translation.width
            }
            .onEnded { _ in
                let endedAxis = axis
                axis = nil
                guard endedAxis == .horizontal, !committing else {
                    if dragOffset != 0 {
                        withAnimation(.snappy(duration: 0.2)) { dragOffset = 0 }
                    }
                    return
                }
                let threshold = min(max(width * 0.24, 56), width * 0.5)
                if dragOffset <= -threshold {
                    slideCommit(direction: 1, target: -width)
                } else if dragOffset >= threshold {
                    slideCommit(direction: -1, target: width)
                } else {
                    withAnimation(.snappy(duration: 0.22)) { dragOffset = 0 }
                }
            }
    }

    private func slideCommit(direction: Int, target: CGFloat) {
        committing = true
        withAnimation(.snappy(duration: 0.22)) {
            dragOffset = target
        } completion: {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                onCommit(direction)
                dragOffset = 0
            }
            committing = false
        }
    }
}

// MARK: - Pager de mes

/// Rejilla mensual paginable por arrastre. Altura fija (6 semanas) para que las
/// tres páginas queden alineadas y la agenda de abajo no salte.
struct CalendarMonthPager: View {
    let model: CalendarsViewModel
    var onCreateDay: ((CalendarBusinessDay) -> Void)?

    var body: some View {
        CalendarPeriodPager(onCommit: { direction in
            model.goToMonth(offset: direction)
        }) { offset in
            CalendarMonthGridView(
                model: model,
                month: CalendarDateMath.addingMonths(offset, to: model.visibleMonth),
                onCreateDay: onCreateDay
            )
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .frame(height: CalendarMonthGridView.pagerHeight)
    }
}

// MARK: - Pager de timeline (día/semana)

/// Timeline día/semana paginable por arrastre. Solo la página central es
/// interactiva (crear/abrir citas); las contiguas son de solo lectura y sirven
/// para el descubrimiento durante el arrastre.
struct CalendarTimelinePager: View {
    let model: CalendarsViewModel
    let canCreate: Bool
    let onCreate: (AppointmentPrefill) -> Void
    let onEventTap: (CalendarAppointment) -> Void

    var body: some View {
        CalendarPeriodPager(onCommit: { direction in
            model.shiftPeriod(direction)
        }) { offset in
            CalendarTimelinePane(
                model: model,
                anchorDay: anchorDay(offset: offset),
                interactive: offset == 0,
                canCreate: canCreate && offset == 0,
                onCreate: onCreate,
                onEventTap: onEventTap
            )
        }
    }

    private func anchorDay(offset: Int) -> CalendarBusinessDay {
        let step = model.viewMode == .week ? 7 : 1
        return CalendarDateMath.adding(days: offset * step, to: model.selectedDay, timeZone: model.timeZone)
    }
}
