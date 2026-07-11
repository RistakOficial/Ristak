import type { JourneyEvent } from '@/services/contactsService'
import { formatChatDayLabel, formatChatMessageTime } from './chatTimestamps'
import { normalizeCurrencyCode } from './accountLocale'
import { parseSortableDateValue } from './dateSort'
import { formatCurrency } from './format'

export type ChatActivityMarker = {
  id: string
  kind: 'payment' | 'appointment'
  date: string
  title: string
  subtitle: string
  amountLabel?: string
}

const SUCCESS_PAYMENT_STATUSES = new Set([
  'succeeded',
  'paid',
  'completed',
  'complete',
  'fulfilled',
  'success'
])

function readableValue(value: unknown) {
  return String(value ?? '').trim()
}

function normalizeStatus(value: unknown) {
  return readableValue(value).toLowerCase().replace(/[\s-]+/g, '_')
}

function joinDetails(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean).join(' · ')
}

function formatAppointmentSchedule(value: unknown, timezone: string) {
  const rawValue = readableValue(value)
  if (!rawValue) return ''
  return joinDetails([
    formatChatDayLabel(rawValue, timezone),
    formatChatMessageTime(rawValue, timezone)
  ])
}

export function isChatActivityEvent(event: JourneyEvent) {
  return event.type === 'payment' || event.type === 'appointment' || event.type === 'appointment_confirmation'
}

/**
 * Construye los mismos marcadores inline que usa el chat móvil a partir del
 * journey completo. Los eventos de pago/cita no se convierten en burbujas.
 */
export function buildChatActivityMarkers(
  contactId: string,
  events: JourneyEvent[],
  timezone: string,
  accountCurrency: string
): ChatActivityMarker[] {
  const markers = events
    .map((event, index): ChatActivityMarker | null => {
      const data = event.data || {}

      if (event.type === 'payment') {
        const amount = Number(data.amount || data.total || data.value || 0)
        const status = normalizeStatus(data.status)
        if (amount <= 0 || (status && !SUCCESS_PAYMENT_STATUSES.has(status))) return null

        const currency = normalizeCurrencyCode(data.currency, accountCurrency)
        const concept = readableValue(data.title || data.description || data.concept || data.type) || 'Cobro registrado'
        return {
          id: readableValue(data.id || data.transactionId) || `${contactId}-payment-marker-${event.date}-${index}`,
          kind: 'payment',
          date: event.date,
          title: 'Pago completado',
          subtitle: concept,
          amountLabel: formatCurrency(amount, currency)
        }
      }

      if (event.type === 'appointment' || event.type === 'appointment_confirmation') {
        const appointmentTitle = readableValue(data.title || data.name) || 'Cita'
        const scheduleLabel = formatAppointmentSchedule(data.start_time || data.startTime || data.date || event.date, timezone)
        return {
          id: readableValue(data.id || data.appointment_id) || `${contactId}-appointment-marker-${event.date}-${index}`,
          kind: 'appointment',
          date: event.date,
          title: event.type === 'appointment_confirmation' ? 'Cita confirmada' : 'Cita agendada',
          subtitle: joinDetails([appointmentTitle, scheduleLabel])
        }
      }

      return null
    })
    .filter((marker): marker is ChatActivityMarker => Boolean(marker))

  return mergeChatActivityMarkers(markers)
}

export function mergeChatActivityMarkers(...groups: ChatActivityMarker[][]) {
  const merged: ChatActivityMarker[] = []

  groups.flat().forEach((marker) => {
    const markerTime = parseSortableDateValue(marker.date)
    const duplicate = merged.some((item) => {
      if (item.id === marker.id) return true
      if (item.kind !== marker.kind) return false
      const itemTime = parseSortableDateValue(item.date)
      if (Math.abs(itemTime - markerTime) >= 120000) return false
      if (marker.kind === 'payment') return item.amountLabel === marker.amountLabel
      return normalizeStatus(item.subtitle) === normalizeStatus(marker.subtitle)
    })

    if (!duplicate) merged.push(marker)
  })

  return merged.sort((left, right) => parseSortableDateValue(left.date) - parseSortableDateValue(right.date))
}
