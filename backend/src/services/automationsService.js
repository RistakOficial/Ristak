import { db } from '../config/database.js'
import { normalizeFlow, validateFlowForPublish, START_NODE_TYPE } from './automationFlowValidation.js'
import { enrollContactManually, testWebhookAction } from './automationEngine.js'
import { findContactByPhoneCandidates, recordContactPhoneNumber } from './contactIdentityService.js'
import { getWhatsAppApiTemplates } from './whatsappApiService.js'
import { syncLocalMessageTemplateSnapshots } from './messageTemplatesService.js'
import { normalizePhoneForAccount } from '../utils/accountLocale.js'
import { serializeContactCustomFieldsForDb } from '../utils/contactCustomFields.js'
import {
  AUTOMATION_REVIEW_OK,
  getAutomationReviewStatus,
  loadAutomationReferenceCatalogs
} from './automationReferenceResolver.js'
import { CALENDAR_DEFAULT_FORM_SITE_ID } from './localCalendarService.js'
import { createRistakId } from '../utils/idGenerator.js'
import { getAccountTimezone, normalizeToUtcIso } from '../utils/dateUtils.js'

const usePostgres = !!process.env.DATABASE_URL
const flowPlaceholder = usePostgres ? '?::jsonb' : '?'

export const AUTOMATION_STATUSES = ['draft', 'published', 'paused', 'archived']

function makeId(prefix) {
  return createRistakId(prefix)
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function conflict(message) {
  const error = new Error(message)
  error.status = 409
  return error
}

function notFound(message) {
  const error = new Error(message)
  error.status = 404
  return error
}

function cleanString(value) {
  return String(value || '').trim()
}

function parseFlow(rawFlow) {
  if (!rawFlow) return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  if (typeof rawFlow === 'object') return rawFlow
  try {
    return JSON.parse(rawFlow)
  } catch {
    return { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  }
}

function sameFlow(left, right) {
  if (!left || !right) return false
  const leftFlow = normalizeFlow(left)
  const rightFlow = normalizeFlow(right)
  const comparable = (flow) => ({
    nodes: flow.nodes,
    edges: flow.edges,
    settings: flow.settings || {}
  })
  return JSON.stringify(comparable(leftFlow)) === JSON.stringify(comparable(rightFlow))
}

function mapFolderRow(row) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id || null,
    position: Number(row.position) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapAutomationRow(row, { includeFlow = false, reviewStatus = AUTOMATION_REVIEW_OK } = {}) {
  const canComparePublication = row.flow !== undefined && row.published_flow !== undefined
  const draftFlow = canComparePublication ? parseFlow(row.flow) : null
  const publishedFlow = canComparePublication && row.published_flow ? parseFlow(row.published_flow) : null
  const automation = {
    id: row.id,
    folderId: row.folder_id || null,
    name: row.name,
    description: row.description || '',
    status: row.status || 'draft',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null,
    hasUnpublishedChanges: Boolean(
      publishedFlow &&
        ['published', 'paused'].includes(row.status || 'draft') &&
        !sameFlow(draftFlow, publishedFlow)
    ),
    reviewStatus
  }

  if (includeFlow) {
    automation.flow = normalizeFlow(draftFlow || parseFlow(row.flow))
  }

  return automation
}

function getReviewFlowForAutomationRow(row) {
  const status = row.status || 'draft'
  if (!['published', 'paused'].includes(status)) return null
  return parseFlow(row.published_flow || row.flow)
}

function getReviewStatusForAutomationRow(row, catalogs) {
  const reviewFlow = getReviewFlowForAutomationRow(row)
  return reviewFlow ? getAutomationReviewStatus(reviewFlow, catalogs) : AUTOMATION_REVIEW_OK
}

function defaultFlow() {
  return {
    nodes: [
      {
        id: 'start',
        type: START_NODE_TYPE,
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: { triggers: [] }
      }
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

function normalizeName(rawName, fallback) {
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (!name && fallback !== undefined) return fallback
  if (!name) throw badRequest('El nombre es obligatorio')
  if (name.length > 120) throw badRequest('El nombre no puede superar 120 caracteres')
  return name
}

function isEmptyObject(value) {
  return !value || typeof value !== 'object' || Array.isArray(value)
    ? false
    : Object.keys(value).length === 0
}

function normalizeWebhookSample({ body, query }) {
  if (body && typeof body === 'object' && !isEmptyObject(body)) return body
  if (query && typeof query === 'object' && !isEmptyObject(query)) return query
  return {}
}

function hasWebhookSampleData(value) {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0)
}

function parseJsonSample(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function webhookResponseRoot(occurrence) {
  return `Webhook.response_${String(occurrence).padStart(2, '0')}`
}

function setOutputAtTokenRoot(ctx, root, output) {
  const segments = String(root || '').trim().split('.').filter(Boolean)
  if (segments.length === 0) return
  let target = ctx
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(target[segment])) target[segment] = {}
    target = target[segment]
  }
  target[segments[segments.length - 1]] = output
}

function hasPath(edges, from, to) {
  if (!from || !to) return false
  if (from === to) return true
  const adjacency = new Map()
  ;(Array.isArray(edges) ? edges : []).forEach((edge) => {
    const list = adjacency.get(edge.sourceNodeId) || []
    list.push(edge.targetNodeId)
    adjacency.set(edge.sourceNodeId, list)
  })

  const queue = [from]
  const visited = new Set([from])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const next of adjacency.get(current) || []) {
      if (next === to) return true
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return false
}

function exposeTestOutput(ctx, sourceId, baseId, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return
  if (!ctx.__nodeOutputs || typeof ctx.__nodeOutputs !== 'object') ctx.__nodeOutputs = {}
  if (!ctx.__outputOccurrences || typeof ctx.__outputOccurrences !== 'object') ctx.__outputOccurrences = {}

  ctx.__nodeOutputs[sourceId] = output
  const nextOccurrence = (Number(ctx.__outputOccurrences[baseId]) || 0) + 1
  ctx.__outputOccurrences[baseId] = nextOccurrence
  if (baseId === 'http_request') {
    setOutputAtTokenRoot(ctx, webhookResponseRoot(nextOccurrence), output)
  }
  const root = `${baseId}_${nextOccurrence}`
  ctx[root] = output
  if (nextOccurrence === 1 && ctx[baseId] === undefined) ctx[baseId] = output
}

function buildWebhookActionTestContext(flow, nodeId) {
  const ctx = { contact: {}, __nodeOutputs: {}, __outputOccurrences: {} }
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
  const edges = Array.isArray(flow?.edges) ? flow.edges : []
  const startNode = nodes.find((node) => node.type === START_NODE_TYPE)
  if (startNode && nodeId && hasPath(edges, startNode.id, nodeId)) {
    const triggers = Array.isArray(startNode.config?.triggers) ? startNode.config.triggers : []
    const incomingSample = triggers
      .filter((trigger) => trigger?.type === 'trigger-incoming-webhook')
      .map((trigger) => trigger?.config?.sampleResponse)
      .find(hasWebhookSampleData)
    if (incomingSample) {
      ctx.payload = incomingSample
      ctx.webhook = incomingSample
      ctx.webhook_1 = incomingSample
      ctx.phone = incomingSample.phone || incomingSample.telefono || incomingSample.teléfono || ''
      ctx.email = incomingSample.email || incomingSample.correo || ''
      ctx.contactName = incomingSample.name || incomingSample.nombre || ''
      ctx.contact = {
        fullName: ctx.contactName,
        firstName: String(ctx.contactName || '').split(' ')[0] || '',
        phone: ctx.phone,
        email: ctx.email,
        customFields: {}
      }
    }
  }

  nodes
    .filter((node) => node.id !== nodeId && node.type === 'action-webhook' && hasPath(edges, node.id, nodeId))
    .forEach((node) => {
      const sample = parseJsonSample(node.config?.sampleResponseJson)
      if (sample && typeof sample === 'object') {
        exposeTestOutput(ctx, node.id, 'http_request', sample)
      }
    })

  return ctx
}

// ---------------------------------------------------------------------------
// Carpetas
// ---------------------------------------------------------------------------

export async function listFolders() {
  const rows = await db.all('SELECT * FROM automation_folders ORDER BY position ASC, created_at ASC')
  return rows.map(mapFolderRow)
}

export async function createFolder(input = {}) {
  const name = normalizeName(input.name)
  const id = makeId('autofold')
  const maxRow = await db.get('SELECT MAX(position) AS max_position FROM automation_folders')
  const position = (Number(maxRow?.max_position) || 0) + 1

  await db.run(
    `INSERT INTO automation_folders (id, name, parent_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, name, input.parentId || null, position]
  )

  const row = await db.get('SELECT * FROM automation_folders WHERE id = ?', [id])
  return mapFolderRow(row)
}

export async function updateFolder(folderId, input = {}) {
  const row = await db.get('SELECT * FROM automation_folders WHERE id = ?', [folderId])
  if (!row) throw notFound('Carpeta no encontrada')

  const name = input.name !== undefined ? normalizeName(input.name) : row.name
  const position = input.position !== undefined ? Number(input.position) || 0 : row.position
  const parentId = input.parentId !== undefined ? (input.parentId || null) : row.parent_id

  await db.run(
    `UPDATE automation_folders
     SET name = ?, position = ?, parent_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [name, position, parentId, folderId]
  )

  const updated = await db.get('SELECT * FROM automation_folders WHERE id = ?', [folderId])
  return mapFolderRow(updated)
}

export async function reorderFolders(orderedIds = []) {
  if (!Array.isArray(orderedIds)) throw badRequest('Orden de carpetas inválido')

  for (let index = 0; index < orderedIds.length; index += 1) {
    await db.run(
      'UPDATE automation_folders SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [index + 1, orderedIds[index]]
    )
  }

  return listFolders()
}

export async function deleteFolder(folderId) {
  const row = await db.get('SELECT * FROM automation_folders WHERE id = ?', [folderId])
  if (!row) throw notFound('Carpeta no encontrada')

  // Las automatizaciones de la carpeta vuelven a la raíz, no se eliminan.
  await db.run(
    'UPDATE automations SET folder_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE folder_id = ?',
    [folderId]
  )
  await db.run('UPDATE automation_folders SET parent_id = NULL WHERE parent_id = ?', [folderId])
  await db.run('DELETE FROM automation_folders WHERE id = ?', [folderId])

  return { id: folderId }
}

// ---------------------------------------------------------------------------
// Automatizaciones
// ---------------------------------------------------------------------------

export async function listAutomations() {
  const rows = await db.all(
    `SELECT id, folder_id, name, description, status, flow, published_flow, created_at, updated_at, published_at
     FROM automations
     ORDER BY updated_at DESC, created_at DESC`
  )
  const catalogs = await loadAutomationReferenceCatalogs()
  return rows.map((row) => mapAutomationRow(row, {
    reviewStatus: getReviewStatusForAutomationRow(row, catalogs)
  }))
}

export async function getAutomation(automationId) {
  const row = await db.get('SELECT * FROM automations WHERE id = ?', [automationId])
  if (!row) throw notFound('Automatización no encontrada')
  const catalogs = await loadAutomationReferenceCatalogs()
  return mapAutomationRow(row, {
    includeFlow: true,
    reviewStatus: getReviewStatusForAutomationRow(row, catalogs)
  })
}

async function assertFolderExists(folderId) {
  if (!folderId) return
  const folder = await db.get('SELECT id FROM automation_folders WHERE id = ?', [folderId])
  if (!folder) throw badRequest('La carpeta seleccionada no existe')
}

export async function createAutomation(input = {}) {
  const name = normalizeName(input.name, 'Automatización sin título')
  const folderId = input.folderId || null
  await assertFolderExists(folderId)

  const id = makeId('auto')
  const flow = normalizeFlow(input.flow ? input.flow : defaultFlow())

  await db.run(
    `INSERT INTO automations (id, folder_id, name, description, status, flow, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ${flowPlaceholder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, folderId, name, input.description || '', JSON.stringify(flow)]
  )

  return getAutomation(id)
}

export async function updateAutomation(automationId, input = {}) {
  const row = await db.get('SELECT * FROM automations WHERE id = ?', [automationId])
  if (!row) throw notFound('Automatización no encontrada')

  const current = mapAutomationRow(row, { includeFlow: true })

  const name = input.name !== undefined ? normalizeName(input.name) : current.name
  const description = input.description !== undefined ? String(input.description || '') : current.description

  let folderId = current.folderId
  if (input.folderId !== undefined) {
    folderId = input.folderId || null
    await assertFolderExists(folderId)
  }

  const flow = input.flow !== undefined ? normalizeFlow(input.flow) : current.flow

  let status = current.status
  let publishedAt = current.publishedAt
  let publishedFlow = row.published_flow ? normalizeFlow(parseFlow(row.published_flow)) : null
  if (input.status !== undefined) {
    if (!AUTOMATION_STATUSES.includes(input.status)) {
      throw badRequest('Estado de automatización inválido')
    }
    status = input.status

    if (status === 'published') {
      const errors = validateFlowForPublish(flow)
      if (errors.length > 0) {
        const error = badRequest(errors.join('. '))
        error.validationErrors = errors
        throw error
      }

      const reviewStatus = getAutomationReviewStatus(flow, await loadAutomationReferenceCatalogs())
      if (reviewStatus.state === 'requires_review') {
        const validationErrors = reviewStatus.issues.map((issue) => issue.message)
        const error = badRequest(reviewStatus.summary || validationErrors.join('. '))
        error.validationErrors = validationErrors
        throw error
      }

      publishedAt = new Date().toISOString()
      publishedFlow = flow
    }
  }

  await db.run(
    `UPDATE automations
     SET name = ?, description = ?, folder_id = ?, status = ?, flow = ${flowPlaceholder},
         published_flow = ${flowPlaceholder}, published_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      name,
      description,
      folderId,
      status,
      JSON.stringify(flow),
      publishedFlow ? JSON.stringify(publishedFlow) : null,
      publishedAt,
      automationId
    ]
  )

  return getAutomation(automationId)
}

export async function duplicateAutomation(automationId) {
  const original = await getAutomation(automationId)
  const id = makeId('auto')
  const name = normalizeName(`${original.name} (copia)`.slice(0, 120))

  await db.run(
    `INSERT INTO automations (id, folder_id, name, description, status, flow, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ${flowPlaceholder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, original.folderId, name, original.description, JSON.stringify(original.flow)]
  )

  return getAutomation(id)
}

export async function deleteAutomation(automationId) {
  const row = await db.get('SELECT id FROM automations WHERE id = ?', [automationId])
  if (!row) throw notFound('Automatización no encontrada')

  await db.run('DELETE FROM automations WHERE id = ?', [automationId])
  return { id: automationId }
}

export async function recordAutomationWebhookSample({ endpointId, method, body, query }) {
  const cleanEndpointId = typeof endpointId === 'string' ? endpointId.trim() : ''
  if (!cleanEndpointId) throw badRequest('Endpoint de webhook inválido')

  const rows = await db.all('SELECT id, flow FROM automations ORDER BY updated_at DESC')
  const receivedAt = new Date().toISOString()
  const sampleResponse = normalizeWebhookSample({ body, query })
  if (!hasWebhookSampleData(sampleResponse)) {
    throw badRequest('Envía al menos un dato de prueba para mapear variables del webhook')
  }

  for (const row of rows) {
    const flow = normalizeFlow(parseFlow(row.flow))
    const startNode = flow.nodes.find((node) => node.type === START_NODE_TYPE)
    if (!startNode) continue

    const triggers = Array.isArray(startNode.config?.triggers) ? startNode.config.triggers : []
    const triggerIndex = triggers.findIndex(
      (trigger) =>
        trigger?.type === 'trigger-incoming-webhook' &&
        String(trigger?.config?.endpointId || '') === cleanEndpointId
    )
    if (triggerIndex === -1) continue

    const nextTriggers = triggers.map((trigger, index) =>
      index === triggerIndex
        ? {
            ...trigger,
            config: {
              ...(trigger.config || {}),
              sampleResponse,
              sampleReceivedAt: receivedAt,
              sampleMethod: method || 'POST',
              sampleStatus: 'received'
            }
          }
        : trigger
    )
    const nextNodes = flow.nodes.map((node) =>
      node.id === startNode.id
        ? { ...node, config: { ...node.config, triggers: nextTriggers } }
        : node
    )
    const nextFlow = { ...flow, nodes: nextNodes }

    await db.run(
      `UPDATE automations SET flow = ${flowPlaceholder}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [JSON.stringify(nextFlow), row.id]
    )

    return {
      automationId: row.id,
      triggerId: triggers[triggerIndex].id,
      endpointId: cleanEndpointId,
      sampleResponse,
      sampleReceivedAt: receivedAt
    }
  }

  throw notFound('Webhook de automatización no encontrado')
}

export async function testAutomationWebhookAction(input = {}) {
  const config = isPlainObject(input.config) ? input.config : {}
  if (!String(config.url || '').trim()) {
    throw badRequest('Configura la URL antes de probar el webhook')
  }

  const flow = input.flow ? normalizeFlow(input.flow) : null
  const ctx = flow ? buildWebhookActionTestContext(flow, String(input.nodeId || '')) : { contact: {} }
  return testWebhookAction(config, ctx)
}

export async function getAutomationsOverview() {
  const [folders, automations] = await Promise.all([listFolders(), listAutomations()])
  return { folders, automations }
}


// ---------------------------------------------------------------------------
// Inscripciones y registros de ejecución (los llena el motor al correr)
// ---------------------------------------------------------------------------

function parseLog(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw) } catch { return [] }
}

function contactDisplayName(row) {
  return String(row?.full_name || row?.first_name || row?.phone || row?.email || row?.id || 'Contacto')
}

function splitContactName(fullName) {
  const parts = cleanString(fullName).split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  }
}

async function getContactForAutomation(contactId) {
  const id = typeof contactId === 'string' ? contactId.trim() : ''
  if (!id) throw badRequest('Selecciona un contacto')
  const contact = await db.get(
    'SELECT id, full_name, first_name, phone, email FROM contacts WHERE id = ?',
    [id]
  )
  if (!contact) throw notFound('Contacto no encontrado')
  return contact
}

async function createAutomationTestContact(input = {}) {
  const fullNameInput = cleanString(input.fullName || input.full_name || input.name)
  const firstNameInput = cleanString(input.firstName || input.first_name)
  const lastNameInput = cleanString(input.lastName || input.last_name)
  const fullName = fullNameInput || [firstNameInput, lastNameInput].filter(Boolean).join(' ') || 'Contacto de prueba'
  const normalizedEmail = cleanString(input.email).toLowerCase() || null
  const normalizedPhone = input.phone ? await normalizePhoneForAccount(input.phone) : null

  if (!normalizedEmail && !normalizedPhone) {
    throw badRequest('Agrega al menos correo o teléfono para el contacto de prueba')
  }

  if (normalizedEmail) {
    const existingByEmail = await db.get(
      'SELECT id FROM contacts WHERE LOWER(email) = ? LIMIT 1',
      [normalizedEmail]
    )
    if (existingByEmail) {
      throw conflict('Ya existe un contacto con ese correo. Búscalo y úsalo como contacto existente.')
    }
  }

  if (normalizedPhone) {
    const existingByPhone = await findContactByPhoneCandidates(normalizedPhone)
    if (existingByPhone) {
      throw conflict('Ya existe un contacto con ese teléfono. Búscalo y úsalo como contacto existente.')
    }
  }

  const id = makeId('contact_test')
  const nameParts = splitContactName(fullName)

  await db.run(
    `INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source, custom_fields, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'automation_test', ${flowPlaceholder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      normalizedPhone,
      normalizedEmail,
      fullName,
      nameParts.firstName || null,
      nameParts.lastName || null,
      serializeContactCustomFieldsForDb([])
    ]
  )

  if (normalizedPhone) {
    await recordContactPhoneNumber({
      contactId: id,
      phone: normalizedPhone,
      label: 'Principal',
      isPrimary: true,
      source: 'automation_test',
      mergeConflicts: false
    }).catch(() => undefined)
  }

  return getContactForAutomation(id)
}

async function resolveTestAutomationContact(input = {}) {
  if (input.contactId) return getContactForAutomation(input.contactId)
  if (isPlainObject(input.contact)) return createAutomationTestContact(input.contact)
  throw badRequest('Selecciona un contacto o agrega un contacto de prueba')
}

async function getPublishedAutomationForEnrollment(automationId) {
  const id = typeof automationId === 'string' ? automationId.trim() : ''
  if (!id) throw badRequest('Selecciona una automatización')
  const automation = await db.get(
    `SELECT id, name, status
     FROM automations
     WHERE id = ?`,
    [id]
  )
  if (!automation) throw notFound('Automatización no encontrada')
  if (automation.status !== 'published') {
    throw badRequest('Solo puedes meter contactos a automatizaciones publicadas')
  }
  return automation
}

async function normalizeScheduledAt(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw badRequest('Elige cuándo quieres agregar el contacto')
  const timezone = await getAccountTimezone()
  const date = new Date(normalizeToUtcIso(raw, timezone))
  if (Number.isNaN(date.getTime())) throw badRequest('La fecha programada no es válida')
  if (date.getTime() < Date.now() - 60_000) throw badRequest('Elige una fecha futura')
  return date.toISOString()
}

function mapContactEnrollmentRow(row) {
  return {
    id: row.id,
    kind: 'enrollment',
    automationId: row.automation_id,
    automationName: row.automation_name || 'Automatización',
    status: row.status || 'active',
    contactId: row.contact_id || null,
    contactName: row.contact_name || 'Contacto',
    currentNodeId: row.current_node_id || null,
    log: parseLog(row.log),
    enteredAt: row.entered_at,
    updatedAt: row.updated_at
  }
}

function mapContactEnrollmentJobRow(row) {
  return {
    id: row.id,
    kind: 'scheduled',
    automationId: row.automation_id,
    automationName: row.automation_name || 'Automatización',
    status: row.status || 'scheduled',
    contactId: row.contact_id || null,
    contactName: row.contact_name || 'Contacto',
    scheduledAt: row.scheduled_at,
    enrollmentId: row.enrollment_id || null,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executedAt: row.executed_at || null
  }
}

function activityTime(item) {
  return new Date(item.scheduledAt || item.updatedAt || item.executedAt || item.enteredAt || item.createdAt || 0).getTime() || 0
}

function mapMetaCatalogRow(row) {
  return {
    id: String(row.id || row.name || ''),
    name: String(row.name || row.id || ''),
    campaignId: row.campaign_id ? String(row.campaign_id) : undefined,
    campaignName: row.campaign_name ? String(row.campaign_name) : undefined,
    adsetId: row.adset_id ? String(row.adset_id) : undefined,
    adsetName: row.adset_name ? String(row.adset_name) : undefined,
    lastDate: row.last_date || undefined
  }
}

const AUTOMATION_FORM_FIELD_BLOCK_TYPES = new Set([
  'short_text',
  'paragraph',
  'currency',
  'number',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date'
])

function cleanCatalogString(value) {
  return String(value || '').trim()
}

function parseCatalogJson(value, fallback) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function automationImportedFormId(siteId, importedFormId) {
  const site = cleanCatalogString(siteId)
  const form = cleanCatalogString(importedFormId)
  return site && form ? `${site}:imported:${form}` : ''
}

function parseAutomationImportedFormId(formId) {
  const match = cleanCatalogString(formId).match(/^(.+):imported:(.+)$/)
  return match ? { siteId: match[1], importedFormId: match[2] } : null
}

function parseAutomationInlineFormId(formId) {
  const match = cleanCatalogString(formId).match(/^(.+):form_embed:(.+)$/)
  return match ? { siteId: match[1], blockId: match[2] } : null
}

function automationAnswerKey(value, fallback = 'campo') {
  const normalized = cleanCatalogString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || fallback
}

function mapAutomationFormOption({ id, name, siteId, siteName, kind, status, updatedAt, meta }) {
  return {
    id: cleanCatalogString(id),
    name: cleanCatalogString(name) || 'Formulario sin nombre',
    siteId: cleanCatalogString(siteId),
    siteName: cleanCatalogString(siteName),
    kind: cleanCatalogString(kind) || 'site',
    status: cleanCatalogString(status),
    updatedAt: updatedAt || null,
    meta: cleanCatalogString(meta)
  }
}

function addAutomationFormOption(options, seen, option) {
  // El formulario de sistema del calendario (citas) NO es un formulario del usuario:
  // se oculta del catálogo de formularios de Automatizaciones (disparos/objetivos).
  // Las citas guardan contacto por su propio camino, así que no se rompe nada. No
  // tocamos el resolver de campos (listAutomationFormFieldsCatalog) para no romper
  // automatizaciones que ya estuvieran apuntando a este id.
  if (option?.id === CALENDAR_DEFAULT_FORM_SITE_ID || option?.siteId === CALENDAR_DEFAULT_FORM_SITE_ID) return
  const mapped = mapAutomationFormOption(option)
  if (!mapped.id || seen.has(mapped.id)) return
  seen.add(mapped.id)
  options.push(mapped)
}

function mapAutomationFieldOption({ value, label, type, meta }) {
  return {
    id: cleanCatalogString(value),
    name: cleanCatalogString(label) || cleanCatalogString(value) || 'Pregunta sin nombre',
    type: cleanCatalogString(type) || 'text',
    meta: cleanCatalogString(meta)
  }
}

function addAutomationFieldOption(options, seen, option) {
  const mapped = mapAutomationFieldOption(option)
  if (!mapped.id || seen.has(mapped.id)) return
  seen.add(mapped.id)
  options.push(mapped)
}

function mapNativeBlockToFieldOption(block = {}, meta = '') {
  const settings = block.settings || {}
  const label = cleanCatalogString(block.label || settings.customFieldLabel || settings.custom_field_label || settings.internalName || block.id)
  const key = automationAnswerKey(
    settings.customFieldKey ||
      settings.custom_field_key ||
      settings.internalName ||
      settings.internal_name ||
      settings.systemFieldKey ||
      settings.system_field_key ||
      block.id,
    cleanCatalogString(block.id) || 'respuesta'
  )

  return {
    value: key,
    label,
    type: block.blockType,
    meta
  }
}

function mapImportedFieldToFieldOption(field = {}, meta = '') {
  const value = cleanCatalogString(
    field.sourceName ||
      field.source_name ||
      field.fieldId ||
      field.field_id ||
      field.destinationKey ||
      field.destination_key ||
      field.label
  )
  const label = cleanCatalogString(field.label || field.sourceName || field.source_name || field.fieldId || field.destinationKey)

  return {
    value,
    label,
    type: cleanCatalogString(field.type || field.customFieldDataType || field.custom_field_data_type || 'text'),
    meta
  }
}

/**
 * Formularios reales disponibles para disparadores/filtros de automatizaciones.
 *
 * No depende del permiso de Sites: si alguien puede administrar automatizaciones,
 * debe poder elegir el formulario que dispara la automatización.
 */
export async function listAutomationFormsCatalog() {
  const [allSiteRows, formEmbedRows, fieldSiteRows, importedRows] = await Promise.all([
    db.all(`
      SELECT id, name, slug, site_type, status, updated_at
      FROM public_sites
      WHERE COALESCE(status, 'draft') != 'archived'
      ORDER BY updated_at DESC, name ASC
    `),
    db.all(`
      SELECT
        b.id AS block_id,
        b.label AS block_label,
        b.settings_json,
        b.updated_at AS block_updated_at,
        s.id AS site_id,
        s.name AS site_name,
        s.site_type,
        s.status,
        s.updated_at AS site_updated_at
      FROM public_site_blocks b
      INNER JOIN public_sites s ON s.id = b.site_id
      WHERE COALESCE(s.status, 'draft') != 'archived'
        AND b.block_type = 'form_embed'
      ORDER BY s.updated_at DESC, b.sort_order ASC, b.created_at ASC
    `),
    db.all(`
      SELECT DISTINCT s.id, s.name, s.slug, s.site_type, s.status, s.updated_at
      FROM public_sites s
      INNER JOIN public_site_blocks b ON b.site_id = s.id
      WHERE COALESCE(s.status, 'draft') != 'archived'
        AND b.block_type IN (${Array.from(AUTOMATION_FORM_FIELD_BLOCK_TYPES).map(() => '?').join(',')})
      ORDER BY s.updated_at DESC, s.name ASC
    `, Array.from(AUTOMATION_FORM_FIELD_BLOCK_TYPES)),
    db.all(`
      SELECT
        i.site_id,
        i.form_mappings_json,
        i.updated_at AS import_updated_at,
        s.name AS site_name,
        s.status,
        s.updated_at AS site_updated_at
      FROM public_site_imports i
      INNER JOIN public_sites s ON s.id = i.site_id
      WHERE COALESCE(s.status, 'draft') != 'archived'
      ORDER BY s.updated_at DESC, i.updated_at DESC
    `)
  ])

  const options = []
  const seen = new Set()
  const siteById = new Map(allSiteRows.map((site) => [cleanCatalogString(site.id), site]))
  const siteRows = allSiteRows.filter((site) => cleanCatalogString(site.site_type).includes('form'))

  for (const site of siteRows) {
    addAutomationFormOption(options, seen, {
      id: site.id,
      name: site.name,
      siteId: site.id,
      siteName: site.name,
      kind: 'site_form',
      status: site.status,
      updatedAt: site.updated_at,
      meta: site.site_type === 'interactive_form' ? 'Formulario interactivo' : 'Formulario'
    })
  }

  for (const row of formEmbedRows) {
    const settings = parseCatalogJson(row.settings_json, {})
    const embeddedSiteId = cleanCatalogString(
      settings.embeddedSiteId ||
      settings.embedded_site_id ||
      settings.formSiteId ||
      settings.form_site_id
    )
    const embeddedSiteName = cleanCatalogString(
      settings.embeddedSiteName ||
      settings.embedded_site_name ||
      settings.formSiteName ||
      settings.form_site_name
    )
    const linkedSite = embeddedSiteId ? siteById.get(embeddedSiteId) : null
    const id = embeddedSiteId || `${row.site_id}:form_embed:${row.block_id}`
    const name = cleanCatalogString(linkedSite?.name) ||
      embeddedSiteName ||
      cleanCatalogString(settings.formName || settings.form_name || settings.formTitle || settings.form_title || settings.name) ||
      `Formulario de ${row.site_name}`
    addAutomationFormOption(options, seen, {
      id,
      name,
      siteId: row.site_id,
      siteName: row.site_name,
      kind: embeddedSiteId ? 'embedded_site_form' : 'landing_form',
      status: row.status,
      updatedAt: row.block_updated_at || row.site_updated_at,
      meta: embeddedSiteId ? `Embebido en ${row.site_name}` : `Formulario en ${row.site_name}`
    })
  }

  for (const site of fieldSiteRows) {
    addAutomationFormOption(options, seen, {
      id: site.id,
      name: site.name,
      siteId: site.id,
      siteName: site.name,
      kind: 'native_fields',
      status: site.status,
      updatedAt: site.updated_at,
      meta: site.site_type === 'landing_page' ? 'Formulario en landing' : 'Formulario'
    })
  }

  for (const row of importedRows) {
    const mappings = parseCatalogJson(row.form_mappings_json, [])
    if (!Array.isArray(mappings) || !mappings.length) {
      addAutomationFormOption(options, seen, {
        id: row.site_id,
        name: row.site_name,
        siteId: row.site_id,
        siteName: row.site_name,
        kind: 'imported_site',
        status: row.status,
        updatedAt: row.import_updated_at || row.site_updated_at,
        meta: 'Formulario importado'
      })
      continue
    }

    for (const mapping of mappings) {
      const formId = cleanCatalogString(mapping?.formId || mapping?.form_id)
      const id = automationImportedFormId(row.site_id, formId) || row.site_id
      const formTitle = cleanCatalogString(mapping?.formTitle || mapping?.form_title || mapping?.title)
      addAutomationFormOption(options, seen, {
        id,
        name: formTitle || row.site_name,
        siteId: row.site_id,
        siteName: row.site_name,
        kind: 'imported_form',
        status: row.status,
        updatedAt: row.import_updated_at || row.site_updated_at,
        meta: formTitle && formTitle !== row.site_name ? `Importado de ${row.site_name}` : 'Formulario importado'
      })
    }
  }

  return options
}

export async function listAutomationFormFieldsCatalog(formId) {
  const requestedFormId = cleanCatalogString(formId)
  if (!requestedFormId) return []

  const options = []
  const seen = new Set()
  const importedForm = parseAutomationImportedFormId(requestedFormId)
  if (importedForm) {
    const row = await db.get(
      'SELECT form_mappings_json FROM public_site_imports WHERE site_id = ? LIMIT 1',
      [importedForm.siteId]
    )
    const mappings = parseCatalogJson(row?.form_mappings_json, [])
    const mapping = Array.isArray(mappings)
      ? mappings.find((item) => cleanCatalogString(item?.formId || item?.form_id) === importedForm.importedFormId)
      : null
    for (const field of Array.isArray(mapping?.fields) ? mapping.fields : []) {
      addAutomationFieldOption(options, seen, mapImportedFieldToFieldOption(field, 'Importado'))
    }
    return options
  }

  const inlineForm = parseAutomationInlineFormId(requestedFormId)
  if (inlineForm) {
    const row = await db.get(
      `SELECT settings_json FROM public_site_blocks WHERE id = ? AND site_id = ? AND block_type = 'form_embed' LIMIT 1`,
      [inlineForm.blockId, inlineForm.siteId]
    )
    const settings = parseCatalogJson(row?.settings_json, {})
    for (const block of Array.isArray(settings.embeddedBlocks) ? settings.embeddedBlocks : []) {
      if (!AUTOMATION_FORM_FIELD_BLOCK_TYPES.has(block?.blockType)) continue
      addAutomationFieldOption(options, seen, mapNativeBlockToFieldOption(block, 'Pregunta'))
    }
    return options
  }

  const site = await db.get(
    'SELECT id, name, site_type FROM public_sites WHERE id = ? LIMIT 1',
    [requestedFormId]
  )
  if (!site) return []

  const blocks = await db.all(
    `SELECT id, block_type, label, settings_json
     FROM public_site_blocks
     WHERE site_id = ?
       AND block_type IN (${Array.from(AUTOMATION_FORM_FIELD_BLOCK_TYPES).map(() => '?').join(',')})
     ORDER BY sort_order ASC, created_at ASC`,
    [requestedFormId, ...Array.from(AUTOMATION_FORM_FIELD_BLOCK_TYPES)]
  )

  for (const block of blocks) {
    addAutomationFieldOption(options, seen, mapNativeBlockToFieldOption({
      id: block.id,
      blockType: block.block_type,
      label: block.label,
      settings: parseCatalogJson(block.settings_json, {})
    }, 'Pregunta'))
  }

  return options
}

/**
 * Campañas reales sincronizadas desde Meta Ads: alimentan filtros y triggers
 * donde el usuario antes tenia que adivinar nombres o IDs.
 */
export async function listAttributionCampaigns() {
  const rows = await db.all(
    `SELECT
       campaign_id AS id,
       COALESCE(MAX(NULLIF(campaign_name, '')), campaign_id) AS name,
       MAX(date) AS last_date
     FROM meta_ads
     WHERE campaign_id IS NOT NULL AND campaign_id != ''
     GROUP BY campaign_id
     ORDER BY MAX(date) DESC, name ASC
     LIMIT 300`
  )
  return rows.map(mapMetaCatalogRow)
}

/**
 * Conjuntos de anuncios sincronizados desde Meta Ads.
 */
export async function listAttributionAdsets() {
  const rows = await db.all(
    `SELECT
       adset_id AS id,
       COALESCE(MAX(NULLIF(adset_name, '')), adset_id) AS name,
       MAX(campaign_id) AS campaign_id,
       COALESCE(MAX(NULLIF(campaign_name, '')), MAX(campaign_id)) AS campaign_name,
       MAX(date) AS last_date
     FROM meta_ads
     WHERE adset_id IS NOT NULL AND adset_id != ''
     GROUP BY adset_id
     ORDER BY MAX(date) DESC, name ASC
     LIMIT 300`
  )
  return rows.map(mapMetaCatalogRow)
}

/**
 * Anuncios reales detectados en la atribución de los contactos y en Meta Ads:
 * alimenta el selector "Anuncio de origen" de los filtros de automatizaciones.
 */
export async function listAttributionAds() {
  const metaRows = await db.all(
    `SELECT
       ad_id AS id,
       COALESCE(MAX(NULLIF(ad_name, '')), ad_id) AS name,
       MAX(campaign_id) AS campaign_id,
       COALESCE(MAX(NULLIF(campaign_name, '')), MAX(campaign_id)) AS campaign_name,
       MAX(adset_id) AS adset_id,
       COALESCE(MAX(NULLIF(adset_name, '')), MAX(adset_id)) AS adset_name,
       MAX(date) AS last_date
     FROM meta_ads
     WHERE ad_id IS NOT NULL AND ad_id != ''
     GROUP BY ad_id
     ORDER BY MAX(date) DESC, name ASC
     LIMIT 300`
  )
  if (metaRows.length > 0) return metaRows.map(mapMetaCatalogRow)

  const rows = await db.all(
    `SELECT attribution_ad_name AS name, attribution_ad_id AS id, COUNT(*) AS total
     FROM contacts
     WHERE (attribution_ad_name IS NOT NULL AND attribution_ad_name != '')
        OR (attribution_ad_id IS NOT NULL AND attribution_ad_id != '')
     GROUP BY attribution_ad_name, attribution_ad_id
     ORDER BY total DESC
     LIMIT 200`
  )
  return rows.map(mapMetaCatalogRow)
}

export async function listEnrollments(automationId) {
  const rows = await db.all(
    `SELECT * FROM automation_enrollments WHERE automation_id = ? ORDER BY updated_at DESC LIMIT 200`,
    [automationId]
  )
  return rows.map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name || 'Contacto',
    status: row.status || 'active',
    currentNodeId: row.current_node_id || null,
    log: parseLog(row.log),
    enteredAt: row.entered_at,
    updatedAt: row.updated_at
  }))
}

export async function listContactAutomationActivity(contactId) {
  await getContactForAutomation(contactId)
  const [enrollmentRows, jobRows] = await Promise.all([
    db.all(
      `SELECT e.*, COALESCE(a.name, 'Automatización eliminada') AS automation_name
       FROM automation_enrollments e
       LEFT JOIN automations a ON a.id = e.automation_id
       WHERE e.contact_id = ?
       ORDER BY e.updated_at DESC
       LIMIT 200`,
      [contactId]
    ),
    db.all(
      `SELECT j.*, COALESCE(a.name, 'Automatización eliminada') AS automation_name
       FROM automation_contact_enrollment_jobs j
       LEFT JOIN automations a ON a.id = j.automation_id
       WHERE j.contact_id = ?
       ORDER BY j.scheduled_at DESC, j.created_at DESC
       LIMIT 200`,
      [contactId]
    )
  ])

  const enrollmentItems = enrollmentRows.map(mapContactEnrollmentRow)
  const jobItems = jobRows.map(mapContactEnrollmentJobRow)
  const activeStatuses = new Set(['active', 'waiting'])
  const active = [
    ...jobItems.filter((item) => ['scheduled', 'processing'].includes(item.status)),
    ...enrollmentItems.filter((item) => activeStatuses.has(item.status))
  ].sort((left, right) => activityTime(left) - activityTime(right))

  const past = [
    ...enrollmentItems.filter((item) => !activeStatuses.has(item.status)),
    ...jobItems.filter((item) => !['scheduled', 'processing', 'completed'].includes(item.status) || (item.status === 'completed' && !item.enrollmentId))
  ].sort((left, right) => activityTime(right) - activityTime(left))

  return { active, past }
}

export async function enrollContactInAutomation(automationId, input = {}) {
  const contact = await getContactForAutomation(input.contactId)
  const automation = await getPublishedAutomationForEnrollment(automationId)
  const mode = input.mode === 'scheduled' ? 'scheduled' : 'now'

  if (mode === 'scheduled') {
    const scheduledAt = await normalizeScheduledAt(input.scheduledAt)
    const id = makeId('autojob')
    await db.run(
      `INSERT INTO automation_contact_enrollment_jobs
         (id, automation_id, contact_id, contact_name, scheduled_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`,
      [
        id,
        automation.id,
        contact.id,
        contactDisplayName(contact),
        scheduledAt,
        input.userId || null
      ]
    )
    const row = await db.get(
      `SELECT j.*, a.name AS automation_name
       FROM automation_contact_enrollment_jobs j
       LEFT JOIN automations a ON a.id = j.automation_id
       WHERE j.id = ?`,
      [id]
    )
    return { mode, job: mapContactEnrollmentJobRow(row) }
  }

  const enrollment = await enrollContactManually({
    automationId: automation.id,
    contactId: contact.id,
    source: 'manual'
  })
  return {
    mode,
    enrollment: {
      ...enrollment,
      kind: 'enrollment',
      automationName: automation.name
    }
  }
}

export async function testAutomationRun(automationId, input = {}) {
  const contact = await resolveTestAutomationContact(input)
  const automation = await getPublishedAutomationForEnrollment(automationId)
  const enrollment = await enrollContactManually({
    automationId: automation.id,
    contactId: contact.id,
    source: 'test-run'
  })

  return {
    mode: 'test',
    testedAt: new Date().toISOString(),
    automationId: automation.id,
    automationName: automation.name,
    contactId: contact.id,
    contactName: contactDisplayName(contact),
    enrollment: {
      ...enrollment,
      kind: 'enrollment',
      automationName: automation.name
    }
  }
}

/** Conteo de contactos activos por nodo (para los badges del canvas) */
export async function getEnrollmentStats(automationId) {
  const rows = await db.all(
    `SELECT current_node_id, COUNT(*) AS total
     FROM automation_enrollments
     WHERE automation_id = ? AND status IN ('active', 'waiting')
     GROUP BY current_node_id`,
    [automationId]
  )
  const byNode = {}
  let active = 0
  rows.forEach((row) => {
    if (row.current_node_id) byNode[row.current_node_id] = Number(row.total) || 0
    active += Number(row.total) || 0
  })
  const totals = await db.get(
    `SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ?`,
    [automationId]
  )
  return { active, total: Number(totals?.total) || 0, byNode }
}

export async function listAutomationWhatsAppTemplatesCatalog({ status = 'APPROVED', limit = 200 } = {}) {
  await syncLocalMessageTemplateSnapshots({ onlyApproved: true })
  return getWhatsAppApiTemplates({
    status: cleanCatalogString(status) || 'APPROVED',
    limit
  })
}

// ---------------------------------------------------------------------------
// Archivos adjuntos (imágenes/videos/audios/docs de los bloques de mensaje)
// ---------------------------------------------------------------------------

export async function saveAutomationAsset({ fileBase64, filename, userId }) {
  const { uploadMediaAssetFromDataUrl } = await import('./mediaStorageService.js')
  const asset = await uploadMediaAssetFromDataUrl({
    fileBase64,
    filename,
    userId,
    module: 'automations',
    isPublic: true
  })

  return {
    id: asset.id,
    url: asset.publicUrl,
    contentType: asset.mimeType,
    sizeBytes: asset.sizeProcessed,
    originalSizeBytes: asset.sizeOriginal,
    compression: asset.metadata?.compression || 'original',
    status: asset.status,
    mediaType: asset.mediaType
  }
}

export async function getAutomationAsset(assetId) {
  const row = await db.get('SELECT * FROM automation_assets WHERE id = ?', [assetId])
  if (!row) {
    const error = new Error('Archivo no encontrado')
    error.status = 404
    throw error
  }
  return row
}
