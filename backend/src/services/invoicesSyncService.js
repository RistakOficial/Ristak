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
import { buildPhoneMatchCandidates, sanitizeContactName } from '../utils/phoneUtils.js'
import { markPaymentFlowInvoicePaid } from './paymentFlowService.js'
import {
  finalizePreparedPhoneUpsert,
  mergeContactIds,
  prepareContactPhoneUpsert,
  resolveContactIdByGhlId,
  resolveOrCreateContactForGhl
} from './contactIdentityService.js'
import {
  isSuccessfulPaymentStatus,
  triggerMetaPaymentPurchaseEvent
} from './metaConversionEventsService.js'
import {
  buildInvoiceReferenceCandidates,
  normalizeInvoiceNumber
} from '../utils/invoiceIdentity.js'
import { timestampSortExpression } from '../utils/sqlTimestampSort.js'

const PAID_INVOICE_STATUSES = new Set(['paid', 'succeeded', 'completed'])
const PAID_STATUS_DOWNGRADE_PROTECTED_STATUSES = new Set(['draft', 'sent', 'pending', 'overdue', 'payment_processing'])
const LOCAL_EXPORT_EXCLUDED_STATUSES = new Set(['deleted', 'failed', 'refunded', 'void', 'voided'])
const LOCAL_EXPORT_PAID_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'])
const LOCAL_EXPORT_ID_PREFIXES = ['manual_payment_']
const GENERIC_PAYMENT_IDENTITY_TEXTS = new Set([
  'pago',
  'payment',
  'invoice',
  'factura',
  'new invoice',
  'text2pay',
  'text2pay addi'
])
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

function normalizeLookupText(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function getMeaningfulIdentityText(value) {
  const text = normalizeLookupText(value)
  if (!text || text.length < 4 || GENERIC_PAYMENT_IDENTITY_TEXTS.has(text)) return ''
  return text
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))]
}

function buildPaymentIdentityTexts({ invoiceNumber, reference, title, description } = {}) {
  const normalizedInvoiceNumber = normalizeInvoiceNumber(invoiceNumber)
  const invoiceCandidates = normalizedInvoiceNumber
    ? buildInvoiceReferenceCandidates(normalizedInvoiceNumber).map(normalizeLookupText)
    : []

  return uniq([
    ...invoiceCandidates,
    getMeaningfulIdentityText(reference),
    getMeaningfulIdentityText(title),
    getMeaningfulIdentityText(description)
  ])
}

function rowMatchesIdentityTexts(row = {}, identityTexts = []) {
  if (!identityTexts.length) return false

  const rowTexts = buildPaymentIdentityTexts({
    invoiceNumber: row.invoice_number,
    reference: row.reference,
    title: row.title,
    description: row.description
  })

  return rowTexts.some(text => identityTexts.includes(text))
}

function localExportPrefixWhere(column = 'id') {
  return `(${LOCAL_EXPORT_ID_PREFIXES.map(() => `${column} LIKE ?`).join(' OR ')})`
}

function localExportPrefixParams() {
  return LOCAL_EXPORT_ID_PREFIXES.map(prefix => `${prefix}%`)
}

async function getEquivalentContactIdsForPayment(payment = {}) {
  const contactIds = new Set()
  const addContactId = (value) => {
    const id = cleanString(value)
    if (id) contactIds.add(id)
  }

  const localContactId = cleanString(payment.contact_local_id || payment.contact_id)
  const explicitGhlContactId = cleanString(payment.contact_ghl_id || payment.ghl_contact_id)
  addContactId(localContactId)
  addContactId(explicitGhlContactId)

  let contactRow = null
  if (localContactId) {
    contactRow = await db.get(
      'SELECT id, ghl_contact_id, email, phone FROM contacts WHERE id = ? LIMIT 1',
      [localContactId]
    ).catch(() => null)
  }

  const email = cleanString(payment.contact_email || contactRow?.email).toLowerCase()
  const phoneCandidates = buildPhoneMatchCandidates(payment.contact_phone || contactRow?.phone)
  const linkedGhlContactId = cleanString(explicitGhlContactId || contactRow?.ghl_contact_id)
  addContactId(contactRow?.id)
  addContactId(linkedGhlContactId)

  const filters = []
  const params = []

  if (localContactId) {
    filters.push('contacts.id = ?')
    params.push(localContactId)
  }

  if (linkedGhlContactId) {
    filters.push('(contacts.id = ? OR contacts.ghl_contact_id = ?)')
    params.push(linkedGhlContactId, linkedGhlContactId)
  }

  if (email) {
    filters.push("LOWER(COALESCE(contacts.email, '')) = ?")
    params.push(email)
  }

  if (phoneCandidates.length) {
    const phonePlaceholders = phoneCandidates.map(() => '?').join(', ')
    filters.push(`(contacts.phone IN (${phonePlaceholders}) OR cpn.phone IN (${phonePlaceholders}))`)
    params.push(...phoneCandidates, ...phoneCandidates)
  }

  if (!filters.length) return [...contactIds]

  const rows = await db.all(
    `SELECT DISTINCT contacts.id, contacts.ghl_contact_id
     FROM contacts
     LEFT JOIN contact_phone_numbers cpn ON cpn.contact_id = contacts.id
     WHERE ${filters.join(' OR ')}`,
    params
  ).catch(() => [])

  for (const row of rows) {
    addContactId(row.id)
    addContactId(row.ghl_contact_id)
  }

  return [...contactIds]
}

function preserveLocalPaymentProviderSql() {
  const prefix = `${LOCAL_EXPORT_ID_PREFIXES[0]}%`
  return `CASE
    WHEN id LIKE '${prefix}' THEN COALESCE(payment_provider, 'manual')
    WHEN payment_provider = 'stripe' THEN payment_provider
    ELSE 'highlevel'
  END`
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
    "COALESCE(p.payment_provider, 'manual') = 'manual'",
    localExportPrefixWhere('p.id')
  ]
  const params = localExportPrefixParams()

  if (paymentId) {
    filters.push('p.id = ?')
    params.push(paymentId)
  }

  const rows = await db.all(
    `SELECT
       p.*,
       c.id as contact_local_id,
       c.ghl_contact_id as contact_ghl_id,
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
  const ghlContactId = highLevelContact.id || highLevelContact._id
  if (!ghlContactId) throw new Error('HighLevel no devolvió id de contacto')

  // El contacto conserva su ID local de Ristak; el ID de GHL solo se liga en
  // ghl_contact_id. Si otro contacto local ya estaba ligado a ese ID de GHL,
  // se fusiona conservando el contacto del pago.
  let targetId = localContact.contact_local_id || localContact.contact_id || null
  const alreadyLinkedId = await resolveContactIdByGhlId(ghlContactId)

  if (!targetId) {
    targetId = alreadyLinkedId
  } else if (alreadyLinkedId && alreadyLinkedId !== targetId) {
    targetId = await mergeContactIds({
      fromId: alreadyLinkedId,
      toId: targetId,
      canonicalPhone: cleanString(localContact.contact_phone) || null
    })
  }

  if (!targetId) {
    const { contactId: createdId } = await resolveOrCreateContactForGhl({
      ghlContactId,
      phone: highLevelContact.phone || localContact.contact_phone,
      email: highLevelContact.email || localContact.contact_email,
      fullName: highLevelContact.name || highLevelContact.contactName || localContact.contact_name,
      source: localContact.contact_source || highLevelContact.source || 'ristak',
      createdAt: localContact.contact_created_at || null
    })
    targetId = createdId
  }

  const email = cleanString(highLevelContact.email || localContact.contact_email) || null
  const phone = cleanString(highLevelContact.phone || localContact.contact_phone) || null
  // Nunca guardar el teléfono (ni el email) como nombre del contacto
  const fullName = sanitizeContactName(highLevelContact.contactName, phone) ||
    sanitizeContactName(`${highLevelContact.firstName || ''} ${highLevelContact.lastName || ''}`.trim(), phone) ||
    sanitizeContactName(highLevelContact.name, phone) ||
    sanitizeContactName(localContact.contact_name, phone) ||
    ''
  const firstName = sanitizeContactName(highLevelContact.firstName, phone) ||
    sanitizeContactName(localContact.first_name, phone) ||
    cleanString(fullName.split(' ')[0])
  const lastName = sanitizeContactName(highLevelContact.lastName, phone) ||
    sanitizeContactName(localContact.last_name, phone) ||
    cleanString(fullName.split(' ').slice(1).join(' '))
  const phoneUpsert = await prepareContactPhoneUpsert({ contactId: targetId, phone })
  const emailMergeFromContactId = await clearConflictingContactEmail({ targetId, email })

  try {
    await db.run(`
      UPDATE contacts SET
        ghl_contact_id = ?,
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        full_name = COALESCE(?, full_name),
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        source = COALESCE(NULLIF(source, ''), ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      ghlContactId,
      phoneUpsert.phone || phone || null,
      email,
      fullName || null,
      firstName || null,
      lastName || null,
      localContact.contact_source || highLevelContact.source || 'ristak',
      targetId
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

  return { localContactId: targetId, ghlContactId }
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

async function findUnlinkedLocalPaymentForInvoice({ contactId, ghlContactId, amount, invoiceNumber, reference, title, description } = {}) {
  if (!contactId || !(Number(amount) > 0)) return null

  const identityTexts = buildPaymentIdentityTexts({ invoiceNumber, reference, title, description })
  if (!identityTexts.length) return null

  const contactCandidates = await getEquivalentContactIdsForPayment({
    contact_id: contactId,
    contact_ghl_id: ghlContactId
  })
  if (!contactCandidates.length) return null
  const contactPlaceholders = contactCandidates.map(() => '?').join(', ')

  const rows = await db.all(
    `SELECT id, contact_id, status, payment_method, payment_mode, payment_provider,
            reference, title, description, ghl_invoice_id, invoice_number
     FROM payments
     WHERE contact_id IN (${contactPlaceholders})
       AND (ghl_invoice_id IS NULL OR ghl_invoice_id = '')
       AND COALESCE(payment_provider, 'manual') = 'manual'
       AND ${localExportPrefixWhere('id')}
       AND ABS(COALESCE(amount, 0) - ?) < 0.005
     ORDER BY created_at DESC
     LIMIT 25`,
    [...contactCandidates, ...localExportPrefixParams(), Number(amount)]
  )

  return rows.find(row => {
    const status = cleanString(row.status).toLowerCase()
    return !LOCAL_EXPORT_EXCLUDED_STATUSES.has(status) && rowMatchesIdentityTexts(row, identityTexts)
  }) || null
}

async function findHighLevelMirrorForLocalPayment(payment = {}) {
  const contactId = payment.contact_local_id || payment.contact_id
  if (!contactId || !(Number(payment.amount) > 0)) return null

  const identityTexts = buildPaymentIdentityTexts({
    invoiceNumber: payment.invoice_number,
    reference: payment.reference,
    title: payment.title,
    description: payment.description
  })
  if (!identityTexts.length) return null

  const contactCandidates = await getEquivalentContactIdsForPayment(payment)
  if (!contactCandidates.length) return null
  const contactPlaceholders = contactCandidates.map(() => '?').join(', ')

  const rows = await db.all(
    `SELECT id, contact_id, amount, status, payment_method, payment_mode, payment_provider,
            reference, title, description, ghl_invoice_id, invoice_number
     FROM payments
     WHERE id != ?
       AND contact_id IN (${contactPlaceholders})
       AND COALESCE(ghl_invoice_id, '') != ''
       AND COALESCE(payment_provider, 'highlevel') != 'stripe'
       AND ABS(COALESCE(amount, 0) - ?) < 0.005
     ORDER BY created_at DESC
     LIMIT 25`,
    [payment.id, ...contactCandidates, Number(payment.amount)]
  )

  return rows.find(row => {
    const status = cleanString(row.status).toLowerCase()
    return !LOCAL_EXPORT_EXCLUDED_STATUSES.has(status) && rowMatchesIdentityTexts(row, identityTexts)
  }) || null
}

async function linkLocalPaymentToHighLevelMirror({ payment, mirror }) {
  const ghlInvoiceId = mirror.ghl_invoice_id || mirror.id
  const nextStatus = resolveSyncedInvoiceStatus(payment.status, mirror.status)
  const localContactId = payment.contact_local_id || payment.contact_id || mirror.contact_id

  await db.run(
    `UPDATE payments
     SET contact_id = COALESCE(contact_id, ?),
         status = ?,
         payment_method = COALESCE(payment_method, ?),
         payment_mode = COALESCE(payment_mode, ?),
         ghl_invoice_id = ?,
         invoice_number = COALESCE(invoice_number, ?),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      localContactId,
      nextStatus,
      mirror.payment_method || payment.payment_method || null,
      mirror.payment_mode || payment.payment_mode || null,
      ghlInvoiceId,
      mirror.invoice_number || null,
      payment.id
    ]
  )

  if (mirror.id && mirror.id !== payment.id) {
    await db.run('DELETE FROM payments WHERE id = ?', [mirror.id])
  }

  if (localContactId) {
    await updateContactStats(localContactId)
  }

  return {
    paymentId: payment.id,
    contactId: localContactId,
    invoiceId: ghlInvoiceId,
    invoiceNumber: mirror.invoice_number || null,
    linkedDuplicate: true
  }
}

async function exportSingleLocalPaymentToHighLevel({ client, payment, context }) {
  const existingMirror = await findHighLevelMirrorForLocalPayment(payment)
  if (existingMirror) {
    logger.info(`Pago local ${payment.id} enlazado a invoice HighLevel existente ${existingMirror.ghl_invoice_id || existingMirror.id}; no se exporta duplicado`)
    return linkLocalPaymentToHighLevelMirror({ payment, mirror: existingMirror })
  }

  // El payload remoto usa el ID de GHL; los registros locales conservan el ID Ristak.
  const { localContactId, ghlContactId } = await ensureHighLevelContactForLocalPayment(client, payment)
  const paymentMode = normalizeLocalPaymentMode(payment.payment_mode, context.paymentMode)
  const paymentContext = {
    ...context,
    liveMode: paymentMode === 'live',
    paymentMode
  }
  const invoicePayload = buildInvoicePayloadForLocalPayment({ payment, contactId: ghlContactId, context: paymentContext })
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
    [localContactId, ghlInvoiceId, invoiceNumber, paymentMode, payment.id]
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

  await updateContactStats(localContactId)

  return {
    paymentId: payment.id,
    contactId: localContactId,
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
    logger.info(`Sin integración opcional de HighLevel; los pagos locales siguen disponibles en Ristak: ${error.message}`)
    return { total: 0, exported: 0, linkedDuplicates: 0, failed: 0, skippedNoConfig: true, errors: [] }
  }

  const localPayments = await getLocalPaymentsPendingHighLevel({ paymentId, limit })
  if (!localPayments.length) {
    return { total: 0, exported: 0, linkedDuplicates: 0, failed: 0, skippedNoConfig: false, errors: [] }
  }

  const context = await getLocalPaymentExportContext()
  const errors = []
  let exported = 0
  let linkedDuplicates = 0

  logger.info(`Exportando ${localPayments.length} pagos locales pendientes a HighLevel...`)

  for (const payment of localPayments) {
    try {
      const result = await exportSingleLocalPaymentToHighLevel({ client, payment, context })
      if (result?.linkedDuplicate) {
        linkedDuplicates += 1
      } else {
        exported += 1
      }
    } catch (error) {
      errors.push({ paymentId: payment.id, error: error.message })
      logger.warn(`No se pudo exportar pago local ${payment.id} a HighLevel: ${error.message}`)
    }
  }

  return {
    total: localPayments.length,
    exported,
    linkedDuplicates,
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
  if (!contactId) return null

  const resolved = await resolveContactIdByGhlId(contactId)
  if (resolved) return resolved

  const usePostgres = Boolean(process.env.DATABASE_URL)
  const ensured = await ensureContactExists(contactId, ghlClient.apiToken, usePostgres, ghlClient.locationId)
  return ensured.localContactId || null
}

async function findExistingPaymentForInvoice({
  invoiceId,
  contactId,
  ghlContactId = null,
  invoiceNumber,
  importedLocalPaymentId = null,
  amount,
  reference,
  title,
  description
}) {
  if (importedLocalPaymentId) {
    const existingImportedLocal = await db.get(
      'SELECT id, contact_id, status, payment_mode, payment_provider, ghl_invoice_id FROM payments WHERE id = ? LIMIT 1',
      [importedLocalPaymentId]
    )

    if (existingImportedLocal) return existingImportedLocal
  }

  // DB-006: pre-check por ghl_invoice_id ANTES de cualquier INSERT de invoice HL.
  // Si ya existe una fila con este ghl_invoice_id (sin importar contacto), la
  // reusamos para derivar a UPDATE en vez de crear un duplicado. Cubre los 3
  // INSERT de este servicio (importación masiva y syncSingleInvoice).
  const existingByInvoiceId = await db.get(
    'SELECT id, contact_id, status, payment_mode, payment_provider, ghl_invoice_id FROM payments WHERE ghl_invoice_id = ? OR id = ? LIMIT 1',
    [invoiceId, invoiceId]
  )

  if (existingByInvoiceId) return existingByInvoiceId

  if (!contactId) return null

  const normalizedInvoiceNumber = normalizeInvoiceNumber(invoiceNumber)
  const contactCandidates = await getEquivalentContactIdsForPayment({
    contact_id: contactId,
    contact_ghl_id: ghlContactId
  })
  if (!contactCandidates.length) return null
  const contactPlaceholders = contactCandidates.map(() => '?').join(', ')

  if (normalizedInvoiceNumber) {
    const referenceCandidates = buildInvoiceReferenceCandidates(normalizedInvoiceNumber)
    const referencePlaceholders = referenceCandidates.map(() => '?').join(', ')
    const normalizedCandidates = referenceCandidates.map(value => value.toLowerCase())

    const existingByReference = await db.get(
      `SELECT id, contact_id, status, payment_mode, payment_provider, ghl_invoice_id
       FROM payments
       WHERE contact_id IN (${contactPlaceholders})
         AND (
           LOWER(COALESCE(invoice_number, '')) IN (${referencePlaceholders})
           OR LOWER(COALESCE(reference, '')) IN (${referencePlaceholders})
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [...contactCandidates, ...normalizedCandidates, ...normalizedCandidates]
    )

    if (existingByReference) return existingByReference
  }

  return await findUnlinkedLocalPaymentForInvoice({
    contactId,
    ghlContactId,
    amount,
    invoiceNumber,
    reference,
    title,
    description
  })
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
 * @param {boolean} options.exportLocal - Si true, exporta pagos locales pendientes a HighLevel después de importar
 * @returns {Promise<Object>} - Estadísticas de sincronización
 */
export async function syncInvoices({ limit = 100, offset = 0, contactId, exportLocal = false } = {}) {
  try {
    logger.info(`Iniciando sincronización de invoices (limit: ${limit}, offset: ${offset})`)

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
        const invoiceAmount = invoice.total || invoice.amount || 0
        const invoiceTitle = getInvoiceDisplayTitle(invoice)
        const invoiceDescription = getInvoiceDisplayDescription(invoice)

        if (importedLocalPaymentId && !isLocalPaymentExportCandidate({ id: importedLocalPaymentId })) {
          logger.warn(`Ignorando invoice ${ghlInvoiceId}: parece duplicado creado por exportación local accidental de ${importedLocalPaymentId}`)
          skipped++
          continue
        }

        // Resolver el ID local de Ristak del contacto (descargándolo de GHL si
        // hace falta); los pagos siempre guardan el ID local, no el de GHL.
        const localContactId = await ensureLocalContactForInvoice(ghlClient, contactId)

        const existing = await findExistingPaymentForInvoice({
          invoiceId: ghlInvoiceId,
          contactId: localContactId || contactId,
          ghlContactId: contactId,
          invoiceNumber,
          importedLocalPaymentId,
          amount: invoiceAmount,
          reference: invoiceNumber,
          title: invoiceTitle,
          description: invoiceDescription
        })

        // PAY2-011: NUNCA escribir el ID crudo de GHL como contact_id. Si la
        // resolución a contacto local falló, dejamos contact_id en null en vez de
        // colar un locationId/ghlContactId (origen del bug que parchó la migración
        // cleanup_duplicate_payments.sql). El UPDATE de abajo conserva el contacto
        // ya enlazado vía COALESCE-equivalente (no sobrescribe con null útil).
        // Datos comunes del invoice
        const invoiceData = {
          contact_id: localContactId || null,
          amount: invoiceAmount,
          currency: invoice.currency || 'MXN',
          status: mapInvoiceStatus(invoice.status),
          payment_method: invoice.paymentMode || null,
          payment_mode: getInvoicePaymentMode(invoice, existing?.payment_mode || 'live'),
          reference: invoiceNumber,
          title: invoiceTitle,
          description: invoiceDescription,
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
          // PAY2-011: contact_id solo se actualiza si tenemos un ID local resuelto;
          // de lo contrario conservamos el contacto existente (no lo pisamos con null).
          await db.run(
            `UPDATE payments
             SET status = ?, amount = ?, currency = ?, payment_method = ?,
                 payment_provider = ${preserveLocalPaymentProviderSql()},
                 payment_mode = ?, reference = ?, title = ?, description = ?,
                 contact_id = COALESCE(?, contact_id),
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
          // (si no existe localmente, ya se intentó descargar desde HighLevel)
          if (!localContactId) {
            logger.warn(`⚠️ Ignorando invoice ${ghlInvoiceId}: contacto ${contactId} no existe en HighLevel ni localmente`)
            skipped++
            continue
          }

          // Crear nuevo invoice en BD
          await db.run(
            `INSERT INTO payments (
              id, contact_id, amount, currency, status, payment_method, payment_mode,
              payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
              due_date, sent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              ghlInvoiceId, // Usar mismo ID que en HighLevel
              invoiceData.contact_id,
              invoiceData.amount,
              invoiceData.currency,
              invoiceData.status,
              invoiceData.payment_method,
              invoiceData.payment_mode,
              'highlevel',
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
          await triggerMetaPaymentPurchaseEvent(invoiceData.contact_id, {
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
      skipped,
      localExport: null
    }

    if (exportLocal && !contactId && offset === 0) {
      stats.localExport = await syncLocalPaymentsToHighLevel({ limit: 1000 })
      if (stats.localExport.exported > 0 || stats.localExport.linkedDuplicates > 0 || stats.localExport.failed > 0) {
        logger.info(`Exportación local posterior: ${stats.localExport.exported} pagos exportados, ${stats.localExport.linkedDuplicates} enlazados, ${stats.localExport.failed} fallidos`)
      }
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
 * @param {boolean} options.exportLocal - Si true, exporta pagos locales pendientes a HighLevel después de importar
 * @returns {Promise<Object>} - Estadísticas de sincronización completa
 */
export async function syncAllInvoices({ contactId, exportLocal = false } = {}) {
  try {
    logger.info('🔄 Iniciando sincronización COMPLETA de invoices desde HighLevel...')

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
        const invoiceAmount = invoice.total || invoice.amount || 0
        const invoiceTitle = getInvoiceDisplayTitle(invoice)
        const invoiceDescription = getInvoiceDisplayDescription(invoice)

        if (importedLocalPaymentId && !isLocalPaymentExportCandidate({ id: importedLocalPaymentId })) {
          logger.warn(`Ignorando invoice ${ghlInvoiceId}: parece duplicado creado por exportación local accidental de ${importedLocalPaymentId}`)
          skipped++
          continue
        }

        // Resolver antes de buscar duplicados: los webhooks guardan el ID local.
        const localContactId = await ensureLocalContactForInvoice(ghlClient, contactId)

        const existing = await findExistingPaymentForInvoice({
          invoiceId: ghlInvoiceId,
          contactId: localContactId || contactId,
          ghlContactId: contactId,
          invoiceNumber,
          importedLocalPaymentId,
          amount: invoiceAmount,
          reference: invoiceNumber,
          title: invoiceTitle,
          description: invoiceDescription
        })

        if (!localContactId) {
          logger.warn(`⚠️ Ignorando invoice ${ghlInvoiceId}: contacto ${contactId} no existe en HighLevel ni localmente`)
          skipped++
          continue
        }

        // Datos comunes del invoice
        const invoiceData = {
          contact_id: localContactId,
          amount: invoiceAmount,
          currency: invoice.currency || 'MXN',
          status: mapInvoiceStatus(invoice.status),
          payment_method: invoice.paymentMode || null,
          payment_mode: getInvoicePaymentMode(invoice, existing?.payment_mode || 'live'),
          reference: invoiceNumber,
          title: invoiceTitle,
          description: invoiceDescription,
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
                 payment_provider = ${preserveLocalPaymentProviderSql()},
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
          // Crear nuevo invoice en BD
          await db.run(
            `INSERT INTO payments (
              id, contact_id, amount, currency, status, payment_method, payment_mode,
              payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
              due_date, sent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              ghlInvoiceId,
              invoiceData.contact_id,
              invoiceData.amount,
              invoiceData.currency,
              invoiceData.status,
              invoiceData.payment_method,
              invoiceData.payment_mode,
              'highlevel',
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
          await triggerMetaPaymentPurchaseEvent(invoiceData.contact_id, {
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
      skipped,
      localExport: null
    }

    if (exportLocal && !contactId) {
      stats.localExport = await syncLocalPaymentsToHighLevel({ limit: 1000 })
      if (stats.localExport.exported > 0 || stats.localExport.linkedDuplicates > 0 || stats.localExport.failed > 0) {
        logger.info(`Exportación local posterior: ${stats.localExport.exported} pagos exportados, ${stats.localExport.linkedDuplicates} enlazados, ${stats.localExport.failed} fallidos`)
      }
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
    const invoiceAmount = invoice.total || invoice.amount || 0
    const invoiceTitle = getInvoiceDisplayTitle(invoice)
    const invoiceDescription = getInvoiceDisplayDescription(invoice)

    if (importedLocalPaymentId && !isLocalPaymentExportCandidate({ id: importedLocalPaymentId })) {
      logger.warn(`Ignorando invoice ${ghlInvoiceId}: parece duplicado creado por exportación local accidental de ${importedLocalPaymentId}`)
      return { success: true, invoiceId: ghlInvoiceId, skipped: true, reason: 'accidental_local_export_duplicate' }
    }

    // Resolver el ID local de Ristak del contacto; los pagos guardan el ID local.
    const localContactId = await ensureLocalContactForInvoice(ghlClient, contactId)

    const existing = await findExistingPaymentForInvoice({
      invoiceId: ghlInvoiceId,
      contactId: localContactId || contactId,
      ghlContactId: contactId,
      invoiceNumber,
      importedLocalPaymentId,
      amount: invoiceAmount,
      reference: invoiceNumber,
      title: invoiceTitle,
      description: invoiceDescription
    })

    const invoiceData = {
      // PAY2-011: solo el ID local resuelto; nunca el ID crudo de GHL (evita
      // que un locationId/ghlContactId se guarde como contact_id).
      contact_id: localContactId || null,
      amount: invoiceAmount,
      currency: invoice.currency || 'MXN',
      status: ghlStatus,
      payment_method: invoice.paymentMode || null,
      payment_mode: getInvoicePaymentMode(invoice, existing?.payment_mode || 'live'),
      reference: invoiceNumber,
      title: invoiceTitle,
      description: invoiceDescription,
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

      // PAY2-011: contact_id vía COALESCE para no pisar con null un contacto ya
      // enlazado cuando la resolución local falla en esta corrida.
      await db.run(
        `UPDATE payments
         SET status = ?, amount = ?, currency = ?, payment_method = ?,
             payment_provider = ${preserveLocalPaymentProviderSql()},
             payment_mode = ?, reference = ?, title = ?, description = ?,
             contact_id = COALESCE(?, contact_id),
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
          payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
          due_date, sent_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          ghlInvoiceId,
          invoiceData.contact_id,
          invoiceData.amount,
          invoiceData.currency,
          invoiceData.status,
          invoiceData.payment_method,
          invoiceData.payment_mode,
          'highlevel',
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
      await triggerMetaPaymentPurchaseEvent(invoiceData.contact_id, {
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

export const __invoicesSyncTestHooks = {
  findExistingPaymentForInvoice,
  findHighLevelMirrorForLocalPayment,
  linkLocalPaymentToHighLevelMirror
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

    query += ` ORDER BY ${timestampSortExpression('date')} DESC, ${timestampSortExpression('created_at')} DESC, id DESC LIMIT ? OFFSET ?`
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
