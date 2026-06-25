import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getPaymentSettings } from './paymentSettingsService.js'
import { buildDefaultMessageTemplateSendComponents } from './messageTemplatesService.js'
import { sendWhatsAppApiTemplateMessage } from './whatsappApiService.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const DEFAULT_LANGUAGE = 'es_MX'

const CLOSED_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'refunded',
  'void',
  'deleted',
  'cancelled',
  'canceled',
  'failed'
])

const PAYMENT_AUTOMATION_TEMPLATES = {
  reminder: {
    enabledKey: 'remindersEnabled',
    channelKey: 'reminderChannel',
    qrKey: 'reminderQrFallbackEnabled',
    templateIdKey: 'reminderTemplateId',
    templateNameKey: 'reminderTemplateName',
    templateLanguageKey: 'reminderTemplateLanguage',
    defaultTemplateName: 'recordatorio_pago_pendiente',
    label: 'recordatorio antes del pago'
  },
  receipt: {
    enabledKey: 'receiptDeliveryEnabled',
    channelKey: 'receiptDeliveryChannel',
    qrKey: 'receiptQrFallbackEnabled',
    templateIdKey: 'receiptTemplateId',
    templateNameKey: 'receiptTemplateName',
    templateLanguageKey: 'receiptTemplateLanguage',
    defaultTemplateName: 'comprobante_pago_recibido',
    label: 'comprobante despues del pago'
  },
  failed: {
    enabledKey: 'failedPaymentEnabled',
    channelKey: 'failedPaymentChannel',
    qrKey: 'failedPaymentQrFallbackEnabled',
    templateIdKey: 'failedPaymentTemplateId',
    templateNameKey: 'failedPaymentTemplateName',
    templateLanguageKey: 'failedPaymentTemplateLanguage',
    defaultTemplateName: 'pago_fallido_reintento',
    label: 'cobro fallido'
  }
}

function cleanString(value, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function channelUsesWhatsApp(channel = '') {
  const normalized = cleanString(channel, 40).toLowerCase()
  return normalized === 'whatsapp' || normalized === 'both'
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return null
  }
}

function parseDateMs(value) {
  const text = cleanString(value, 80)
  if (!text) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)
    ? text.replace(' ', 'T')
    : text
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function startOfLocalDayMs(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function appendReceiptQuery(url = '') {
  const cleanUrl = cleanString(url, 2000)
  if (!cleanUrl) return ''
  return cleanUrl.includes('?') ? `${cleanUrl}&receipt=1` : `${cleanUrl}?receipt=1`
}

function getUrlOrigin(url = '') {
  try {
    const parsed = new URL(cleanString(url, 2000))
    return parsed.origin
  } catch {
    return ''
  }
}

function normalizeBaseUrl(value = '') {
  const cleaned = cleanString(value, 2000).replace(/\/+$/, '')
  return /^https?:\/\//i.test(cleaned) ? cleaned : ''
}

function resolvePublicBaseUrl(payment = {}, explicitBaseUrl = '') {
  return normalizeBaseUrl(explicitBaseUrl)
    || getUrlOrigin(payment.payment_url)
    || normalizeBaseUrl(process.env.PUBLIC_URL)
    || normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL)
}

function buildPaymentUrl(payment = {}, explicitBaseUrl = '') {
  const rawUrl = cleanString(payment.payment_url || payment.paymentUrl, 2000)
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl

  const publicBaseUrl = resolvePublicBaseUrl(payment, explicitBaseUrl)
  if (publicBaseUrl && rawUrl.startsWith('/')) return `${publicBaseUrl}${rawUrl}`

  const publicPaymentId = cleanString(payment.public_payment_id || payment.publicPaymentId, 200)
  if (publicBaseUrl && publicPaymentId) return `${publicBaseUrl}/pay/${encodeURIComponent(publicPaymentId)}`

  return rawUrl
}

function formatPaymentAmount(amount, currency = 'MXN') {
  const parsed = Number(amount)
  if (!Number.isFinite(parsed)) return ''
  const cleanCurrency = cleanString(currency, 8).toUpperCase() || 'MXN'
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: cleanCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(parsed)
  } catch {
    return `${parsed.toFixed(2)} ${cleanCurrency}`
  }
}

function formatPaymentDate(value) {
  const parsed = parseDateMs(value)
  if (!parsed) return ''
  try {
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'long' }).format(new Date(parsed))
  } catch {
    return cleanString(value, 80)
  }
}

function contactFromPaymentRow(payment = {}) {
  const fullName = cleanString(
    payment.contact_full_name ||
    payment.contactName ||
    payment.contact_name ||
    payment.full_name
  )
  const firstName = cleanString(payment.contact_first_name || payment.contactFirstName || payment.first_name)
    || fullName.split(/\s+/).filter(Boolean)[0]
    || ''
  const lastName = cleanString(payment.contact_last_name || payment.contactLastName || payment.last_name)

  return {
    id: cleanString(payment.contact_id || payment.contactId),
    firstName,
    lastName,
    fullName,
    phone: cleanString(payment.contact_phone || payment.contactPhone || payment.phone, 120),
    email: cleanString(payment.contact_email || payment.contactEmail || payment.email, 200)
  }
}

async function loadPaymentWithContact(paymentInput) {
  const input = typeof paymentInput === 'object' && paymentInput !== null ? paymentInput : {}
  const paymentId = cleanString(input.id || input.payment_id || input.paymentId || paymentInput, 200)
  const publicPaymentId = cleanString(input.public_payment_id || input.publicPaymentId, 200)

  if (!paymentId && !publicPaymentId) return input

  const whereColumn = paymentId ? 'p.id' : 'p.public_payment_id'
  const whereValue = paymentId || publicPaymentId
  const row = await db.get(`
    SELECT
      p.*,
      c.first_name AS contact_first_name,
      c.last_name AS contact_last_name,
      c.full_name AS contact_full_name,
      c.phone AS contact_phone,
      c.email AS contact_email
    FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE ${whereColumn} = ?
    LIMIT 1
  `, [whereValue])

  return {
    ...input,
    ...(row || {})
  }
}

function buildPaymentVariableMap(payment = {}, { publicBaseUrl = '' } = {}) {
  const baseUrl = resolvePublicBaseUrl(payment, publicBaseUrl)
  const paymentUrl = buildPaymentUrl(payment, baseUrl)
  const publicPaymentId = cleanString(payment.public_payment_id || payment.publicPaymentId, 200)
  const receiptUrl = appendReceiptQuery(paymentUrl)
  const contact = contactFromPaymentRow(payment)
  const currency = cleanString(payment.currency, 8).toUpperCase() || 'MXN'
  const product = cleanString(payment.title || payment.description || payment.product || 'Pago', 240)

  return {
    'contact.first_name': contact.firstName,
    'contact.last_name': contact.lastName,
    'contact.full_name': contact.fullName,
    'contact.name': contact.fullName || contact.firstName,
    'contact.phone': contact.phone,
    'contact.email': contact.email,
    'payment.id': cleanString(payment.id, 200),
    'payment.public_id': publicPaymentId,
    'payment.product': product,
    'payment.amount': formatPaymentAmount(payment.amount, currency),
    'payment.currency': currency,
    'payment.status': cleanString(payment.status, 80),
    'payment.method': cleanString(payment.payment_method || payment.paymentMethod, 120),
    'payment.provider': cleanString(payment.payment_provider || payment.paymentProvider, 120),
    'payment.receipt': cleanString(payment.reference || payment.invoice_number || payment.ghl_invoice_id || payment.id, 240),
    'payment.invoice_number': cleanString(payment.invoice_number || payment.invoiceNumber, 120),
    'payment.date': formatPaymentDate(payment.paid_at || payment.date || payment.created_at),
    'payment.url': paymentUrl,
    'payment.receipt_url': receiptUrl,
    'payment.receipt_path': publicPaymentId ? `${publicPaymentId}?receipt=1` : ''
  }
}

function getAutomationDefinition(type, settings = {}) {
  const definition = PAYMENT_AUTOMATION_TEMPLATES[type]
  if (!definition) return null

  const automations = settings.automations || {}
  return {
    ...definition,
    enabled: automations[definition.enabledKey] !== false,
    channel: cleanString(automations[definition.channelKey] || ''),
    allowQrFallback: automations[definition.qrKey] === true,
    templateId: cleanString(automations[definition.templateIdKey], 180),
    templateName: cleanString(automations[definition.templateNameKey], 180) || definition.defaultTemplateName,
    language: cleanString(automations[definition.templateLanguageKey], 20) || DEFAULT_LANGUAGE
  }
}

function getDispatchId(paymentId, automationType, channel = 'whatsapp') {
  return `payment_auto_${automationType}_${channel}_${cleanString(paymentId, 160).replace(/[^a-zA-Z0-9_-]+/g, '_')}`
}

async function claimDispatch({ paymentId, automationType, templateId, templateName }) {
  const id = getDispatchId(paymentId, automationType)
  const result = await db.run(`
    INSERT INTO payment_automation_dispatches (
      id, payment_id, automation_type, channel, status, template_id, template_name, updated_at
    ) VALUES (?, ?, ?, 'whatsapp', 'sending', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `, [id, paymentId, automationType, templateId || null, templateName || null])

  if (Number(result?.changes || 0) > 0) return { claimed: true, id }

  const existing = await db.get(
    'SELECT id, status FROM payment_automation_dispatches WHERE id = ? LIMIT 1',
    [id]
  )

  if (existing?.status === 'failed') {
    await db.run(`
      UPDATE payment_automation_dispatches
      SET status = 'sending',
          template_id = ?,
          template_name = ?,
          error_message = NULL,
          raw_response_json = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [templateId || null, templateName || null, id])
    return { claimed: true, id }
  }

  return {
    claimed: false,
    id,
    reason: existing?.status === 'sent' ? 'already_sent' : 'already_claimed'
  }
}

async function markDispatchSent(id, response) {
  await db.run(`
    UPDATE payment_automation_dispatches
    SET status = 'sent',
        error_message = NULL,
        raw_response_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [safeJson(response), id])
}

async function markDispatchFailed(id, error) {
  await db.run(`
    UPDATE payment_automation_dispatches
    SET status = 'failed',
        error_message = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [cleanString(error?.message || error, 1000), id])
}

function shouldRequirePaymentLink(type) {
  return type === 'reminder' || type === 'receipt' || type === 'failed'
}

export async function sendPaymentAutomationMessage(type, paymentInput, options = {}) {
  const settings = options.settings || await getPaymentSettings()
  const definition = getAutomationDefinition(type, settings)
  if (!definition) return { sent: false, skipped: true, reason: 'unknown_type' }
  if (!definition.enabled) return { sent: false, skipped: true, reason: 'disabled' }
  if (!channelUsesWhatsApp(definition.channel)) return { sent: false, skipped: true, reason: 'channel_not_whatsapp' }

  const payment = await loadPaymentWithContact(paymentInput)
  const paymentId = cleanString(payment.id, 200)
  if (!paymentId) return { sent: false, skipped: true, reason: 'missing_payment' }

  const contact = contactFromPaymentRow(payment)
  if (!contact.phone) return { sent: false, skipped: true, reason: 'missing_phone' }

  const publicBaseUrl = resolvePublicBaseUrl(payment, options.publicBaseUrl)
  const extraVariables = buildPaymentVariableMap(payment, { publicBaseUrl })
  const hasPaymentTarget = Boolean(extraVariables['payment.public_id'] || /^https?:\/\//i.test(extraVariables['payment.url']))
  if (shouldRequirePaymentLink(type) && !hasPaymentTarget) {
    return { sent: false, skipped: true, reason: 'missing_payment_url' }
  }

  const claim = await claimDispatch({
    paymentId,
    automationType: type,
    templateId: definition.templateId,
    templateName: definition.templateName
  })
  if (!claim.claimed) return { sent: false, skipped: true, reason: claim.reason, dispatchId: claim.id }

  try {
    const components = await buildDefaultMessageTemplateSendComponents({
      templateId: definition.templateId,
      templateName: definition.templateName,
      language: definition.language,
      variableOptions: {
        contactId: contact.id,
        phone: contact.phone,
        publicBaseUrl,
        extraVariables
      }
    })

    const response = await sendWhatsAppApiTemplateMessage({
      to: contact.phone,
      templateId: definition.templateId || undefined,
      templateName: definition.templateName,
      language: definition.language,
      ...(components.length ? { components } : {}),
      contactId: contact.id,
      publicBaseUrl,
      extraVariables,
      externalId: `payment:${type}:${paymentId}`,
      allowQrFallback: definition.allowQrFallback
    })

    await markDispatchSent(claim.id, response)
    return {
      sent: true,
      type,
      dispatchId: claim.id,
      templateName: definition.templateName,
      response
    }
  } catch (error) {
    await markDispatchFailed(claim.id, error)
    logger.warn(`[Pagos] No se pudo enviar ${definition.label} ${paymentId}: ${error.message}`)
    return {
      sent: false,
      type,
      dispatchId: claim.id,
      templateName: definition.templateName,
      error: error.message
    }
  }
}

export function queuePaymentAutomationMessage(type, paymentInput, options = {}) {
  Promise.resolve()
    .then(() => sendPaymentAutomationMessage(type, paymentInput, options))
    .catch((error) => {
      logger.warn(`[Pagos] Error no manejado enviando automatizacion ${type}: ${error.message}`)
    })
}

async function getReminderCandidates(settings, now, limit, paymentIds = []) {
  const daysBefore = Math.max(1, Number(settings.automations?.reminderDaysBefore || 3))
  const todayStart = startOfLocalDayMs(now)
  const targetEnd = todayStart + (daysBefore * DAY_MS) + DAY_MS - 1
  const closed = [...CLOSED_PAYMENT_STATUSES]
  const placeholders = closed.map(() => '?').join(', ')
  const cleanPaymentIds = paymentIds.map((id) => cleanString(id, 200)).filter(Boolean)
  const paymentIdFilter = cleanPaymentIds.length
    ? `AND id IN (${cleanPaymentIds.map(() => '?').join(', ')})`
    : ''
  // PAY2-007: no enviar recordatorios para links sin due_date.
  // Excluimos NULL y cadena vacia a nivel SQL; el filtro JS valida que sea una fecha parseable.
  const rows = await db.all(`
    SELECT *
    FROM payments
    WHERE due_date IS NOT NULL
      AND TRIM(due_date) != ''
      AND LOWER(COALESCE(status, 'pending')) NOT IN (${placeholders})
      ${paymentIdFilter}
    ORDER BY due_date ASC
    LIMIT ?
  `, [...closed, ...cleanPaymentIds, Math.max(limit * 3, limit)])

  return rows.filter((row) => {
    // PAY2-007: parseDateMs devuelve null si due_date es invalida/vacia => se excluye (no se inventa fecha)
    const dueMs = parseDateMs(row.due_date)
    return dueMs !== null && dueMs >= todayStart && dueMs <= targetEnd
  }).slice(0, limit)
}

async function getFailedCandidates(settings, now, limit, paymentIds = []) {
  const delayHours = Math.max(1, Number(settings.automations?.failedPaymentDelayHours || 2))
  const readyBefore = now.getTime() - (delayHours * HOUR_MS)
  const cleanPaymentIds = paymentIds.map((id) => cleanString(id, 200)).filter(Boolean)
  const paymentIdFilter = cleanPaymentIds.length
    ? `AND id IN (${cleanPaymentIds.map(() => '?').join(', ')})`
    : ''
  const rows = await db.all(`
    SELECT *
    FROM payments
    WHERE LOWER(COALESCE(status, '')) = 'failed'
      ${paymentIdFilter}
    ORDER BY updated_at ASC
    LIMIT ?
  `, [...cleanPaymentIds, Math.max(limit * 3, limit)])

  return rows.filter((row) => {
    const failedAtMs = parseDateMs(row.updated_at || row.date || row.created_at)
    return failedAtMs !== null && failedAtMs <= readyBefore
  }).slice(0, limit)
}

export async function processDuePaymentAutomations({ now = new Date(), limit = 100, paymentIds = [] } = {}) {
  const settings = await getPaymentSettings()
  const results = []

  const reminderDefinition = getAutomationDefinition('reminder', settings)
  if (reminderDefinition?.enabled && channelUsesWhatsApp(reminderDefinition.channel)) {
    const reminders = await getReminderCandidates(settings, now, limit, paymentIds)
    for (const payment of reminders) {
      results.push(await sendPaymentAutomationMessage('reminder', payment, { settings }))
    }
  }

  const failedDefinition = getAutomationDefinition('failed', settings)
  if (failedDefinition?.enabled && channelUsesWhatsApp(failedDefinition.channel)) {
    const failed = await getFailedCandidates(settings, now, limit, paymentIds)
    for (const payment of failed) {
      results.push(await sendPaymentAutomationMessage('failed', payment, { settings }))
    }
  }

  return results
}
