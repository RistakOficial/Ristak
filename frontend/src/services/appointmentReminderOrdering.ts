import type { ReminderOffsetUnit, ReminderTimingAnchor } from './appointmentRemindersService'

type SchedulableAppointmentReminder = {
  id: string
  timingAnchor: ReminderTimingAnchor
  offsetValue: number
  offsetUnit: ReminderOffsetUnit
  position: number
  createdAt: string
}

const OFFSET_UNIT_MS: Record<ReminderOffsetUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000
}

const getOffsetDurationMs = (reminder: SchedulableAppointmentReminder): number => (
  Math.max(0, reminder.offsetValue) * OFFSET_UNIT_MS[reminder.offsetUnit]
)

const compareStableReminderOrder = (
  left: SchedulableAppointmentReminder,
  right: SchedulableAppointmentReminder
): number => (
  left.position - right.position ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.id.localeCompare(right.id)
)

/**
 * Ordena los mensajes según el momento en que ocurren dentro del ciclo de la cita.
 * Los avisos posteriores a la reserva aparecen primero y avanzan desde "al agendar".
 * Después, los recordatorios previos a la cita van del más lejano al más cercano.
 */
export function sortAppointmentRemindersByTimeline<T extends SchedulableAppointmentReminder>(
  reminders: readonly T[]
): T[] {
  return [...reminders].sort((left, right) => {
    const leftAfterBooking = left.timingAnchor === 'after_booking'
    const rightAfterBooking = right.timingAnchor === 'after_booking'

    if (leftAfterBooking !== rightAfterBooking) return leftAfterBooking ? -1 : 1

    const durationDifference = getOffsetDurationMs(left) - getOffsetDurationMs(right)
    if (durationDifference !== 0) {
      return leftAfterBooking ? durationDifference : -durationDifference
    }

    return compareStableReminderOrder(left, right)
  })
}
