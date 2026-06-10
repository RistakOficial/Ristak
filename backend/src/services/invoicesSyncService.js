/**
 * Servicio de sincronización de invoices desde HighLevel
 *
 * Funcionalidad:
 * - Obtiene invoices desde la API de HighLevel
 * - Los guarda en BD local para evitar duplicados
 * - Actualiza estados si ya existen
 * - Permite mostrar pagos pendientes y pagados
 */

import { db } from '../config/database.js'
import { getGHLClient } from './ghlClient.js'
import { ensureContactExists } from './highlevelSyncService.js'
import { logger } from '../utils/logger.js'
import { getInvoicePaymentMode, nonTestPaymentCondition } from '../utils/paymentMode.js'
import { markPaymentFlowInvoicePaid } from './paymentFlowService.js'
import {
  finalizePreparedPhoneUpsert,
  mergeContactIds,
  prepareContactPhoneUpsert
} from './contactIdentityService.js'
import {
  isSuccessfulPaymentStatus,
  triggerWhatsappFirstPurchaseEvent
} from './metaWhatsappEventsService.js'

const PAID_INVOICE_STATUSES = new Set(['paid', 'succeeded', 'completed'])
const PAID_STATUS_DOWNGRADE_PROTECTED_STATUSES = new Set(['draft', 'sent', 'pending', 'overdue', 'payment_processing'])
const LOCAL_EXPORT_EXCLUDED_STATUSES = new Set(['deleted', 'failed', 'refunded', 'void', 'voided'])
const LOCAL_EXPORT_PAID_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'])
const LOCAL_EXPORT_ID_PREFIXES = ['manual_payment_']
const LOCAL_EXPORT_METHOD_TO_GHL_MODE = {
  card: 'card',
  transfer: 'bank_transfer',
  bank_transfer: 'bank_transfer',
  cash: 'cash',
  check: 'check',
  deposit: 'bank_transfer',
  paypal: 'other',
  other: 'other'
}

function cleanString(value) {
  return String(value || '').trim()
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function serializeCustomFields(value) {
  if (value === null || value === undefined || value === '') return '[]'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return '[]'
  }
}

function toDateOnly(value) {
  if (!value) return undefined
  return String(value).split('T')[0]
}

function normalizeLocalPaymentMode(value, fallback = 'live') {
  if (value === 'test') return 'test'
  if (value === 'live') return 'live'
  return fallback === 'test' ? 'test' : 'live'
}

function isLocalPaymentExportCandidate(payment = {}) {
  const id = cleanString(payment.id)
  return LOCAL_EXPORT_ID_PREFIXES.some(prefix => id.startsWith(prefix))
}

function getInvoiceItems(invoice = {}) {
  for (const source of [invoice.invoiceItems, invoice.items, invoice.lineItems]) {
    if (Array.isArray(source) && source.length > 0) return source
  }

  return []
}

function getInvoiceDisplayDescription(invoice = {}) {
  const firstItem = getInvoiceItems(invoice)[0] || {}

  return (
    firstItem.description ||
    firstItem.name ||
    invoice.description ||
    invoice.title ||
    invoice.name ||
    'Pago'
  )
}

function getInvoiceDisplayTitle(invoice = {}) {
  const firstItem = getInvoiceItems(invoice)[0] || {}

  return (
    invoice.title ||
    invoice.name ||
    firstItem.name ||
    firstItem.description ||
    'Pago'
  )
}

function getInvoiceNotes(invoice = {}) {
  return cleanString(
    invoice.termsNotes ||
    invoice.terms ||
    invoice.notes ||
    invoice.memo ||
    invoice.description
  )
}

function extractImportedLocalPaymentId(invoice = {}) {
  const notes = getInvoiceNotes(invoice)
  if (!notes || !notes.includes('Importado desde Ristak')) return null

  const match = notes.match(/Pago local:\s*([A-Za-z0-9_-]+)/i)
  return match?.[1] || null
}

function getPaymentTitle(payment = {}) {
  return cleanString(payment.title || payment.description || payment.reference || 'Pago') || 'Pago'
}

function getPaymentDescription(payment = {}) {
  return cleanString(payment.description || payment.title || payment.reference || 'Pago') || 'Pago'
}

function getContactName(contact = {}) {
  return cleanString(
    contact.contact_name ||
    contact.full_name ||
    `${contact.first_name || ''} ${contact.last_name || ''}`.trim() ||
    contact.email ||
    contact.phone ||
    'Cliente'
  )
}

async function getLocalPaymentExportContext() {
  const config = await db.get(`
    SELECT location_data, ghl_invoice_mode, invoice_terms_notes
    FROM highlevel_config
    LIMIT 1
  `)

  const locationData = safeJsonParse(config?.location_data, {})
  const business = locationData?.business || {}
  const liveMode = config?.ghl_invoice_mode === 'test' ? false : true

  return {
    liveMode,
    paymentMode: liveMode ? 'live' : 'test',
    termsNotes: cleanString(config?.invoice_terms_notes),
    businessDetails: {
      name: firstDefined(business.name, locationData?.name, 'Mi Negocio'),
      email: firstDefined(business.email, locationData?.email, ''),
      phoneNo: firstDefined(business.phone, locationData?.phone, ''),
      website: firstDefined(business.website, locationData?.website, ''),
      address: firstDefined(business.address, locationData?.address, ''),
      city: firstDefined(business.city, locationData?.city, ''),
      state: firstDefined(business.state, locationData?.state, ''),
      country: firstDefined(business.country, locationData?.country, ''),
      countryCode: firstDefined(business.countryCode, locationData?.countryCode, ''),
      postalCode: firstDefined(business.postalCode, locationData?.postalCode, '')
    }
  }
}

async function getLocalPaymentsPendingHighLevel({ paymentId, limit = 100 } = {}) {
  const filters = [
    "(p.ghl_invoice_id IS NULL OR p.ghl_invoice_id = '')",
    'COALESCE(p.amount, 0) > 0',
    `(${LOCAL_EXPORT_ID_PREFIXES.map(() => 'p.id LIKE ?').join(' OR ')})`
  ]
  const params = LOCAL_EXPORT_ID_PREFIXES.map(prefix => `${prefix}%`)

  if (paymentId) {
    filters.push('p.id = ?')
    params.push(paymentId)
  }

  const rows = await db.all(
    `SELECT
       p.*,
       c.id as contact_local_id,
       c.full_name as contact_name,
       c.first_name,
       c.last_name,
       c.email as contact_email,
       c.phone as contact_phone,
       c.source as contact_source,
       c.visitor_id,
       c.attribution_url,
       c.attribution_session_source,
       c.attribution_medium,
       c.attribution_ctwa_clid,
       c.attribution_ad_name,
       c.attribution_ad_id,
       c.custom_fields,
       c.created_at as contact_created_at
     FROM payments p
     LEFT JOIN contacts c ON p.contact_id = c.id
     WHERE ${filters.join(' AND ')}
     ORDER BY p.created_at ASC
     LIMIT ?`,
    [...params, Math.max(1, Math.min(Number(limit) || 100, 1000))]
  )

  return rows.filter(payment => {
    const status = cleanString(payment.status).toLowerCase()
    return isLocalPaymentExportCandidate(payment) && !LOCAL_EXPORT_EXCLUDED_STATUSES.has(status)
  })
}

async function clearConflictingContactEmail({ targetId, email }) {
  const normalizedEmail = cleanString(email).toLowerCase()
  if (!targetId || !normalizedEmail) return null

  const conflict = await db.get(
    'SELECT id FROM contacts WHERE LOWER(email) = ? AND id != ? LIMIT 1',
    [normalizedEmail, targetId]
  )

  if (!conflict) return null

  await db.run('UPDATE contacts SET email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conflict.id])
  return conflict.id
}

async function upsertHighLevelContactLocallyForPayment({ localContact, highLevelContact }) {
  const targetId = highLevelContact.id || highLevelContact._id
  if (!targetId) throw new Error('HighLevel no devolvió id de contacto')

  const fullName = getContactName({
    contact_name: highLevelContact.name || highLevelContact.contactName || localContact.contact_name,
    first_name: highLevelContact.firstName || localContact.first_name,
    last_name: highLevelContact.lastName || localContact.last_name,
    email: highLevelContact.email || localContact.contact_email,
    phone: highLevelContact.phone || localContact.contact_phone
  })
  const firstName = cleanString(highLevelContact.firstName || localContact.first_name || fullName.split(' ')[0])
  const lastName = cleanString(highLevelContact.lastName || localContact.last_name || fullName.split(' ').slice(1).join(' '))
  const email = cleanString(highLevelContact.email || localContact.contact_email) || null
  const phone = cleanString(highLevelContact.phone || localContact.contact_phone) || null
  const phoneUpsert = await prepareContactPhoneUpsert({ contactId: targetId, phone })
  const emailMergeFromContactId = await clearConflictingContactEmail({ targetId, email })
  const usePostgres = Boolean(process.env.DATABASE_URL)
  const customFieldsPlaceholder = usePostgres ? '?::jsonb' : '?'

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, first_name, last_name, source, visitor_id,
        attribution_url, attribution_session_source, attribution_medium, attribution_ctwa_clid,
        attribution_ad_name, attribution_ad_id, custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        phone = COALESCE(excluded.phone, contacts.phone),
        email = COALESCE(excluded.email, contacts.email),
        full_name = COALESCE(excluded.full_name, contacts.full_name),
        first_name = COALESCE(excluded.first_name, contacts.first_name),
        last_name = COALESCE(excluded.last_name, contacts.last_name),
        source = COALESCE(excluded.source, contacts.source),
        visitor_id = COALESCE(excluded.visitor_id, contacts.visitor_id),
        attribution_url = COALESCE(excluded.attribution_url, contacts.attribution_url),
        attribution_session_source = COALESCE(excluded.attribution_session_source, contacts.attribution_session_source),
        attribution_medium = COALESCE(excluded.attribution_medium, contacts.attribution_medium),
        attribution_ctwa_clid = COALESCE(excluded.attribution_ctwa_clid, contacts.attribution_ctwa_clid),
        attribution_ad_name = COALESCE(excluded.attribution_ad_name, contacts.attribution_ad_name),
        attribution_ad_id = COALESCE(excluded.attribution_ad_id, contacts.attribution_ad_id),
        custom_fields = COALESCE(excluded.custom_fields, contacts.custom_fields),
        updated_at = CURRENT_TIMESTAMP
    `, [
      targetId,
      phoneUpsert.phone || phone || null,
      email,
      fullName || null,
      firstName || null,
      lastName || null,
      localContact.contact_source || highLevelContact.source || 'ristak',
      localContact.visitor_id || null,
      localContact.attribution_url || null,
      localContact.attribution_session_source || null,
      localContact.attribution_medium || null,
      localContact.attribution_ctwa_clid || null,
      localContact.attribution_ad_name || null,
      localContact.attribution_ad_id || null,
      serializeCustomFields(localContact.custom_fields),
      localContact.contact_created_at || null
    ])

    await finalizePreparedPhoneUpsert(phoneUpsert, targetId)

    if (emailMergeFromContactId && emailMergeFromContactId !== phoneUpsert.mergeFromContactId) {
      await mergeContactIds({ fromId: emailMergeFromContactId, toId: targetId, canonicalPhone: phoneUpsert.phone || phone })
    }
  } catch (error) {
    if (phoneUpsert.mergeFromContactId) {
      await db.run(
        'UPDATE contacts SET phone = COALESCE(phone, ?), email = COALESCE(email, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [phone || null, email || null, phoneUpsert.mergeFromContactId]
      )
    }
    throw error
  }

  return targetId
}

async function ensureHighLevelContactForLocalPayment(client, payment) {
  const contactName = getContactName(payment)
  const email = cleanString(payment.contact_email)
  const phone = cleanString(payment.contact_phone)

  if (!email && !phone) {
    throw new Error(`Pago local ${payment.id} no tiene email ni teléfono de contacto para subir a HighLevel`)
  }

  const response = await client.upsertContact({
    name: contactName,
    firstName: payment.first_name,
    lastName: payment.last_name,
    email,
    phone,
    source: payment.contact_source || 'ristak'
  })
  const highLevelContact = response.contact || response

  return upsertHighLevelContactLocallyForPayment({
    localContact: payment,
    highLevelContact
  })
}

function buildInvoicePayloadForLocalPayment({ payment, contactId, context }) {
  const amount = Math.round(Number(payment.amount || 0) * 100) / 100
  const currency = cleanString(payment.currency || 'MXN').toUpperCase()
  const title = getPaymentTitle(payment)
  const description = getPaymentDescription(payment)
  const noteParts = [
    context.termsNotes,
    'Importado desde Ristak',
    `Pago local: ${payment.id}`,
    payment.reference ? `Referencia: ${payment.reference}` : ''
  ].filter(Boolean)

  return {
    name: title,
    title,
    currency,
    liveMode: context.liveMode,
    businessDetails: context.businessDetails,
    contactDetails: {
      id: contactId,
      name: getContactName(payment),
      email: cleanString(payment.contact_email),
      phoneNo: cleanString(payment.contact_phone)
    },
    items: [
      {
        name: title,
        description,
        amount,
        qty: 1,
        currency
      }
    ],
    issueDate: toDateOnly(payment.date) || toDateOnly(payment.created_at) || toDateOnly(new Date().toISOString()),
    ...(toDateOnly(payment.due_date) && { dueDate: toDateOnly(payment.due_date) }),
    ...(noteParts.length && { termsNotes: noteParts.join('\n') })
  }
}

async function exportSingleLocalPaymentToHighLevel({ client, payment, context }) {
  const contactId = await ensureHighLevelContactForLocalPayment(client, payment)
  const paymentMode = normalizeLocalPaymentMode(payment.payment_mode, context.paymentMode)
  const paymentContext = {
    ...context,
    liveMode: paymentMode === 'live',
    paymentMode
  }
  const invoicePayload = buildInvoicePayloadForLocalPayment({ payment, contactId, context: paymentContext })
  const createdResponse = await client.createInvoice(invoicePayload)
  const createdInvoice = createdResponse.invoice || createdResponse
  const ghlInvoiceId = createdInvoice.id || createdInvoice._id

  if (!ghlInvoiceId) {
    throw new Error(`HighLevel no devolvió invoiceId para pago local ${payment.id}`)
  }

  const invoiceNumber = createdInvoice.invoiceNumber || null
  const localStatus = cleanString(payment.status).toLowerCase()
  const shouldRecordPayment = LOCAL_EXPORT_PAID_STATUSES.has(localStatus)

  await db.run(
    `UPDATE payments
     SET contact_id = ?, ghl_invoice_id = ?, invoice_number = COALESCE(?, invoice_number),
         payment_mode = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [contactId, ghlInvoiceId, invoiceNumber, paymentMode, payment.id]
  )

  if (shouldRecordPayment) {
    await client.recordPayment(ghlInvoiceId, {
      amount: Number(payment.amount || 0),
      currency: payment.currency || 'MXN',
      fulfilledAt: payment.date || payment.created_at || new Date().toISOString(),
      note: [
        'Pago importado desde Ristak',
        `Pago local: ${payment.id}`,
        payment.reference ? `Referencia: ${payment.reference}` : ''
      ].filter(Boolean).join('\n'),
      mode: LOCAL_EXPORT_METHOD_TO_GHL_MODE[payment.payment_method] || 'cash',
      liveMode: paymentContext.liveMode
    })

    await db.run(
      `UPDATE payments
       SET status = 'paid', payment_method = COALESCE(payment_method, ?),
           payment_mode = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [payment.payment_method || 'cash', paymentMode, payment.id]
    )
  }

  await updateContactStats(contactId)

  return {
    paymentId: payment.id,
    contactId,
    invoiceId: ghlInvoiceId,
    invoiceNumber,
    recordedPayment: shouldRecordPayment
  }
}

export async function syncLocalPaymentsToHighLevel({ paymentId, limit = 100 } = {}) {
  let client
  try {
    client = await getGHLClient()
  } catch (error) {
    logger.info(`HighLevel no configurado; pagos locales quedan pendientes de exportación: ${error.message}`)
    return { total: 0, exported: 0, failed: 0, skippedNoConfig: true, errors: [] }
  }

  const localPayments = await getLocalPaymentsPendingHighLevel({ paymentId, limit })
  if (!localPayments.length) {
    return { total: 0, exported: 0, failed: 0, skippedNoConfig: false, errors: [] }
  }

  const context = await getLocalPaymentExportContext()
  const errors = []
  let exported = 0

  logger.info(`Exportando ${localPayments.length} pagos locales pendientes a HighLevel...`)

  for (const payment of localPayments) {
    try {
      await exportSingleLocalPaymentToHighLevel({ client, payment, context })
      exported += 1
    } catch (error) {
      errors.push({ paymentId: payment.id, error: error.message })
      logger.warn(`No se pudo exportar pago local ${payment.id} a HighLevel: ${error.message}`)
    }
  }

  return {
    total: localPayments.length,
    exported,
    failed: errors.length,
    skippedNoConfig: false,
    errors
  }
}

/**
 * Verifica que el contacto del invoice exista localmente.
 * Si no existe lo descarga desde HighLevel y lo crea.
 * @returns {Promise<boolean>} - true si el contacto existe o se creó
 */
async function ensureLocalContactForInvoice(ghlClient, contactId) {
  if (!contactId) return false

  const exists = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId])
  if (exists) return true

  const usePostgres = Boolean(process.env.DATABASE_URL)
  await ensureContactExists(contactId, ghlClient.apiToken, usePostgres, ghlClient.locationId)

  const created = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId])
  return Boolean(created)
}

async function findExistingPaymentForInvoice({ invoiceId, contactId, invoiceNumber, importedLocalPaymentId = null }) {
  if (importedLocalPaymentId) {
    const existingImportedLocal = await db.get(
      'SELECT id, contact_id, status, payment_mode, ghl_invoice_id FROM payments WHERE id = ? LIMIT 1',
      [importedLocalPaymentId]
    )

    if (existingImportedLocal) return existingImportedLocal
  }

  const existingByInvoiceId = await db.get(
    'SELECT id, contact_id, status, payment_mode, ghl_invoice_id FROM payments WHERE ghl_invoice_id = ? OR id = ? LIMIT 1',
    [invoiceId, invoiceId]
  )

  if (existingByInvoiceId) return existingByInvoiceId

  if (!contactId || !invoiceNumber) return null

  return await db.get(
    `SELECT id, contact_id, status, payment_mode, ghl_invoice_id
     FROM payments
     WHERE contact_id = ?
       AND (
         invoice_number = ?
         OR reference = ?
         OR reference = ?
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [contactId, invoiceNumber, invoiceNumber, `Invoice #${invoiceNumber}`]
  )
}

function resolveSyncedInvoiceStatus(existingStatus, incomingStatus) {
  const normalizedExistingStatus = cleanString(existingStatus).toLowerCase()
  const normalizedIncomingStatus = cleanString(incomingStatus).toLowerCase()

  if (
    isSuccessfulPaymentStatus(normalizedExistingStatus) &&
    PAID_STATUS_DOWNGRADE_PROTECTED_STATUSES.has(normalizedIncomingStatus)
  ) {
    return normalizedExistingStatus
  }

  return normalizedIncomingStatus || 'pending'
}

async function updateSyncedInvoiceContactStats({ existing, contactId, previousStatus, nextStatus }) {
  const contactIds = Array.from(new Set([existing?.contact_id, contactId].filter(Boolean)))
  if (contactIds.length === 0) return

  const contactChanged = Boolean(existing?.contact_id && contactId && existing.contact_id !== contactId)
  const shouldRecalculate =
    contactChanged ||
    isSuccessfulPaymentStatus(previousStatus) ||
    isSuccessfulPaymentStatus(nextStatus)

  if (!shouldRecalculate) return

  await Promise.all(contactIds.map(id => updateContactStats(id)))
}

async function activatePaymentFlowFromPaidInvoice(invoiceId, invoiceData) {
  if (!invoiceId || !PAID_INVOICE_STATUSES.has(invoiceData.status) || !invoiceData.contact_id) {
    return
  }

  try {
    await markPaymentFlowInvoicePaid(invoiceId, {
      contactId: invoiceData.contact_id,
      amount: invoiceData.amount,
      description: invoiceData.description
    })
  } catch (error) {
    logger.error(`No se pudo activar flujo de parcialidades desde invoice sincronizado ${invoiceId}: ${error.message}`)
  }
}

/**
 * Sincroniza invoices desde HighLevel a BD local
 * @param {Object} options - Opciones de sincronización
 * @param {number} options.limit - Número de invoices a obtener (default: 100)
 * @param {number} options.offset - Offset para paginación (default: 0)
 * @param {string} options.contactId - Filtrar por contacto específico
 * @returns {Promise<Object>} - Estadísticas de sincronización
 */
export async function syncInvoices({ limit = 100, offset = 0, contactId } = {}) {
  try {
    logger.info(`Iniciando sincronización de invoices (limit: ${limit}, offset: ${offset})`)

    if (!contactId && offset === 0) {
      const localExport = await syncLocalPaymentsToHighLevel({ limit: 1000 })
      if (localExport.exported > 0 || localExport.failed > 0) {
        logger.info(`Exportación local previa: ${localExport.exported} pagos exportados, ${localExport.failed} fallidos`)
      }
    }

    const ghlClient = await getGHLClient()

    // Obtener invoices desde HighLevel
    const response = await ghlClient.listInvoices({ limit, offset, contactId })

    // GHL puede devolver { invoices: [...] } o { data: [...] }
    const invoices = response.invoices || response.data || []

    logger.info(`Obtenidos ${invoices.length} invoices desde HighLevel`)

    let created = 0
    let updated = 0
    let skipped = 0

    for (const invoice of invoices) {
      try {
        // ID del invoice en HighLevel
        const ghlInvoiceId = invoice.id || invoice._id

        if (!ghlInvoiceId) {
          logger.warn('Invoice sin ID, saltando:', invoice)
          skipped++
          continue
        }

        // Validar que tenga contactId válido (puede estar en contactDetails.id o contactId)
        const contactId = invoice.contactDetails?.id || invoice.contactId

        if (!contactId) {
          logger.warn(`⚠️ Invoice ${ghlInvoiceId} sin contactId válido, saltando...`)
          skipped++
          continue
        }

        const invoiceNumber = invoice.invoiceNumber || null
        const importedLocalPaymentId = extractImportedLocalPaymentId(invoice)

        if (importedLocalPaymentId && !isLocalPaymentExportCandidate({ id: importedLocalPaymentId })) {
          logger.warn(`Ignorando invoice ${ghlInvoiceId}: parece duplicado creado por exportación local accidental de ${importedLocalPaymentId}`)
          skipped++
          continue
        }

        const existing = await findExistingPaymentForInvoice({
          invoiceId: ghlInvoiceId,
          contactId,
          invoiceNumber,
          importedLocalPaymentId
        })

        // Datos comunes del invoice
        const invoiceData = {
          contact_id: contactId,
          amount: invoice.total || invoice.amount || 0,
          currency: invoice.currency || 'MXN',
          status: mapInvoiceStatus(invoice.status),
          payment_method: invoice.paymentMode || null,
          payment_mode: getInvoicePaymentMode(invoice, existing?.payment_mode || 'live'),
          reference: invoiceNumber,
          title: getInvoiceDisplayTitle(invoice),
          description: getInvoiceDisplayDescription(invoice),
          date: invoice.createdAt || invoice.issueDate || new Date().toISOString(),
          ghl_invoice_id: ghlInvoiceId,
          invoice_number: invoiceNumber,
          due_date: invoice.dueDate || null,
          sent_at: invoice.sentAt || null,
        }
        let savedInvoiceStatus = invoiceData.status

        if (existing) {
          savedInvoiceStatus = resolveSyncedInvoiceStatus(existing.status, invoiceData.status)

          // Actualizar SIEMPRE para mantener datos sincronizados (incluyendo descripción)
          await db.run(
            `UPDATE payments
             SET status = ?, amount = ?, currency = ?, payment_method = ?,
                 payment_mode = ?, reference = ?, title = ?, description = ?, contact_id = ?,
                 ghl_invoice_id = ?, invoice_number = ?, due_date = ?, sent_at = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              savedInvoiceStatus,
              invoiceData.amount,
              invoiceData.currency,
              invoiceData.payment_method,
              invoiceData.payment_mode,
              invoiceData.reference,
              invoiceData.title,
              invoiceData.description,
              invoiceData.contact_id,
              invoiceData.ghl_invoice_id,
              invoiceData.invoice_number,
              invoiceData.due_date,
              invoiceData.sent_at,
              existing.id
            ]
          )
          updated++
          logger.info(`Invoice actualizado: ${ghlInvoiceId} (${savedInvoiceStatus})`)
        } else {
          // Verificar si el contacto existe antes de crear el invoice
          // (si no existe localmente, se descarga desde HighLevel)
          if (invoiceData.contact_id) {
            const contactAvailable = await ensureLocalContactForInvoice(ghlClient, invoiceData.contact_id)

            if (!contactAvailable) {
              logger.warn(`⚠️ Ignorando invoice ${ghlInvoiceId}: contacto ${invoiceData.contact_id} no existe en HighLevel ni localmente`)
              skipped++
              continue
            }
          }

          // Crear nuevo invoice en BD
          await db.run(
            `INSERT INTO payments (
              id, contact_id, amount, currency, status, payment_method, payment_mode,
              reference, title, description, date, ghl_invoice_id, invoice_number,
              due_date, sent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              ghlInvoiceId, // Usar mismo ID que en HighLevel
              invoiceData.contact_id,
              invoiceData.amount,
              invoiceData.currency,
              invoiceData.status,
              invoiceData.payment_method,
              invoiceData.payment_mode,
              invoiceData.reference,
              invoiceData.title,
              invoiceData.description,
              invoiceData.date,
              invoiceData.ghl_invoice_id,
              invoiceData.invoice_number,
              invoiceData.due_date,
              invoiceData.sent_at
            ]
          )
          created++
          logger.success(`Invoice creado: ${ghlInvoiceId} (${invoiceData.status})`)
        }

        const savedInvoiceData = { ...invoiceData, status: savedInvoiceStatus }

        await updateSyncedInvoiceContactStats({
          existing,
          contactId: invoiceData.contact_id,
          previousStatus: existing?.status,
          nextStatus: savedInvoiceStatus
        })

        await activatePaymentFlowFromPaidInvoice(ghlInvoiceId, savedInvoiceData)

        const transitionedToPaid = invoiceData.contact_id &&
          isSuccessfulPaymentStatus(savedInvoiceStatus) &&
          existing &&
          !isSuccessfulPaymentStatus(existing.status)

        if (transitionedToPaid) {
          await triggerWhatsappFirstPurchaseEvent(invoiceData.contact_id, {
            amount: invoiceData.amount,
            currency: invoiceData.currency,
            paymentMode: invoiceData.payment_mode
          })
        }

      } catch (error) {
        logger.error(`Error procesando invoice ${invoice.id}:`, error)
        skipped++
      }
    }

    const stats = {
      total: invoices.length,
      created,
      updated,
      skipped
    }

    logger.success(`Sincronización completada: ${JSON.stringify(stats)}`)

    return stats

  } catch (error) {
    logger.error('Error en sincronización de invoices:', error)
    throw error
  }
}

/**
 * Sincroniza TODOS los invoices desde HighLevel (con paginación completa)
 * Esta función obtiene TODOS los invoices haciendo múltiples llamadas paginadas
 *
 * @param {Object} options - Opciones de sincronización
 * @param {string} options.contactId - Filtrar por contacto específico (opcional)
 * @returns {Promise<Object>} - Estadísticas de sincronización completa
 */
export async function syncAllInvoices({ contactId } = {}) {
  try {
    logger.info('🔄 Iniciando sincronización COMPLETA de invoices desde HighLevel...')

    if (!contactId) {
      const localExport = await syncLocalPaymentsToHighLevel({ limit: 1000 })
      if (localExport.exported > 0 || localExport.failed > 0) {
        logger.info(`Exportación local previa: ${localExport.exported} pagos exportados, ${localExport.failed} fallidos`)
      }
    }

    const ghlClient = await getGHLClient()
    let allInvoices = []
    let offset = 0
    const limit = 100 // Tamaño de cada bloque
    let hasMore = true
    let totalFetched = 0

    // Loop de paginación - obtener TODO
    while (hasMore) {
      logger.info(`📥 Obteniendo invoices - offset: ${offset}, limit: ${limit}`)

      const response = await ghlClient.listInvoices({ limit, offset, contactId })
      const invoices = response.invoices || response.data || []

      allInvoices = allInvoices.concat(invoices)
      totalFetched += invoices.length

      logger.info(`   ✓ Obtenidos ${invoices.length} invoices (total acumulado: ${totalFetched})`)

      // Si trajo menos de lo que pedimos, ya no hay más
      if (invoices.length < limit) {
        hasMore = false
        logger.info(`✅ Paginación completa - total de invoices obtenidos: ${totalFetched}`)
      } else {
        offset += limit
      }
    }

    logger.info(`📊 Procesando ${allInvoices.length} invoices en la base de datos...`)

    // Procesar todos los invoices obtenidos
    let created = 0
    let updated = 0
    let skipped = 0

    for (const invoice of allInvoices) {
      try {
        const ghlInvoiceId = invoice.id || invoice._id

        if (!ghlInvoiceId) {
          skipped++
          continue
        }

        // El listado de invoices de GHL trae el contacto en contactDetails.id
        const contactId = invoice.contactDetails?.id || invoice.contactId

        const invoiceNumber = invoice.invoiceNumber || null
        const importedLocalPaymentId = extractImportedLocalPaymentId(invoice)

        if (importedLocalPaymentId && !isLocalPaymentExportCandidate({ id: importedLocalPaymentId })) {
          logger.warn(`Ignorando invoice ${ghlInvoiceId}: parece duplicado creado por exportación local accidental de ${importedLocalPaymentId}`)
          skipped++
          continue
        }

        const existing = await findExistingPaymentForInvoice({
          invoiceId: ghlInvoiceId,
          contactId,
          invoiceNumber,
          importedLocalPaymentId
        })

        if (!contactId) {
          skipped++
          continue
        }

        // Datos comunes del invoice
        const invoiceData = {
          contact_id: contactId,
          amount: invoice.total || invoice.amount || 0,
          currency: invoice.currency || 'MXN',
          status: mapInvoiceStatus(invoice.status),
          payment_method: invoice.paymentMode || null,
          payment_mode: getInvoicePaymentMode(invoice, existing?.payment_mode || 'live'),
          reference: invoiceNumber,
          title: getInvoiceDisplayTitle(invoice),
          description: getInvoiceDisplayDescription(invoice),
          date: invoice.createdAt || invoice.issueDate || new Date().toISOString(),
          ghl_invoice_id: ghlInvoiceId,
          invoice_number: invoiceNumber,
          due_date: invoice.dueDate || null,
          sent_at: invoice.sentAt || null,
        }
        let savedInvoiceStatus = invoiceData.status

        if (existing) {
          savedInvoiceStatus = resolveSyncedInvoiceStatus(existing.status, invoiceData.status)

          // Actualizar SIEMPRE para mantener datos sincronizados (incluyendo descripción)
          await db.run(
            `UPDATE payments
             SET status = ?, amount = ?, currency = ?, payment_method = ?,
                 payment_mode = ?, reference = ?, title = ?, description = ?, contact_id = ?,
                 ghl_invoice_id = ?, invoice_number = ?, due_date = ?, sent_at = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              savedInvoiceStatus,
              invoiceData.amount,
              invoiceData.currency,
              invoiceData.payment_method,
              invoiceData.payment_mode,
              invoiceData.reference,
              invoiceData.title,
              invoiceData.description,
              invoiceData.contact_id,
              invoiceData.ghl_invoice_id,
              invoiceData.invoice_number,
              invoiceData.due_date,
              invoiceData.sent_at,
              existing.id
            ]
          )
          updated++
        } else {
          // Verificar si el contacto existe (si no, descargarlo desde HighLevel)
          if (invoiceData.contact_id) {
            const contactAvailable = await ensureLocalContactForInvoice(ghlClient, invoiceData.contact_id)

            if (!contactAvailable) {
              logger.warn(`⚠️ Ignorando invoice ${ghlInvoiceId}: contacto ${invoiceData.contact_id} no existe en HighLevel ni localmente`)
              skipped++
              continue
            }
          }

          // Crear nuevo invoice en BD
          await db.run(
            `INSERT INTO payments (
              id, contact_id, amount, currency, status, payment_method, payment_mode,
              reference, title, description, date, ghl_invoice_id, invoice_number,
              due_date, sent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              ghlInvoiceId,
              invoiceData.contact_id,
              invoiceData.amount,
              invoiceData.currency,
              invoiceData.status,
              invoiceData.payment_method,
              invoiceData.payment_mode,
              invoiceData.reference,
              invoiceData.title,
              invoiceData.description,
              invoiceData.date,
              invoiceData.ghl_invoice_id,
              invoiceData.invoice_number,
              invoiceData.due_date,
              invoiceData.sent_at
            ]
          )
          created++
        }

        const savedInvoiceData = { ...invoiceData, status: savedInvoiceStatus }

        await updateSyncedInvoiceContactStats({
          existing,
          contactId: invoiceData.contact_id,
          previousStatus: existing?.status,
          nextStatus: savedInvoiceStatus
        })

        await activatePaymentFlowFromPaidInvoice(ghlInvoiceId, savedInvoiceData)

        const transitionedToPaid = invoiceData.contact_id &&
          isSuccessfulPaymentStatus(savedInvoiceStatus) &&
          existing &&
          !isSuccessfulPaymentStatus(existing.status)

        if (transitionedToPaid) {
          await triggerWhatsappFirstPurchaseEvent(invoiceData.contact_id, {
            amount: invoiceData.amount,
            currency: invoiceData.currency,
            paymentMode: invoiceData.payment_mode
          })
        }

      } catch (error) {
        logger.error(`Error procesando invoice ${invoice.id}:`, error)
        skipped++
      }
    }

    const stats = {
      totalFetched: allInvoices.length,
      created,
      updated,
      skipped
    }

    logger.success(`✅ Sincronización completa finalizada: ${JSON.stringify(stats)}`)

    return stats

  } catch (error) {
    logger.error('❌ Error en sincronización completa de invoices:', error)
    throw error
  }
}

/**
 * Sincroniza UN invoice específico desde HighLevel a BD local (upsert seguro)
 * Usado después de crear/pagar un invoice para asegurar que la BD refleja el estado real de GHL.
 * Protección anti-race condition: nunca hace downgrade de 'paid' a 'draft'.
 *
 * @param {string} invoiceId - ID del invoice en HighLevel
 * @returns {Promise<Object>} - { success, invoiceId, status }
 */
export async function syncSingleInvoice(invoiceId) {
  try {
    const ghlClient = await getGHLClient()
    const response = await ghlClient.getInvoice(invoiceId)
    const invoice = response.invoice || response

    if (!invoice || (!invoice.id && !invoice._id)) {
      throw new Error(`Invoice ${invoiceId} no encontrado en HighLevel`)
    }

    const ghlInvoiceId = invoice.id || invoice._id
    const contactId = invoice.contactDetails?.id || invoice.contactId

    const ghlStatus = mapInvoiceStatus(invoice.status)
    const invoiceNumber = invoice.invoiceNumber || null
    const importedLocalPaymentId = extractImportedLocalPaymentId(invoice)

    if (importedLocalPaymentId && !isLocalPaymentExportCandidate({ id: importedLocalPaymentId })) {
      logger.warn(`Ignorando invoice ${ghlInvoiceId}: parece duplicado creado por exportación local accidental de ${importedLocalPaymentId}`)
      return { success: true, invoiceId: ghlInvoiceId, skipped: true, reason: 'accidental_local_export_duplicate' }
    }

    const existing = await findExistingPaymentForInvoice({
      invoiceId: ghlInvoiceId,
      contactId,
      invoiceNumber,
      importedLocalPaymentId
    })

    const invoiceData = {
      contact_id: contactId || null,
      amount: invoice.total || invoice.amount || 0,
      currency: invoice.currency || 'MXN',
      status: ghlStatus,
      payment_method: invoice.paymentMode || null,
      payment_mode: getInvoicePaymentMode(invoice, existing?.payment_mode || 'live'),
      reference: invoiceNumber,
      title: getInvoiceDisplayTitle(invoice),
      description: getInvoiceDisplayDescription(invoice),
      date: invoice.createdAt || invoice.issueDate || new Date().toISOString(),
      invoice_number: invoiceNumber,
      due_date: invoice.dueDate || null,
      sent_at: invoice.sentAt || null,
    }
    let savedInvoiceStatus = invoiceData.status

    if (existing) {
      // Protección anti-race condition: si local ya tiene 'paid' y GHL aún no lo refleja,
      // conservar 'paid' solo ante estados temporales, no ante deleted/refunded/void.
      savedInvoiceStatus = resolveSyncedInvoiceStatus(existing.status, invoiceData.status)

      await db.run(
        `UPDATE payments
         SET status = ?, amount = ?, currency = ?, payment_method = ?,
             payment_mode = ?, reference = ?, title = ?, description = ?, contact_id = ?,
             ghl_invoice_id = ?, invoice_number = ?, due_date = ?, sent_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          savedInvoiceStatus,
          invoiceData.amount,
          invoiceData.currency,
          invoiceData.payment_method,
          invoiceData.payment_mode,
          invoiceData.reference,
          invoiceData.title,
          invoiceData.description,
          invoiceData.contact_id,
          ghlInvoiceId,
          invoiceData.invoice_number,
          invoiceData.due_date,
          invoiceData.sent_at,
          existing.id
        ]
      )
      logger.info(`Invoice actualizado desde GHL: ${ghlInvoiceId} (${savedInvoiceStatus})`)
    } else {
      // No existe en BD — insertar. Si el contacto no existe en contacts, guardarlo igual con contact_id null.
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          reference, title, description, date, ghl_invoice_id, invoice_number,
          due_date, sent_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          ghlInvoiceId,
          invoiceData.contact_id,
          invoiceData.amount,
          invoiceData.currency,
          invoiceData.status,
          invoiceData.payment_method,
          invoiceData.payment_mode,
          invoiceData.reference,
          invoiceData.title,
          invoiceData.description,
          invoiceData.date,
          ghlInvoiceId,
          invoiceData.invoice_number,
          invoiceData.due_date,
          invoiceData.sent_at
        ]
      )
      logger.info(`Invoice insertado desde GHL: ${ghlInvoiceId} (${invoiceData.status})`)
    }

    const savedInvoiceData = { ...invoiceData, status: savedInvoiceStatus }

    await updateSyncedInvoiceContactStats({
      existing,
      contactId: invoiceData.contact_id,
      previousStatus: existing?.status,
      nextStatus: savedInvoiceStatus
    })

    await activatePaymentFlowFromPaidInvoice(ghlInvoiceId, savedInvoiceData)

    const transitionedToPaid = invoiceData.contact_id &&
      isSuccessfulPaymentStatus(savedInvoiceStatus) &&
      existing &&
      !isSuccessfulPaymentStatus(existing.status)

    if (transitionedToPaid) {
      await triggerWhatsappFirstPurchaseEvent(invoiceData.contact_id, {
        amount: invoiceData.amount,
        currency: invoiceData.currency,
        paymentMode: invoiceData.payment_mode
      })
    }

    return { success: true, invoiceId: ghlInvoiceId, status: savedInvoiceStatus }
  } catch (error) {
    logger.error(`Error en syncSingleInvoice(${invoiceId}): ${error.message}`)
    throw error
  }
}

/**
 * Mapea el status de HighLevel a nuestros estados internos
 * @param {string} ghlStatus - Status de HighLevel
 * @returns {string} - Status interno
 */
function mapInvoiceStatus(ghlStatus) {
  const normalizedStatus = cleanString(ghlStatus).toLowerCase()

  // Mapeo directo 1:1 - mantenemos TODOS los estados de HighLevel
  const statusMap = {
    'draft': 'draft',                // Borrador
    'sent': 'sent',                  // Enviado
    'paid': 'paid',                  // Pagado
    'void': 'void',                  // Anulado
    'voided': 'void',                // Anulado (variante)
    'refunded': 'refunded',          // Reembolsado
    'partially_paid': 'partial',     // Parcialmente pagado
    'partial': 'partial',            // Parcialmente pagado (variante)
    'pending': 'pending',            // Pendiente
    'overdue': 'overdue',            // Vencido
    'deleted': 'deleted'             // Eliminado
  }

  return statusMap[normalizedStatus] || normalizedStatus || 'pending'
}

/**
 * Actualiza las estadísticas de un contacto (total_paid, purchases_count, last_purchase_date)
 * @param {string} contactId - ID del contacto
 */
async function updateContactStats(contactId) {
  try {
    // Calcular estadísticas desde los pagos (SOLO pagos exitosos, NO refunded/cancelled)
    const stats = await db.get(
      `SELECT
        SUM(amount) as total_paid,
        COUNT(*) as purchases_count,
        MAX(date) as last_purchase_date
       FROM payments
       WHERE contact_id = ?
       AND amount > 0
       AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
       AND ${nonTestPaymentCondition()}`,
      [contactId]
    )

    if (stats) {
      await db.run(
        `UPDATE contacts
         SET total_paid = ?, purchases_count = ?, last_purchase_date = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          stats.total_paid || 0,
          stats.purchases_count || 0,
          stats.last_purchase_date || null,
          contactId
        ]
      )
    }
  } catch (error) {
    logger.error(`Error actualizando stats del contacto ${contactId}:`, error)
  }
}

/**
 * Obtiene todos los invoices desde BD local con filtros opcionales
 * @param {Object} filters - Filtros opcionales
 * @param {string} filters.status - Filtrar por status
 * @param {string} filters.contactId - Filtrar por contacto
 * @param {number} filters.limit - Límite de resultados
 * @param {number} filters.offset - Offset para paginación
 * @returns {Promise<Array>} - Lista de invoices
 */
export async function getInvoicesFromDB({ status, contactId, limit = 100, offset = 0 } = {}) {
  try {
    let query = 'SELECT * FROM payments WHERE 1=1'
    const params = []

    if (status) {
      query += ' AND status = ?'
      params.push(status)
    }

    if (contactId) {
      query += ' AND contact_id = ?'
      params.push(contactId)
    }

    query += ' ORDER BY date DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)

    const invoices = await db.all(query, params)

    return invoices

  } catch (error) {
    logger.error('Error obteniendo invoices desde BD:', error)
    throw error
  }
}

/**
 * Obtiene un invoice específico por su ghl_invoice_id
 * @param {string} ghlInvoiceId - ID del invoice en HighLevel
 * @returns {Promise<Object>} - Datos del invoice
 */
export async function getInvoiceByGHLId(ghlInvoiceId) {
  try {
    const invoice = await db.get(
      'SELECT * FROM payments WHERE ghl_invoice_id = ?',
      [ghlInvoiceId]
    )

    return invoice

  } catch (error) {
    logger.error(`Error obteniendo invoice ${ghlInvoiceId}:`, error)
    throw error
  }
}
