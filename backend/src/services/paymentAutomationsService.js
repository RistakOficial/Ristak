import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { DateTime } from 'luxon'
import {
  DEFAULT_TIMEZONE,
  getAccountTimezone,
  resolveTimezone
} from '../utils/dateUtils.js'
import { getPaymentSettings } from './paymentSettingsService.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import {
  buildDefaultMessageTemplateFallbackText,
  buildDefaultMessageTemplateSendComponents
} from './messageTemplatesService.js'
import {
  sendWhatsAppApiTemplateMessage,
  sendWhatsAppApiTextMessage
} from './whatsappApiService.js'
import { sendEmailToContact } from './emailService.js'

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

function channelUsesEmail(channel = '') {
  const normalized = cleanString(channel, 40).toLowerCase()
  return normalized === 'email' || normalized === 'both'
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
  let normalized = text
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    normalized = `${text}T00:00:00.000Z`
  } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text)) {
    const withDateSeparator = text.replace(/\s+/, 'T')
    normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(withDateSeparator)
      ? withDateSeparator
      : `${withDateSeparator}Z`
  }
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function addDateOnlyDays(dateOnly, days, timezone = DEFAULT_TIMEZONE) {
  const date = DateTime.fromISO(String(dateOnly || ''), { zone: resolveTimezone(timezone) })
  return date.isValid ? date.plus({ days }).toISODate() : ''
}

function businessDateOnlyFromValue(value, timezone = DEFAULT_TIMEZONE) {
  const zone = resolveTimezone(timezone)

  if (value instanceof Date) {
    const date = DateTime.fromJSDate(value).setZone(zone)
    return date.isValid ? date.toISODate() : null
  }

  const text = cleanString(value, 80)
  if (!text) return null

  const calendarDate = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]00:00(?::00(?:\.0{1,6})?)?)?$/)
  if (calendarDate) return calendarDate[1]

  const normalized = text.replace(/\s+/, 'T')
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  const parsed = hasExplicitZone
    ? DateTime.fromISO(normalized, { setZone: true }).setZone(zone)
    : DateTime.fromISO(`${normalized}Z`, { zone: 'utc' }).setZone(zone)

  if (!parsed.isValid) return null
  return parsed.toISODate()
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

function escapeHtml(value) {
  return cleanString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stripHtml(value) {
  return cleanString(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatPaymentAmount(amount, currency = '') {
  const parsed = Number(amount)
  if (!Number.isFinite(parsed)) return ''
  const cleanCurrency = cleanString(currency, 8).toUpperCase()
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

function formatPaymentDate(value, timezone = DEFAULT_TIMEZONE) {
  const dateOnly = businessDateOnlyFromValue(value, timezone)
  if (!dateOnly) return ''

  try {
    const date = DateTime.fromISO(dateOnly, { zone: resolveTimezone(timezone) }).setLocale('es-MX')
    return date.isValid ? date.toLocaleString(DateTime.DATE_FULL) : cleanString(value, 80)
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

function buildPaymentVariableMap(payment = {}, { publicBaseUrl = '', timezone = DEFAULT_TIMEZONE, fallbackCurrency = '' } = {}) {
  const baseUrl = resolvePublicBaseUrl(payment, publicBaseUrl)
  const paymentUrl = buildPaymentUrl(payment, baseUrl)
  const publicPaymentId = cleanString(payment.public_payment_id || payment.publicPaymentId, 200)
  const receiptUrl = appendReceiptQuery(paymentUrl)
  const contact = contactFromPaymentRow(payment)
  const currency = cleanString(payment.currency, 8).toUpperCase() || cleanString(fallbackCurrency, 8).toUpperCase()
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
    'payment.date': formatPaymentDate(payment.paid_at || payment.date || payment.created_at, timezone),
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

function getLegacyDispatchId(paymentId, automationType) {
  return `payment_auto_${automationType}_${cleanString(paymentId, 160).replace(/[^a-zA-Z0-9_-]+/g, '_')}`
}

function shouldSendPaymentTemplateAsTextFallback(error) {
  const text = cleanString(error?.message || error, 1200).toLowerCase()
  if (!text) return false
  const mentionsTemplate = text.includes('plantilla') || text.includes('template')
  if (!mentionsTemplate) return false
  return [
    'approved',
    'aprob',
    'pending',
    'pendiente',
    'rejected',
    'rechaz',
    'paused',
    'pausad',
    'sincroniz',
    'not found',
    'not exist',
    'no existe'
  ].some(fragment => text.includes(fragment))
}

async function claimDispatch({ paymentId, automationType, channel = 'whatsapp', templateId, templateName }) {
  const cleanChannel = cleanString(channel, 40).toLowerCase() || 'whatsapp'
  const id = getDispatchId(paymentId, automationType, cleanChannel)

  if (cleanChannel === 'whatsapp') {
    const legacyId = getLegacyDispatchId(paymentId, automationType)
    const legacy = legacyId === id
      ? null
      : await db.get(
        'SELECT id, status FROM payment_automation_dispatches WHERE id = ? LIMIT 1',
        [legacyId]
      )

    if (legacy?.status === 'failed') {
      await db.run(`
        UPDATE payment_automation_dispatches
        SET status = 'sending',
            channel = ?,
            template_id = ?,
            template_name = ?,
            error_message = NULL,
            raw_response_json = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [cleanChannel, templateId || null, templateName || null, legacyId])
      return { claimed: true, id: legacyId }
    }

    if (legacy) {
      return {
        claimed: false,
        id: legacyId,
        reason: legacy.status === 'sent' ? 'already_sent' : 'already_claimed'
      }
    }
  }

  const result = await db.run(`
    INSERT INTO payment_automation_dispatches (
      id, payment_id, automation_type, channel, status, template_id, template_name, updated_at
    ) VALUES (?, ?, ?, ?, 'sending', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `, [id, paymentId, automationType, cleanChannel, templateId || null, templateName || null])

  if (Number(result?.changes || 0) > 0) return { claimed: true, id }

  const existing = await db.get(
    'SELECT id, status FROM payment_automation_dispatches WHERE id = ? LIMIT 1',
    [id]
  )

  if (existing?.status === 'failed') {
    await db.run(`
      UPDATE payment_automation_dispatches
      SET status = 'sending',
          channel = ?,
          template_id = ?,
          template_name = ?,
          error_message = NULL,
          raw_response_json = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [cleanChannel, templateId || null, templateName || null, id])
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

function buildPaymentAutomationEmail(type, payment = {}, variables = {}, settings = {}) {
  const receipt = settings.receipt || {}
  const automations = settings.automations || {}
  const businessName = cleanString(receipt.businessName || receipt.business_name || settings.checkout?.businessName || 'Ristak', 160)
  const logoUrl = cleanString(receipt.logoUrl || receipt.logo_url || settings.checkout?.logoUrl, 2000)
  const contactName = variables['contact.first_name'] || variables['contact.name'] || 'Hola'
  const product = variables['payment.product'] || 'Pago'
  const amount = variables['payment.amount'] || ''
  const paymentDate = variables['payment.date'] || ''
  const receiptReference = variables['payment.receipt'] || variables['payment.public_id'] || variables['payment.id'] || ''
  const paymentUrl = variables['payment.url'] || ''
  const receiptUrl = variables['payment.receipt_url'] || paymentUrl
  const intro = cleanString(receipt.intro || '', 500)
  const terms = receipt.showTerms === false ? '' : cleanString(receipt.terms || '', 1200)
  const footer = cleanString(receipt.footer || '', 500)

  const contentByType = {
    receipt: {
      badge: 'Pago confirmado',
      subject: `Comprobante de pago - ${product}`,
      title: receipt.title || 'Tu pago quedo confirmado',
      lead: automations.afterPaymentMessage || intro || 'Recibimos tu pago correctamente. Te compartimos tu comprobante para que puedas descargarlo cuando lo necesites.',
      cta: 'Descargar comprobante PDF',
      url: receiptUrl,
      note: 'El enlace abre tu comprobante y activa la descarga del PDF desde la pagina segura de pago.'
    },
    reminder: {
      badge: 'Recordatorio de pago',
      subject: `Recordatorio de pago - ${product}`,
      title: 'Tienes un pago por vencer',
      lead: 'Te compartimos el enlace para revisar el detalle y completar tu pago antes del vencimiento.',
      cta: 'Abrir enlace de pago',
      url: paymentUrl,
      note: 'Si ya realizaste este pago, puedes ignorar este correo.'
    },
    failed: {
      badge: 'Pago no procesado',
      subject: `No pudimos procesar tu pago - ${product}`,
      title: 'Necesitamos reintentar tu pago',
      lead: 'El cobro no se pudo completar. Puedes abrir el enlace para revisar el pago e intentarlo de nuevo.',
      cta: 'Reintentar pago',
      url: paymentUrl,
      note: 'Si necesitas ayuda, responde este correo y el equipo te apoya.'
    }
  }

  const copy = contentByType[type] || contentByType.receipt
  const details = [
    ['Concepto', product],
    ['Monto', amount],
    ['Fecha', paymentDate],
    ['Referencia', receiptReference]
  ].filter(([, value]) => cleanString(value))

  const safeUrl = /^https?:\/\//i.test(copy.url) ? copy.url : ''
  const detailsHtml = details.map(([label, value]) => `
              <tr>
                <td style="padding: 10px 0; color: #64748b; font-size: 13px;">${escapeHtml(label)}</td>
                <td style="padding: 10px 0; color: #0f172a; font-size: 13px; font-weight: 700; text-align: right;">${escapeHtml(value)}</td>
              </tr>
  `).join('')

  const html = `
    <div style="margin: 0; padding: 0; background: #f4f7fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: #0f172a;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background: #f4f7fb;">
        <tr>
          <td align="center" style="padding: 28px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 620px; border-collapse: collapse; background: #ffffff; border: 1px solid #dbe3ef; border-radius: 22px; overflow: hidden;">
              <tr>
                <td style="padding: 26px 28px 18px; background: #0f172a; color: #ffffff;">
                  ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="" width="44" height="44" style="display: block; width: 44px; height: 44px; object-fit: contain; border-radius: 12px; margin-bottom: 16px;">` : ''}
                  <div style="font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #93c5fd;">${escapeHtml(copy.badge)}</div>
                  <h1 style="margin: 8px 0 0; font-size: 26px; line-height: 1.18; font-weight: 800;">${escapeHtml(copy.title)}</h1>
                  <p style="margin: 8px 0 0; font-size: 14px; line-height: 1.6; color: #cbd5e1;">${escapeHtml(businessName)}</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 28px;">
                  <p style="margin: 0 0 14px; font-size: 16px; line-height: 1.65;">${escapeHtml(contactName)},</p>
                  <p style="margin: 0; font-size: 15px; line-height: 1.65; color: #334155;">${escapeHtml(copy.lead)}</p>
                  ${detailsHtml ? `
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0; border-collapse: collapse; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;">
                      ${detailsHtml}
                    </table>
                  ` : ''}
                  ${safeUrl ? `
                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 26px 0 18px;">
                      <tr>
                        <td style="border-radius: 999px; background: #2563eb;">
                          <a href="${escapeHtml(safeUrl)}" style="display: inline-block; padding: 13px 22px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 800;">${escapeHtml(copy.cta)}</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #64748b;">${escapeHtml(copy.note)}</p>
                    <p style="margin: 10px 0 0; font-size: 12px; line-height: 1.6; color: #64748b; word-break: break-all;">${escapeHtml(safeUrl)}</p>
                  ` : ''}
                  ${terms ? `<p style="margin: 24px 0 0; padding-top: 18px; border-top: 1px solid #e2e8f0; font-size: 12px; line-height: 1.6; color: #64748b;">${escapeHtml(terms)}</p>` : ''}
                  ${footer ? `<p style="margin: 18px 0 0; font-size: 13px; line-height: 1.6; color: #475569;">${escapeHtml(footer)}</p>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `

  const textLines = [
    `${copy.title}`,
    '',
    `${contactName},`,
    stripHtml(copy.lead),
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    safeUrl ? `${copy.cta}: ${safeUrl}` : '',
    terms ? `Terminos: ${stripHtml(terms)}` : '',
    footer ? stripHtml(footer) : ''
  ].filter((line, index, array) => line || array[index - 1])

  return {
    subject: copy.subject,
    text: textLines.join('\n').trim(),
    html
  }
}

async function sendPaymentWhatsAppAutomationMessage(type, payment, definition, { publicBaseUrl, extraVariables }) {
  const paymentId = cleanString(payment.id, 200)
  const contact = contactFromPaymentRow(payment)
  if (!contact.phone) return { sent: false, skipped: true, type, channel: 'whatsapp', reason: 'missing_phone' }

  const claim = await claimDispatch({
    paymentId,
    automationType: type,
    channel: 'whatsapp',
    templateId: definition.templateId,
    templateName: definition.templateName
  })
  if (!claim.claimed) return { sent: false, skipped: true, type, channel: 'whatsapp', reason: claim.reason, dispatchId: claim.id }

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
      channel: 'whatsapp',
      dispatchId: claim.id,
      templateName: definition.templateName,
      response
    }
  } catch (error) {
    if (shouldSendPaymentTemplateAsTextFallback(error)) {
      try {
        const fallbackText = await buildDefaultMessageTemplateFallbackText({
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

        if (fallbackText) {
          const response = await sendWhatsAppApiTextMessage({
            to: contact.phone,
            text: fallbackText,
            contactId: contact.id,
            publicBaseUrl,
            extraVariables,
            externalId: `payment:${type}:${paymentId}:text-fallback`,
            allowQrFallback: definition.allowQrFallback
          })

          await markDispatchSent(claim.id, {
            ...response,
            templateFallback: {
              templateName: definition.templateName,
              reason: error.message
            }
          })
          return {
            sent: true,
            type,
            channel: 'whatsapp',
            dispatchId: claim.id,
            templateName: definition.templateName,
            fallback: 'text',
            response
          }
        }
      } catch (fallbackError) {
        logger.warn(`[Pagos] No se pudo enviar ${definition.label} como texto de respaldo ${paymentId}: ${fallbackError.message}`)
      }
    }

    await markDispatchFailed(claim.id, error)
    logger.warn(`[Pagos] No se pudo enviar ${definition.label} por WhatsApp ${paymentId}: ${error.message}`)
    return {
      sent: false,
      type,
      channel: 'whatsapp',
      dispatchId: claim.id,
      templateName: definition.templateName,
      error: error.message
    }
  }
}

async function sendPaymentEmailAutomationMessage(type, payment, definition, { settings, extraVariables }) {
  const paymentId = cleanString(payment.id, 200)
  const contact = contactFromPaymentRow(payment)
  if (!contact.email) return { sent: false, skipped: true, type, channel: 'email', reason: 'missing_email' }

  const claim = await claimDispatch({
    paymentId,
    automationType: type,
    channel: 'email',
    templateName: `${definition.templateName}:email`
  })
  if (!claim.claimed) return { sent: false, skipped: true, type, channel: 'email', reason: claim.reason, dispatchId: claim.id }

  try {
    const message = buildPaymentAutomationEmail(type, payment, extraVariables, settings)
    const response = await sendEmailToContact({
      contactId: contact.id,
      to: contact.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
      externalId: claim.id,
      includeSignature: true
    })

    await markDispatchSent(claim.id, response)
    return {
      sent: true,
      type,
      channel: 'email',
      dispatchId: claim.id,
      response
    }
  } catch (error) {
    await markDispatchFailed(claim.id, error)
    logger.warn(`[Pagos] No se pudo enviar ${definition.label} por correo ${paymentId}: ${error.message}`)
    return {
      sent: false,
      type,
      channel: 'email',
      dispatchId: claim.id,
      error: error.message
    }
  }
}

function summarizeDispatchResults(type, results = []) {
  const sentResults = results.filter((result) => result?.sent)
  const first = sentResults[0] || results[0] || { sent: false, skipped: true, reason: 'no_channel' }

  return {
    ...first,
    sent: sentResults.length > 0,
    skipped: sentResults.length === 0 && results.every((result) => result?.skipped),
    type,
    channels: sentResults.map((result) => result.channel).filter(Boolean),
    results
  }
}

export async function sendPaymentAutomationMessage(type, paymentInput, options = {}) {
  const settings = options.settings || await getPaymentSettings()
  const timezone = options.timezone || await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const fallbackCurrency = options.currency || await getAccountCurrency().catch(() => '')
  const definition = getAutomationDefinition(type, settings)
  if (!definition) return { sent: false, skipped: true, reason: 'unknown_type' }
  if (!definition.enabled) return { sent: false, skipped: true, reason: 'disabled' }
  const sendWhatsApp = channelUsesWhatsApp(definition.channel)
  const sendEmail = channelUsesEmail(definition.channel)
  if (!sendWhatsApp && !sendEmail) return { sent: false, skipped: true, reason: 'channel_not_supported' }

  const payment = await loadPaymentWithContact(paymentInput)
  const paymentId = cleanString(payment.id, 200)
  if (!paymentId) return { sent: false, skipped: true, reason: 'missing_payment' }

  const publicBaseUrl = resolvePublicBaseUrl(payment, options.publicBaseUrl)
  const extraVariables = buildPaymentVariableMap(payment, { publicBaseUrl, timezone, fallbackCurrency })
  const hasPaymentTarget = Boolean(extraVariables['payment.public_id'] || /^https?:\/\//i.test(extraVariables['payment.url']))
  if (shouldRequirePaymentLink(type) && !hasPaymentTarget) {
    return { sent: false, skipped: true, reason: 'missing_payment_url' }
  }

  const results = []
  if (sendWhatsApp) {
    results.push(await sendPaymentWhatsAppAutomationMessage(type, payment, definition, { publicBaseUrl, extraVariables }))
  }

  if (sendEmail) {
    results.push(await sendPaymentEmailAutomationMessage(type, payment, definition, { settings, extraVariables }))
  }

  return summarizeDispatchResults(type, results)
}

export function queuePaymentAutomationMessage(type, paymentInput, options = {}) {
  Promise.resolve()
    .then(() => sendPaymentAutomationMessage(type, paymentInput, options))
    .catch((error) => {
      logger.warn(`[Pagos] Error no manejado enviando automatizacion ${type}: ${error.message}`)
    })
}

async function getReminderCandidates(settings, now, limit, paymentIds = [], timezone = DEFAULT_TIMEZONE) {
  const daysBefore = Math.max(1, Number(settings.automations?.reminderDaysBefore || 3))
  const todayDate = businessDateOnlyFromValue(now, timezone)
  const targetEndDate = addDateOnlyDays(todayDate, daysBefore, timezone)
  const closed = [...CLOSED_PAYMENT_STATUSES]
  const placeholders = closed.map(() => '?').join(', ')
  const cleanPaymentIds = paymentIds.map((id) => cleanString(id, 200)).filter(Boolean)
  const paymentIdFilter = cleanPaymentIds.length
    ? `AND id IN (${cleanPaymentIds.map(() => '?').join(', ')})`
    : ''
  // PAY2-007: no enviar recordatorios para links sin due_date. En PostgreSQL
  // due_date es timestamp, así que no se puede usar TRIM() como en SQLite.
  // El filtro JS valida que sea una fecha parseable.
  const rows = await db.all(`
    SELECT *
    FROM payments
    WHERE due_date IS NOT NULL
      AND LOWER(COALESCE(status, 'pending')) NOT IN (${placeholders})
      ${paymentIdFilter}
    ORDER BY due_date ASC
    LIMIT ?
  `, [...closed, ...cleanPaymentIds, Math.max(limit * 3, limit)])

  return rows.filter((row) => {
    // PAY2-007: fechas invalidas/vacias se excluyen; no se inventa vencimiento.
    const dueDate = businessDateOnlyFromValue(row.due_date, timezone)
    return dueDate !== null && dueDate >= todayDate && dueDate <= targetEndDate
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
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const results = []

  const reminderDefinition = getAutomationDefinition('reminder', settings)
  if (reminderDefinition?.enabled && (channelUsesWhatsApp(reminderDefinition.channel) || channelUsesEmail(reminderDefinition.channel))) {
    const reminders = await getReminderCandidates(settings, now, limit, paymentIds, timezone)
    for (const payment of reminders) {
      results.push(await sendPaymentAutomationMessage('reminder', payment, { settings, timezone }))
    }
  }

  const failedDefinition = getAutomationDefinition('failed', settings)
  if (failedDefinition?.enabled && (channelUsesWhatsApp(failedDefinition.channel) || channelUsesEmail(failedDefinition.channel))) {
    const failed = await getFailedCandidates(settings, now, limit, paymentIds)
    for (const payment of failed) {
      results.push(await sendPaymentAutomationMessage('failed', payment, { settings, timezone }))
    }
  }

  return results
}
