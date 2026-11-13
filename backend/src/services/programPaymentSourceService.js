import crypto from 'node:crypto'
import { parseStoredUtcDateTime } from '../utils/storedUtcDateTime.js'
import { SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'

const SUCCESS_STATUSES = new Set(SUCCESS_PAYMENT_STATUSES)
const LIVE_MODES = new Set(['live', 'production', 'prod'])
const TEST_MODES = new Set(['test', 'testing', 'sandbox', 'demo'])
const PRODUCT_KEYS = new Set(['productid', 'localproductid', 'ghlproductid'])
const PRICE_KEYS = new Set(['priceid', 'localpriceid', 'ghlpriceid'])
const PRODUCT_LIST_KEYS = new Set(['productids', 'localproductids', 'ghlproductids'])
const PRICE_LIST_KEYS = new Set(['priceids', 'localpriceids', 'ghlpriceids'])
const MODE_KEYS = new Set(['paymentmode', 'stripemode', 'conektamode', 'rebillmode', 'mercadopagomode', 'ghlinvoicemode', 'highlevelmode'])
const PROVIDER_KEYS = new Set(['stripe', 'conekta', 'rebill', 'mercadopago', 'highlevel', 'ghl', 'payment'])
const PLAN_STATUSES = new Set([
  'active', 'paused', 'completed', 'overdue', 'overdue_review', 'offline_plan_active', 'offline_plan_paused',
  'mercadopago_plan_active', 'first_payment_pending', 'first_payment_registered', 'offline_payment_registered',
  'card_setup_link_sent', 'waiting_card_authorization', 'card_authorized', 'installment_plan_created', 'installment_plan_active'
])
const INSTALLMENT_STATUSES = new Set([
  ...SUCCESS_PAYMENT_STATUSES, 'registered', 'scheduled', 'pending', 'sent', 'waiting_card_authorization', 'pending_card',
  'processing', 'in_process', 'in_mediation', 'pending_customer_charge', 'authorized', 'captured', 'accredited', 'approved',
  'requires_action', 'requires_payment_method', 'requires_confirmation', 'requires_capture',
  'overdue', 'overdue_review', 'failed', 'failure', 'declined', 'rejected', 'error', 'refunded', 'partially_refunded',
  'chargeback', 'charged_back', 'disputed', 'void', 'voided', 'cancelled', 'canceled', 'deleted', 'cancelled_before_start'
])
const STORED_JSON_COLUMNS = new Set(['metadata', 'metadata_json', 'raw_json'])

function text(value) {
  return value == null ? '' : String(value).trim()
}

function key(value) {
  return String(value).replace(/_/g, '').toLowerCase()
}

function stableValue(value, field = '') {
  if (typeof value === 'string' && STORED_JSON_COLUMNS.has(field)) {
    try { return stableValue(JSON.parse(value)) } catch { return value }
  }
  if (value instanceof Date || value != null && (field === 'date' || /_(?:at|date)$/.test(field))) {
    if (isBusinessDate(value)) return value.trim()
    const parsed = parseStoredUtcDateTime(value)
    if (parsed) return parsed.toISO()
    if (value instanceof Date) return 'invalid_date'
  }
  if (Array.isArray(value)) return value.map(item => stableValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, stableValue(value[name], name)]))
  }
  return value === undefined ? null : value
}

function revisionFor(value) {
  value.catalog?.sort((left, right) => `${left.type}:${left.reference}`.localeCompare(`${right.type}:${right.reference}`))
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function parseMetadata(value, block) {
  if (value == null || value === '') return {}
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { block('invalid_metadata'); return {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    block('invalid_metadata')
    return {}
  }
  return parsed
}

function normalizedEmail(value) {
  return text(value).toLowerCase()
}

function inactiveContact(row) {
  const flag = value => value === true || value === 1 || value === '1' || value === 'true'
  return Boolean(row.deleted_at || row.archived_at || flag(row.archived) || flag(row.is_archived)
    || flag(row.deleted) || flag(row.is_deleted) || ['archived', 'deleted'].includes(text(row.status).toLowerCase()))
}

function explicitMode(value) {
  const mode = text(value).toLowerCase()
  if (LIVE_MODES.has(mode)) return 'live'
  if (TEST_MODES.has(mode)) return 'test'
  return null
}

function booleanMode(value, inverse = false) {
  let normalized
  if (typeof value === 'boolean') normalized = value
  else if (typeof value === 'string' || typeof value === 'number') {
    switch (text(value).toLowerCase()) {
      case 'true': case '1': normalized = true; break
      case 'false': case '0': normalized = false; break
      default: return null
    }
  } else return null
  return normalized !== inverse ? 'live' : 'test'
}

function metadataModes(metadata) {
  const modes = []
  function visit(object, root = false, provider = false) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return
    for (const [name, value] of Object.entries(object)) {
      const normalized = key(name)
      if (MODE_KEYS.has(normalized) || (root || provider) && ['mode', 'environment', 'env'].includes(normalized)) modes.push(explicitMode(value))
      else if (['livemode', 'islivemode'].includes(normalized)) modes.push(booleanMode(value))
      else if (['testmode', 'istestmode'].includes(normalized)) modes.push(booleanMode(value, true))
      if (value && typeof value === 'object' && !Array.isArray(value)) visit(value, false, PROVIDER_KEYS.has(normalized))
    }
  }
  visit(metadata, true)
  return modes
}

function sourceMode(metadata, storedMode, requireStored, block) {
  const modes = metadataModes(metadata)
  if (requireStored) modes.unshift(explicitMode(storedMode))
  if (!modes.length || modes.includes(null)) { block('payment_mode_unknown'); return null }
  if (new Set(modes).size !== 1) { block('payment_mode_conflict'); return null }
  if (modes[0] !== 'live') block('payment_mode_test')
  return modes[0]
}

function isBusinessDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

function storedInstant(value, block) {
  if (value == null || value === '') return null
  if (isBusinessDate(value)) { block('invalid_timestamp'); return null }
  const parsed = parseStoredUtcDateTime(value)
  if (!parsed) { block('invalid_timestamp'); return null }
  return parsed.toISO()
}

function dueDateSnapshot(value, block) {
  if (value == null || value === '') return { dueDate: null, dueDateKind: null }
  if (isBusinessDate(value)) {
    const date = value.trim()
    const parsed = parseStoredUtcDateTime(date)
    if (!parsed || parsed.toISODate() !== date) {
      block('invalid_timestamp')
      return { dueDate: null, dueDateKind: null }
    }
    return { dueDate: date, dueDateKind: 'business_date' }
  }
  const dueDate = storedInstant(value, block)
  return { dueDate, dueDateKind: dueDate ? 'utc_instant' : null }
}

function relatedSources(references) {
  const unique = new Map(references.map(reference => [`${reference.sourceType}:${reference.sourceId}`, reference]))
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, reference]) => reference)
}

async function paymentParentRelations(database, paymentId) {
  const firstParents = await database.all('SELECT id FROM payment_flows WHERE first_payment_invoice_id = ? ORDER BY id ASC', [paymentId])
  const installmentParents = await database.all('SELECT * FROM installment_payments WHERE payment_id = ? ORDER BY flow_id ASC, id ASC', [paymentId])
  const parentIds = [...new Set([...firstParents.map(row => row.id), ...installmentParents.map(row => row.flow_id)].map(text).filter(Boolean))].sort()
  return { paymentId, firstParents, installmentParents, parentIds }
}

function amountString(value) {
  return value == null ? null : String(value)
}

function sourceTable(sourceType) {
  if (sourceType === 'payment') return 'payments'
  if (sourceType === 'plan') return 'payment_flows'
  throw Object.assign(new Error('sourceType debe ser payment o plan.'), { status: 400, code: 'invalid_program_payment_source' })
}

// Resolve every explicit reference, rather than selecting the first convenient
// alias. A conflicting price/product pair must never turn into an entitlement.
async function resolveProducts(database, documents, evidence, block) {
  const productIds = new Set()
  const cache = new Map()
  async function lookup(type, value) {
    if (typeof value !== 'string' || !value.trim()) { block('invalid_product_reference'); return null }
    const id = value.trim()
    const cacheKey = `${type}:${id}`
    if (!cache.has(cacheKey)) {
      const table = type === 'product' ? 'products' : 'product_prices'
      const remoteColumn = type === 'product' ? 'ghl_product_id' : 'ghl_price_id'
      const rows = await database.all(`SELECT * FROM ${table} WHERE id = ? OR ${remoteColumn} = ? ORDER BY id ASC`, [id, id])
      evidence.catalog.push({ type, reference: id, rows })
      if (rows.length !== 1) {
        block(rows.length ? 'ambiguous_product_reference' : 'unresolved_product_reference')
        cache.set(cacheKey, null)
      } else cache.set(cacheKey, rows[0])
    }
    return cache.get(cacheKey)
  }
  async function resolveObject(object, depth = 0) {
    if (depth > 32) { block('invalid_product_reference'); return }
    if (!object || typeof object !== 'object' || object instanceof Date) return
    if (Array.isArray(object)) {
      for (const item of object) await resolveObject(item, depth + 1)
      return
    }
    const references = { product: [], price: [] }
    const append = (type, value) => {
      if (value === undefined || value === null || value === '') return
      references[type].push(value)
    }
    for (const [name, value] of Object.entries(object)) {
      const normalized = key(name)
      if (PRODUCT_KEYS.has(normalized)) append('product', value)
      else if (PRICE_KEYS.has(normalized)) append('price', value)
      else if (PRODUCT_LIST_KEYS.has(normalized) || PRICE_LIST_KEYS.has(normalized)) {
        const type = PRODUCT_LIST_KEYS.has(normalized) ? 'product' : 'price'
        if (!Array.isArray(value)) block('invalid_product_reference')
        else for (const id of value) append(type, id)
      } else if (normalized === 'product' || normalized === 'price') {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const id of [value.id, value.localId, value.local_id, value.ghlId, value.ghl_id]) append(normalized, id)
        }
        else append(normalized, value)
      }
    }
    const resolvedProducts = new Set()
    const resolvedPrices = new Set()
    for (const id of references.product) {
      const product = await lookup('product', id)
      if (product) { resolvedProducts.add(product.id); productIds.add(product.id) }
    }
    for (const id of references.price) {
      const price = await lookup('price', id)
      if (!price) continue
      resolvedPrices.add(price.id)
      const product = await lookup('product', price.product_id)
      if (product) { resolvedProducts.add(product.id); productIds.add(product.id) }
      else block('unresolved_product_reference')
    }
    if (resolvedProducts.size > 1 || resolvedPrices.size > 1) block('conflicting_product_references')
    for (const value of Object.values(object)) {
      if (value && typeof value === 'object') await resolveObject(value, depth + 1)
    }
  }
  for (const document of documents) await resolveObject(document)
  if (productIds.size > 1) block('mixed_products')
  return [...productIds].sort()
}

/** Read-only commercial evidence. This does not charge, infer debt or grant access. */
export async function loadProgramPaymentSource(database, { sourceType, sourceId } = {}) {
  const table = sourceTable(sourceType)
  const id = text(sourceId)
  if (typeof sourceId !== 'string' || !id) throw Object.assign(new Error('sourceId es obligatorio.'), { status: 400, code: 'invalid_program_payment_source' })
  let blockedReason = null
  const block = reason => { blockedReason ||= reason }
  const source = await database.get(`SELECT * FROM ${table} WHERE id = ?`, [id])
  const evidence = { sourceType, sourceId: id, source: source || null, contact: null, emailMatches: [], installments: [], linkedPayments: [], catalog: [] }
  const result = { sourceType, sourceId: id, contactId: text(source?.contact_id), email: '', productIds: [], relatedSources: [], parentSource: null, blockedReason: null, description: '', revision: '', summary: {} }
  if (!source) {
    return { ...result, blockedReason: 'source_not_found', revision: revisionFor(evidence) }
  }
  const metadata = parseMetadata(sourceType === 'payment' ? source.metadata_json : source.metadata, block)
  const documents = [source, metadata]
  const contact = result.contactId ? await database.get('SELECT * FROM contacts WHERE id = ?', [result.contactId]) : null
  evidence.contact = contact || null
  if (!contact) block('contact_not_found')
  else {
    if (inactiveContact(contact)) block('contact_inactive')
    result.email = normalizedEmail(contact.email)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) block('contact_email_invalid')
    else {
      const matches = await database.all('SELECT * FROM contacts WHERE LOWER(TRIM(email)) = ? ORDER BY id ASC', [result.email])
      evidence.emailMatches = matches
      const active = matches.filter(row => !inactiveContact(row))
      if (active.length !== 1 || active[0].id !== contact.id) block('contact_email_ambiguous')
    }
    if (sourceType === 'plan' && text(source.contact_email) && normalizedEmail(source.contact_email) !== result.email) block('contact_email_conflict')
  }
  const paymentMode = sourceMode(metadata, source.payment_mode, sourceType === 'payment', block)
  const currency = text(source.currency).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) block('currency_unknown')
  result.description = [...new Set((sourceType === 'payment'
    ? [source.title, source.description]
    : [source.concept, metadata.title, metadata.description, metadata.invoiceTitle, metadata.invoiceDescription,
        metadata.invoicePayload?.title, metadata.invoicePayload?.description])
    .map(text).filter(Boolean))].join('\n')
  if (sourceType === 'payment') {
    const status = text(source.status).toLowerCase()
    if (!SUCCESS_STATUSES.has(status)) block('payment_not_successful')
    result.summary = {
      status, paymentMode, currency,
      amount: amountString(source.amount),
      paidAt: storedInstant(source.paid_at, block),
      ...dueDateSnapshot(source.due_date, block)
    }
  } else {
    const status = text(source.current_state).toLowerCase()
    if (!PLAN_STATUSES.has(status)) block('plan_status_not_eligible')
    const installments = await database.all('SELECT * FROM installment_payments WHERE flow_id = ? ORDER BY sequence ASC, id ASC', [id])
    evidence.installments = installments
    const linkedIds = [...new Set([source.first_payment_invoice_id, ...installments.map(row => row.payment_id)].map(text).filter(Boolean))].sort()
    const paymentsById = new Map()
    for (const paymentId of linkedIds) {
      const payment = await database.get('SELECT * FROM payments WHERE id = ?', [paymentId])
      evidence.linkedPayments.push({ paymentId, row: payment || null })
      if (!payment) { block('linked_payment_unresolved'); continue }
      paymentsById.set(payment.id, payment)
      const relations = await paymentParentRelations(database, payment.id)
      evidence.linkedPaymentParents ||= []
      evidence.linkedPaymentParents.push(relations)
      if (relations.parentIds.length !== 1 || relations.parentIds[0] !== id) block('payment_plan_ambiguous')
      const paymentMetadata = parseMetadata(payment.metadata_json, block)
      documents.push(payment, paymentMetadata)
      if (!INSTALLMENT_STATUSES.has(text(payment.status).toLowerCase())) block('linked_payment_status_unknown')
      if (text(payment.contact_id) !== result.contactId) block('linked_payment_contact_conflict')
      if (text(payment.currency).toUpperCase() !== currency) block('linked_payment_currency_conflict')
      if (sourceMode(paymentMetadata, payment.payment_mode, true, block) !== paymentMode) block('payment_mode_conflict')
      if (paymentMetadata.paymentPlan?.flowId && paymentMetadata.paymentPlan.flowId !== id) block('linked_payment_plan_conflict')
    }
    result.relatedSources = relatedSources([...paymentsById.keys()].map(sourceId => ({ sourceType: 'payment', sourceId })))
    for (const installment of installments) {
      if (!INSTALLMENT_STATUSES.has(text(installment.status).toLowerCase())) block('installment_status_unknown')
      const payment = paymentsById.get(installment.payment_id)
      if (!payment) continue
      const paymentMetadata = parseMetadata(payment.metadata_json, block)
      if (paymentMetadata.paymentPlan?.installmentId && paymentMetadata.paymentPlan.installmentId !== installment.id) block('linked_payment_installment_conflict')
    }
    const hasFirstPayment = Boolean(source.first_payment_invoice_id || Number(source.first_payment_amount) > 0)
    if (hasFirstPayment && !INSTALLMENT_STATUSES.has(text(source.first_payment_status).toLowerCase())) block('first_payment_status_unknown')
    result.summary = {
      status, paymentMode, currency,
      totalAmount: amountString(source.total_amount),
      firstPayment: hasFirstPayment ? {
        paymentId: text(source.first_payment_invoice_id) || null,
        status: text(source.first_payment_status),
        amount: amountString(source.first_payment_amount),
        ...dueDateSnapshot(source.first_payment_date, block)
      } : null,
      installments: installments.map(row => ({
        id: row.id, sequence: row.sequence, paymentId: text(row.payment_id) || null,
        status: text(row.status), amount: amountString(row.amount),
        ...dueDateSnapshot(row.due_date, block)
      }))
    }
  }
  result.productIds = await resolveProducts(database, documents, evidence, block)
  if (sourceType === 'payment') {
    // Only the stored plan/instalment relationships establish parentage. A
    // contact, description or metadata hint cannot attach an unrelated payment.
    const relations = await paymentParentRelations(database, id)
    evidence.parentRelations = relations
    const { parentIds } = relations
    if (parentIds.length > 1) block('payment_plan_ambiguous')
    else if (parentIds.length === 1) {
      const parent = await loadProgramPaymentSource(database, { sourceType: 'plan', sourceId: parentIds[0] })
      result.parentSource = { sourceType: 'plan', sourceId: parent.sourceId }
      result.relatedSources = relatedSources([result.parentSource, ...parent.relatedSources]
        .filter(reference => reference.sourceType !== 'payment' || reference.sourceId !== id))
      evidence.parentSource = { ...result.parentSource, revision: parent.revision }
      if (parent.blockedReason || parent.contactId !== result.contactId || parent.email !== result.email
        || parent.summary.paymentMode !== paymentMode || parent.summary.currency !== currency) block('parent_plan_unverified')
      result.productIds = [...new Set([...result.productIds, ...parent.productIds])].sort()
      if (result.productIds.length > 1) block('mixed_products')
      result.description = [...new Set([result.description, parent.description].filter(Boolean))].join('\n')
    }
  }
  evidence.relatedSources = result.relatedSources
  result.blockedReason = blockedReason
  result.revision = revisionFor(evidence)
  return result
}

export async function listProgramPaymentSources(database, { sourceType, afterId = '', limit = 50 } = {}) {
  const table = sourceTable(sourceType)
  const requestedLimit = Number(limit)
  if (typeof limit !== 'number' || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    throw Object.assign(new Error('limit debe ser un entero entre 1 y 100.'), { status: 400, code: 'invalid_program_payment_source_limit' })
  }
  if (typeof afterId !== 'string') throw Object.assign(new Error('afterId debe ser un ID de texto.'), { status: 400, code: 'invalid_program_payment_source_cursor' })
  const cursor = text(afterId)
  const rows = await database.all(`SELECT id FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`, [cursor, requestedLimit + 1])
  const hasMore = rows.length > requestedLimit
  const items = rows.slice(0, requestedLimit).map(row => ({ sourceType, sourceId: row.id }))
  return { items, nextAfterId: hasMore ? items[items.length - 1].sourceId : null, hasMore }
}
