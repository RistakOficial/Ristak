import crypto from 'crypto'
import webPush from 'web-push'
import { db, getAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'

const VAPID_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || ''
const VAPID_SUBJECT = process.env.WEB_PUSH_SUBJECT || process.env.VAPID_SUBJECT || 'mailto:soporte@ristak.com'

const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)

if (pushConfigured) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
} else {
  logger.warn('[Push] Web Push sin llaves VAPID; las suscripciones se guardan, pero no se enviarán avisos.')
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeCalendarIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function getSubscriptionId(endpoint = '') {
  return `push_${crypto.createHash('sha256').update(endpoint).digest('hex')}`
}

function formatAppointmentTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date)
}

async function getGlobalCalendarPushConfig() {
  const enabledRaw = await getAppConfig('calendar_push_notifications_enabled').catch(() => null)
  const calendarIdsRaw = await getAppConfig('calendar_push_notification_calendar_ids').catch(() => null)
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(enabledRaw || '').toLowerCase())
  const calendarIds = normalizeCalendarIds(
    Array.isArray(calendarIdsRaw)
      ? calendarIdsRaw
      : safeJsonParse(calendarIdsRaw || '[]', [])
  )

  return { enabled, calendarIds }
}

export function getPublicPushConfig() {
  return {
    configured: pushConfigured,
    publicKey: pushConfigured ? VAPID_PUBLIC_KEY : ''
  }
}

export async function savePushSubscription({
  subscription,
  userId = null,
  calendarIds = [],
  userAgent = ''
}) {
  const endpoint = String(subscription?.endpoint || '').trim()
  if (!endpoint) {
    throw new Error('Suscripción inválida')
  }

  const id = getSubscriptionId(endpoint)
  const normalizedCalendarIds = normalizeCalendarIds(calendarIds)

  await db.run(`
    INSERT INTO push_subscriptions (
      id, user_id, endpoint, subscription_json, calendar_ids_json, enabled, user_agent, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, push_subscriptions.user_id),
      subscription_json = excluded.subscription_json,
      calendar_ids_json = excluded.calendar_ids_json,
      enabled = 1,
      user_agent = excluded.user_agent,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    userId,
    endpoint,
    JSON.stringify(subscription),
    JSON.stringify(normalizedCalendarIds),
    userAgent
  ])

  return {
    id,
    enabled: true,
    calendarIds: normalizedCalendarIds
  }
}

export async function disablePushSubscription(endpoint = '') {
  const normalizedEndpoint = String(endpoint || '').trim()
  if (!normalizedEndpoint) return

  await db.run(
    'UPDATE push_subscriptions SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE endpoint = ?',
    [normalizedEndpoint]
  )
}

async function getSubscriptionsForCalendar(calendarId) {
  const rows = await db.all(`
    SELECT id, endpoint, subscription_json, calendar_ids_json
    FROM push_subscriptions
    WHERE enabled = 1
  `)

  return rows.filter((row) => {
    const calendarIds = normalizeCalendarIds(safeJsonParse(row.calendar_ids_json || '[]', []))
    return calendarIds.length === 0 || calendarIds.includes(calendarId)
  })
}

async function markSubscriptionError(row, error) {
  const statusCode = error?.statusCode || error?.status
  const shouldDisable = statusCode === 404 || statusCode === 410

  await db.run(
    `UPDATE push_subscriptions
     SET enabled = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [shouldDisable ? 0 : 1, error?.message || 'Error enviando aviso', row.id]
  ).catch(() => {})
}

export async function sendCalendarAppointmentNotification(appointment = {}, options = {}) {
  if (!pushConfigured) return { sent: 0, skipped: true, reason: 'not_configured' }

  const calendarId = String(options.calendarId || appointment.calendarId || appointment.calendar_id || '').trim()
  if (!calendarId) return { sent: 0, skipped: true, reason: 'missing_calendar' }

  const config = await getGlobalCalendarPushConfig()
  if (!config.enabled) return { sent: 0, skipped: true, reason: 'disabled' }
  if (config.calendarIds.length > 0 && !config.calendarIds.includes(calendarId)) {
    return { sent: 0, skipped: true, reason: 'calendar_filtered' }
  }

  const subscriptions = await getSubscriptionsForCalendar(calendarId)
  if (subscriptions.length === 0) return { sent: 0, skipped: true, reason: 'no_subscriptions' }

  const appointmentTitle = String(appointment.title || appointment.name || 'Nueva cita').trim()
  const calendarName = String(options.calendarName || appointment.calendarName || 'Calendario').trim()
  const timeLabel = formatAppointmentTime(appointment.startTime || appointment.start_time)
  const body = timeLabel
    ? `${appointmentTitle} · ${timeLabel}`
    : appointmentTitle
  const payload = JSON.stringify({
    title: 'Nueva cita agendada',
    body: `${calendarName}: ${body}`,
    tag: `calendar-${calendarId}`,
    url: `/phone/calendar?open=appointment&id=${encodeURIComponent(appointment.id || '')}`
  })

  let sent = 0
  await Promise.all(subscriptions.map(async (row) => {
    const subscription = safeJsonParse(row.subscription_json, null)
    if (!subscription) return

    try {
      await webPush.sendNotification(subscription, payload)
      sent += 1
    } catch (error) {
      logger.warn(`[Push] No se pudo enviar aviso a ${row.id}: ${error.message}`)
      await markSubscriptionError(row, error)
    }
  }))

  return { sent, skipped: false }
}
