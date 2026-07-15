import { databaseDialect, db } from '../config/database.js'
import {
  collectAutomationFlowRequiredFeatures,
  normalizeFlow,
  validateFlowForPublish,
  START_NODE_TYPE
} from './automationFlowValidation.js'
import { controlAutomationEnrollment as controlEngineEnrollment, enrollContactManually, testWebhookAction } from './automationEngine.js'
import { hasFeature, isLicenseEnforced } from './licenseService.js'
import { findContactByPhoneCandidates, recordContactPhoneNumber } from './contactIdentityService.js'
import { getWhatsAppApiTemplatesCatalogPage } from './whatsappApiService.js'
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
import {
  formatContactName,
  normalizeContactNameFields,
  splitContactName as splitFormattedContactName
} from '../utils/contactNameFormatter.js'
import {
  listDraftAutomationRowsForWebhookEndpoint,
  removeAutomationTriggerIndex,
  replaceAutomationTriggerIndex
} from './automationTriggerIndexService.js'

const usePostgres = databaseDialect === 'postgres'
const flowPlaceholder = usePostgres ? '?::jsonb' : '?'
const AUTOMATION_NAME_MAX_LENGTH = 120
const DEFAULT_AUTOMATION_NAME = 'Automatización sin título'
const DEFAULT_AUTOMATIONS_PAGE_SIZE = 50
const MAX_AUTOMATIONS_PAGE_SIZE = 100
let automationWebhookSampleAfterLockHookForTest = null

export const AUTOMATION_STATUSES = ['draft', 'published', 'paused', 'archived']

export function setAutomationWebhookSampleAfterLockHookForTest(hook) {
  automationWebhookSampleAfterLockHookForTest = typeof hook === 'function' ? hook : null
}

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

function featureNotAvailable(message, feature) {
  const error = new Error(message)
  error.status = 403
  error.code = 'feature_not_available'
  error.feature = feature
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

function escapeAutomationLikePattern(value) {
  return String(value || '')
    .replaceAll('!', '!!')
    .replaceAll('%', '!%')
    .replaceAll('_', '!_')
}

function normalizeAutomationPageLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOMATIONS_PAGE_SIZE
  return Math.min(MAX_AUTOMATIONS_PAGE_SIZE, Math.max(1, parsed))
}

function automationCursorScope({ search = '', status = '', folderId = null } = {}) {
  return JSON.stringify([search.toLowerCase(), status, folderId])
}

function encodeAutomationCursor(row, scope) {
  if (!row) return null
  const rawUpdatedAt = row.cursor_updated_at ?? row.sort_updated_at
  const updatedAt = rawUpdatedAt instanceof Date
    ? rawUpdatedAt.toISOString()
    : String(rawUpdatedAt || '')
  return Buffer.from(JSON.stringify({
    v: 2,
    kind: 'automations',
    scope,
    updatedAt,
    id: String(row.id || '')
  }), 'utf8').toString('base64url')
}

function decodeAutomationCursor(value, expectedScope) {
  const cursor = cleanString(value)
  if (!cursor) return null

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const updatedAt = cleanString(parsed?.updatedAt)
    const id = cleanString(parsed?.id)
    if (!updatedAt || !id) throw new Error('invalid cursor')
    if (parsed?.scope !== undefined && parsed.scope !== expectedScope) {
      throw new Error('cursor scope mismatch')
    }
    return { updatedAt, id }
  } catch {
    throw badRequest('Cursor de automatizaciones inválido')
  }
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

async function assertAutomationFlowFeatureAccess(flow) {
  if (!isLicenseEnforced()) return
  const requiredFeatures = collectAutomationFlowRequiredFeatures(flow)
  for (const featureKey of requiredFeatures) {
    if (!(await hasFeature(featureKey))) {
      throw featureNotAvailable('La automatización usa pasos que no están incluidos en tu plan actual.', featureKey)
    }
  }
}

function normalizeName(rawName, fallback) {
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (!name && fallback !== undefined) return fallback
  if (!name) throw badRequest('El nombre es obligatorio')
  if (name.length > AUTOMATION_NAME_MAX_LENGTH) throw badRequest('El nombre no puede superar 120 caracteres')
  return name
}

function buildNumberedAutomationName(baseName, number) {
  const suffix = ` ${number}`
  const safeBase = String(baseName || DEFAULT_AUTOMATION_NAME)
    .slice(0, Math.max(1, AUTOMATION_NAME_MAX_LENGTH - suffix.length))
    .trim()
  return `${safeBase || DEFAULT_AUTOMATION_NAME}${suffix}`
}

async function resolveNewAutomationName(rawName, fallback = DEFAULT_AUTOMATION_NAME) {
  const baseName = normalizeName(rawName, fallback)
  const rows = await db.all('SELECT name FROM automations')
  const existingNames = new Set(rows.map((row) => cleanString(row.name)).filter(Boolean))

  for (let number = 1; number < 100000; number += 1) {
    const candidate = buildNumberedAutomationName(baseName, number)
    if (!existingNames.has(candidate)) return candidate
  }

  throw conflict('No se pudo generar un nombre disponible para la automatización')
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

/**
 * Listado acotado para la librería y los selectores de automatizaciones.
 *
 * El cursor usa (updated_at, id) para que insertar o borrar registros mientras
 * el usuario navega no desplace las páginas. Los grafos sólo se leen cuando la
 * librería pide explícitamente las insignias de revisión; los catálogos y
 * selectores reciben summaries puros.
 */
export async function listAutomationsPage(options = {}) {
  const limit = normalizeAutomationPageLimit(options.limit)
  const search = cleanString(options.search).slice(0, 200)
  const requestedStatus = cleanString(options.status).toLowerCase()
  const status = AUTOMATION_STATUSES.includes(requestedStatus) ? requestedStatus : ''
  const rawFolderId = options.folderId === undefined || options.folderId === null
    ? null
    : cleanString(options.folderId)
  const includeReview = options.includeReview === true
  const cursorScope = automationCursorScope({ search, status, folderId: rawFolderId })
  const cursor = decodeAutomationCursor(options.cursor, cursorScope)
  const conditions = []
  const params = []

  if (search) {
    const searchDocument = `LOWER(
      COALESCE(id, '') || ' ' ||
      COALESCE(name, '') || ' ' ||
      COALESCE(description, '')
    )`
    conditions.push(`${searchDocument} LIKE ? ESCAPE '!'`)
    params.push(`%${escapeAutomationLikePattern(search.toLowerCase())}%`)
  }

  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }

  if (rawFolderId !== null) {
    if (!rawFolderId || rawFolderId === 'root') {
      conditions.push('folder_id IS NULL')
    } else {
      conditions.push('folder_id = ?')
      params.push(rawFolderId)
    }
  }

  const sortTimestamp = databaseDialect === 'postgres'
    ? "COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')"
    : "COALESCE(updated_at, created_at, '1970-01-01 00:00:00')"
  const cursorTimestamp = databaseDialect === 'postgres'
    ? `(${sortTimestamp})::text`
    : sortTimestamp
  if (cursor) {
    conditions.push(`(${sortTimestamp}, id) < (?, ?)`)
    params.push(cursor.updatedAt, cursor.id)
  }

  const rows = await db.all(
    `SELECT
       id,
       folder_id,
       name,
       description,
       status,
       created_at,
       updated_at,
       published_at,
       ${sortTimestamp} AS sort_updated_at,
       ${cursorTimestamp} AS cursor_updated_at
     FROM automations
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY ${sortTimestamp} DESC, id DESC
     LIMIT ?`,
    [...params, limit + 1]
  )

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const reviewIds = includeReview
    ? pageRows
        .filter((row) => ['published', 'paused'].includes(row.status || 'draft'))
        .map((row) => row.id)
    : []
  const [catalogs, reviewRows] = reviewIds.length > 0
    ? await Promise.all([
        loadAutomationReferenceCatalogs(),
        db.all(
          `SELECT id, flow, published_flow
           FROM automations
           WHERE id IN (${reviewIds.map(() => '?').join(', ')})`,
          reviewIds
        )
      ])
    : [null, []]
  const reviewRowsById = new Map(reviewRows.map((row) => [row.id, row]))
  const items = pageRows.map((row) => {
    const reviewRow = reviewRowsById.get(row.id)
    const hydratedRow = reviewRow ? { ...row, ...reviewRow } : row
    return mapAutomationRow(hydratedRow, {
      reviewStatus: catalogs ? getReviewStatusForAutomationRow(hydratedRow, catalogs) : AUTOMATION_REVIEW_OK
    })
  })

  return {
    items,
    pageInfo: {
      limit,
      hasMore,
      nextCursor: hasMore ? encodeAutomationCursor(pageRows[pageRows.length - 1], cursorScope) : null
    }
  }
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
  const name = await resolveNewAutomationName(input.name)
  const folderId = input.folderId || null
  await assertFolderExists(folderId)

  const id = makeId('auto')
  const flow = normalizeFlow(input.flow ? input.flow : defaultFlow())
  await assertAutomationFlowFeatureAccess(flow)

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO automations (id, folder_id, name, description, status, flow, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ${flowPlaceholder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, folderId, name, input.description || '', JSON.stringify(flow)]
    )
    await replaceAutomationTriggerIndex(tx, { id, status: 'draft', flow, published_flow: null })
  })

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
  await assertAutomationFlowFeatureAccess(flow)

  let status = current.status
  let publishedAt = current.publishedAt
  // Una instalación legacy podía tener una automatización publicada sin
  // published_flow. Congelamos el contrato vivo actual antes de guardar cambios
  // de borrador para que editar no cambie lo que corre hasta volver a publicar.
  let publishedFlow = row.published_flow
    ? normalizeFlow(parseFlow(row.published_flow))
    : current.status === 'published'
      ? normalizeFlow(parseFlow(row.flow))
      : null
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

  await db.transaction(async (tx) => {
    await tx.run(
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
    await replaceAutomationTriggerIndex(tx, {
      id: automationId,
      status,
      flow,
      published_flow: publishedFlow
    })
  })

  return getAutomation(automationId)
}

export async function duplicateAutomation(automationId) {
  const original = await getAutomation(automationId)
  const id = makeId('auto')
  const name = await resolveNewAutomationName(`${original.name} (copia)`.slice(0, AUTOMATION_NAME_MAX_LENGTH))

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO automations (id, folder_id, name, description, status, flow, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ${flowPlaceholder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, original.folderId, name, original.description, JSON.stringify(original.flow)]
    )
    await replaceAutomationTriggerIndex(tx, {
      id,
      status: 'draft',
      flow: original.flow,
      published_flow: null
    })
  })

  return getAutomation(id)
}

export async function deleteAutomation(automationId) {
  const id = cleanString(automationId)
  if (!id) throw notFound('Automatización no encontrada')

  return db.transaction(async (tx) => {
    const row = await tx.get('SELECT id FROM automations WHERE id = ?', [id])
    if (!row) throw notFound('Automatización no encontrada')

    await tx.run('DELETE FROM automation_drip_entries WHERE automation_id = ?', [id])
    await tx.run('DELETE FROM automation_schedule_runs WHERE automation_id = ?', [id])
    await tx.run('DELETE FROM automation_contact_enrollment_jobs WHERE automation_id = ?', [id])
    await tx.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [id])
    await tx.run(
      `UPDATE internal_notifications
          SET automation_id = NULL,
              automation_node_id = NULL,
              enrollment_id = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE automation_id = ?`,
      [id]
    )
    await removeAutomationTriggerIndex(tx, id)
    await tx.run('DELETE FROM automations WHERE id = ?', [id])
    return { id }
  })
}

export async function recordAutomationWebhookSample({ endpointId, method, body, query }) {
  const cleanEndpointId = typeof endpointId === 'string' ? endpointId.trim() : ''
  if (!cleanEndpointId) throw badRequest('Endpoint de webhook inválido')

  const { rows } = await listDraftAutomationRowsForWebhookEndpoint(cleanEndpointId)
  const receivedAt = new Date().toISOString()
  const sampleResponse = normalizeWebhookSample({ body, query })
  if (!hasWebhookSampleData(sampleResponse)) {
    throw badRequest('Envía al menos un dato de prueba para mapear variables del webhook')
  }

  for (const candidate of rows) {
    // En fallback puede haber miles de grafos. Filtrar el snapshot evita abrir
    // una transacción por cada fila, pero la coincidencia se valida otra vez
    // bajo lock antes de escribir.
    const candidateFlow = normalizeFlow(parseFlow(candidate.flow))
    const candidateStart = candidateFlow.nodes.find((node) => node.type === START_NODE_TYPE)
    const candidateTriggers = Array.isArray(candidateStart?.config?.triggers)
      ? candidateStart.config.triggers
      : []
    if (!candidateTriggers.some((trigger) =>
      trigger?.type === 'trigger-incoming-webhook'
      && String(trigger?.config?.endpointId || '') === cleanEndpointId
    )) continue

    const result = await db.transaction(async (tx) => {
      const lockSuffix = usePostgres ? ' FOR UPDATE' : ''
      const current = await tx.get(
        `SELECT id, status, flow, published_flow
         FROM automations
         WHERE id = ?${lockSuffix}`,
        [candidate.id]
      )
      if (!current) return null

      const flow = normalizeFlow(parseFlow(current.flow))
      const startNode = flow.nodes.find((node) => node.type === START_NODE_TYPE)
      if (!startNode) return null
      const triggers = Array.isArray(startNode.config?.triggers) ? startNode.config.triggers : []
      const triggerIndex = triggers.findIndex(
        (trigger) =>
          trigger?.type === 'trigger-incoming-webhook'
          && String(trigger?.config?.endpointId || '') === cleanEndpointId
      )
      if (triggerIndex === -1) return null

      if (automationWebhookSampleAfterLockHookForTest) {
        await automationWebhookSampleAfterLockHookForTest({ automationId: current.id })
      }

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

      await tx.run(
        `UPDATE automations SET flow = ${flowPlaceholder}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify(nextFlow), current.id]
      )
      await replaceAutomationTriggerIndex(tx, { ...current, flow: nextFlow })

      return {
        automationId: current.id,
        triggerId: triggers[triggerIndex].id,
        endpointId: cleanEndpointId,
        sampleResponse,
        sampleReceivedAt: receivedAt
      }
    })

    if (result) return result
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

export async function getAutomationsOverview(options = {}) {
  const [folders, page] = await Promise.all([listFolders(), listAutomationsPage(options)])
  return { folders, automations: page.items, pageInfo: page.pageInfo }
}


// ---------------------------------------------------------------------------
// Inscripciones y registros de ejecución (los llena el motor al correr)
// ---------------------------------------------------------------------------

function parseLog(raw) {
  if (!raw) return []
  const parsed = Array.isArray(raw) ? raw : (() => {
    try { return JSON.parse(raw) } catch { return [] }
  })()
  if (!Array.isArray(parsed)) return []

  return parsed.map((entry) => {
    const status = cleanString(entry?.status).toLowerCase()
    const explicitOutcome = cleanString(entry?.outcome).toLowerCase()
    const outcome = ['success', 'error', 'waiting', 'skipped', 'info'].includes(explicitOutcome)
      ? explicitOutcome
      : status === 'error' || status === 'failed'
        ? 'error'
        : status === 'waiting' || status === 'retrying'
          ? 'waiting'
          : status === 'skipped' || status === 'omitted'
            ? 'skipped'
            : status === 'info' || status === 'exited' || status === 'paused'
              ? 'info'
              : 'success'
    const errorMessage = cleanString(entry?.errorMessage || entry?.error || (outcome === 'error' ? entry?.detail : ''))
    return {
      ...entry,
      outcome,
      ...(errorMessage ? { errorMessage } : {})
    }
  })
}

function latestExecutionError(log, { unresolvedOnly = false } = {}) {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index]
    if (entry.outcome !== 'error') continue
    if (unresolvedOnly && (entry.resolved || entry.resolvedAt)) continue
    if (entry.errorMessage || entry.detail) return entry.errorMessage || entry.detail
  }
  return null
}

function deriveExecutionOutcome(status, storedOutcome, log) {
  const normalizedStatus = cleanString(status).toLowerCase()
  const normalizedStoredOutcome = cleanString(storedOutcome).toLowerCase()
  if (['active', 'waiting', 'paused', 'scheduled', 'processing'].includes(normalizedStatus)) return 'pending'
  const hasUnresolvedError = log.some((entry) => entry.outcome === 'error' && !entry.resolved && !entry.resolvedAt)
  if (hasUnresolvedError || normalizedStatus === 'error') return 'error'
  if (normalizedStatus === 'completed' || normalizedStoredOutcome === 'success') return 'success'
  if (normalizedStatus === 'exited' || normalizedStoredOutcome === 'stopped') return 'stopped'
  return ['pending', 'success', 'error', 'stopped'].includes(normalizedStoredOutcome)
    ? normalizedStoredOutcome
    : 'pending'
}

function contactDisplayName(row) {
  return formatContactName(row?.full_name || row?.first_name) || String(row?.phone || row?.email || row?.id || 'Contacto')
}

function splitContactName(fullName) {
  return splitFormattedContactName(fullName)
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
  const contactNameFields = normalizeContactNameFields({
    fullName: input.fullName || input.full_name,
    name: input.name,
    firstName: input.firstName || input.first_name,
    lastName: input.lastName || input.last_name,
    fallback: 'Contacto de prueba'
  })
  const fullName = contactNameFields.fullName
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

async function getSavedAutomationForTestRun(automationId) {
  const id = typeof automationId === 'string' ? automationId.trim() : ''
  if (!id) throw badRequest('Selecciona una automatización')
  const automation = await db.get(
    `SELECT id, name, status, flow
     FROM automations
     WHERE id = ?`,
    [id]
  )
  if (!automation) throw notFound('Automatización no encontrada')
  if (automation.status === 'archived') {
    throw badRequest('No puedes probar una automatización archivada')
  }

  const flow = normalizeFlow(parseFlow(automation.flow))
  await assertAutomationFlowFeatureAccess(flow)
  const validationErrors = validateFlowForPublish(flow)
  if (validationErrors.length > 0) {
    const error = badRequest(validationErrors.join('. '))
    error.validationErrors = validationErrors
    throw error
  }

  const reviewStatus = getAutomationReviewStatus(flow, await loadAutomationReferenceCatalogs())
  if (reviewStatus.state === 'requires_review') {
    const referenceErrors = reviewStatus.issues.map((issue) => issue.message)
    const error = badRequest(reviewStatus.summary || referenceErrors.join('. '))
    error.validationErrors = referenceErrors
    throw error
  }

  return { id: automation.id, name: automation.name, status: automation.status, flow }
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
  const log = parseLog(row.log)
  return {
    id: row.id,
    kind: 'enrollment',
    automationId: row.automation_id,
    automationName: row.automation_name || 'Automatización',
    status: row.status || 'active',
    contactId: row.contact_id || null,
    contactName: row.contact_name || 'Contacto',
    currentNodeId: row.current_node_id || null,
    log,
    executionOutcome: deriveExecutionOutcome(row.status, row.execution_outcome, log),
    lastError: row.last_error || latestExecutionError(log, { unresolvedOnly: true }),
    enteredAt: row.entered_at,
    updatedAt: row.updated_at
  }
}

function mapContactEnrollmentJobRow(row) {
  const log = parseLog(row.log)
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
    log,
    executionOutcome: deriveExecutionOutcome(row.status, null, log),
    lastError: row.error || latestExecutionError(log, { unresolvedOnly: true }),
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
const DEFAULT_AUTOMATION_FORMS_CATALOG_LIMIT = 30
const MAX_AUTOMATION_FORMS_CATALOG_LIMIT = 50

function normalizeAutomationFormsCatalogLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOMATION_FORMS_CATALOG_LIMIT
  return Math.min(MAX_AUTOMATION_FORMS_CATALOG_LIMIT, Math.max(1, parsed))
}

function normalizeAutomationFormsSelectedIds(values = []) {
  const source = Array.isArray(values) ? values : String(values || '').split(',')
  return [...new Set(source.map(cleanCatalogString).filter(Boolean))].slice(0, 50)
}

function automationFormsCatalogCursorScope(search = '') {
  return JSON.stringify(['automation-forms-catalog', cleanCatalogString(search).toLowerCase()])
}

function encodeAutomationFormsCatalogCursor(row, scope) {
  if (!row) return null
  const updatedAt = cleanCatalogString(row.cursor_updated_at || row.updated_at)
  const id = cleanCatalogString(row.id)
  if (!updatedAt || !id) return null
  return Buffer.from(JSON.stringify({ v: 1, scope, updatedAt, id }), 'utf8').toString('base64url')
}

function decodeAutomationFormsCatalogCursor(value, expectedScope) {
  const encoded = cleanCatalogString(value)
  if (!encoded) return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    const updatedAt = cleanCatalogString(parsed?.updatedAt)
    const id = cleanCatalogString(parsed?.id)
    if (parsed?.v !== 1 || parsed?.scope !== expectedScope || !updatedAt || !id) throw new Error('invalid cursor')
    return { updatedAt, id }
  } catch {
    throw badRequest('Cursor del catálogo de formularios inválido')
  }
}

const automationFormFieldBlockTypesSql = [...AUTOMATION_FORM_FIELD_BLOCK_TYPES]
  .map(value => `'${value.replaceAll("'", "''")}'`)
  .join(', ')

function automationCatalogJsonText(column, keys) {
  if (usePostgres) {
    return `COALESCE(${keys.map(key => `ristak_safe_jsonb(${column}) ->> '${key}'`).join(', ')}, '')`
  }
  return `COALESCE(${keys.map(key => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${key}') END`).join(', ')}, '')`
}

function automationFormsImportMappingSource() {
  if (usePostgres) {
    return `LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(ristak_safe_jsonb(i.form_mappings_json)) = 'array'
          AND jsonb_array_length(ristak_safe_jsonb(i.form_mappings_json)) > 0
          THEN ristak_safe_jsonb(i.form_mappings_json)
        ELSE jsonb_build_array('{}'::jsonb)
      END
    ) mapping(value)`
  }
  return `json_each(
    CASE
      WHEN json_valid(i.form_mappings_json)
        AND json_type(i.form_mappings_json) = 'array'
        AND json_array_length(i.form_mappings_json) > 0
        THEN i.form_mappings_json
      ELSE '[{}]'
    END
  ) mapping`
}

function automationFormsImportJsonText(keys) {
  if (usePostgres) {
    return `COALESCE(${keys.map(key => `mapping.value ->> '${key}'`).join(', ')}, '')`
  }
  return `COALESCE(${keys.map(key => `json_extract(mapping.value, '$.${key}')`).join(', ')}, '')`
}

function buildAutomationFormsCatalogBranches() {
  const siteUpdatedAt = `COALESCE(s.updated_at, s.created_at${usePostgres ? ", TIMESTAMP '1970-01-01 00:00:00'" : ", '1970-01-01 00:00:00'"})`
  const blockUpdatedAt = `COALESCE(b.updated_at, ${siteUpdatedAt})`
  const importUpdatedAt = `COALESCE(i.updated_at, ${siteUpdatedAt})`
  const embeddedSiteId = automationCatalogJsonText('b.settings_json', ['embeddedSiteId', 'embedded_site_id', 'formSiteId', 'form_site_id'])
  const embeddedSiteName = automationCatalogJsonText('b.settings_json', ['embeddedSiteName', 'embedded_site_name', 'formSiteName', 'form_site_name'])
  const embeddedFormName = automationCatalogJsonText('b.settings_json', ['formName', 'form_name', 'formTitle', 'form_title', 'name'])
  const importedFormId = automationFormsImportJsonText(['formId', 'form_id'])
  const importedFormTitle = automationFormsImportJsonText(['formTitle', 'form_title', 'title'])
  const siteSearchDocument = `LOWER(
    COALESCE(s.id, '') || ' ' || COALESCE(s.name, '') || ' ' || COALESCE(s.title, '') || ' ' ||
    COALESCE(s.description, '') || ' ' || COALESCE(s.slug, '') || ' ' || COALESCE(s.domain, '') || ' ' ||
    COALESCE(s.site_type, '') || ' ' || COALESCE(s.status, '')
  )`
  const blockSearchDocument = `LOWER(COALESCE(b.id, '') || ' ' || COALESCE(b.label, '') || ' ' || COALESCE(b.settings_json, ''))`
  const importSearchDocument = `LOWER(COALESCE(i.id, '') || ' ' || COALESCE(i.site_id, '') || ' ' || COALESCE(i.form_mappings_json, ''))`

  return [
    `SELECT s.id, COALESCE(NULLIF(s.name, ''), 'Formulario sin nombre') AS name,
       s.id AS site_id, s.name AS site_name, 'site_form' AS kind, s.status,
       ${siteUpdatedAt} AS sort_updated_at,
       CASE WHEN s.site_type = 'interactive_form' THEN 'Formulario interactivo' ELSE 'Formulario' END AS meta,
       ${siteSearchDocument} AS search_document
     FROM public_sites s
     WHERE COALESCE(s.status, 'draft') != 'archived'
       AND s.id != '${CALENDAR_DEFAULT_FORM_SITE_ID.replaceAll("'", "''")}'
       AND s.site_type IN ('standard_form', 'interactive_form')`,
    `SELECT s.id, COALESCE(NULLIF(s.name, ''), 'Formulario sin nombre') AS name,
       s.id AS site_id, s.name AS site_name, 'native_fields' AS kind, s.status,
       ${siteUpdatedAt} AS sort_updated_at, 'Formulario en landing' AS meta,
       ${siteSearchDocument} AS search_document
     FROM public_sites s
     WHERE COALESCE(s.status, 'draft') != 'archived'
       AND s.id != '${CALENDAR_DEFAULT_FORM_SITE_ID.replaceAll("'", "''")}'
       AND s.site_type NOT IN ('standard_form', 'interactive_form')
       AND EXISTS (
         SELECT 1 FROM public_site_blocks native_block
         WHERE native_block.site_id = s.id
           AND native_block.block_type IN (${automationFormFieldBlockTypesSql})
       )`,
    `SELECT (s.id || ':form_embed:' || b.id) AS id,
       COALESCE(NULLIF(${embeddedSiteName}, ''), NULLIF(${embeddedFormName}, ''), 'Formulario de ' || COALESCE(NULLIF(s.name, ''), 'sitio')) AS name,
       s.id AS site_id, s.name AS site_name, 'landing_form' AS kind, s.status,
       ${blockUpdatedAt} AS sort_updated_at, 'Formulario en ' || COALESCE(NULLIF(s.name, ''), 'sitio') AS meta,
       ${blockSearchDocument} AS search_document
     FROM public_site_blocks b
     INNER JOIN public_sites s ON s.id = b.site_id
     WHERE COALESCE(s.status, 'draft') != 'archived'
       AND s.id != '${CALENDAR_DEFAULT_FORM_SITE_ID.replaceAll("'", "''")}'
       AND b.block_type = 'form_embed'
       AND NULLIF(${embeddedSiteId}, '') IS NULL`,
    `SELECT ${embeddedSiteId} AS id,
       COALESCE(NULLIF(linked.name, ''), NULLIF(${embeddedSiteName}, ''), NULLIF(${embeddedFormName}, ''), 'Formulario guardado') AS name,
       s.id AS site_id, s.name AS site_name, 'embedded_site_form' AS kind, s.status,
       ${blockUpdatedAt} AS sort_updated_at, 'Embebido en ' || COALESCE(NULLIF(s.name, ''), 'sitio') AS meta,
       ${blockSearchDocument} AS search_document
     FROM public_site_blocks b
     INNER JOIN public_sites s ON s.id = b.site_id
     LEFT JOIN public_sites linked ON linked.id = ${embeddedSiteId}
     WHERE COALESCE(s.status, 'draft') != 'archived'
       AND s.id != '${CALENDAR_DEFAULT_FORM_SITE_ID.replaceAll("'", "''")}'
       AND b.block_type = 'form_embed'
       AND NULLIF(${embeddedSiteId}, '') IS NOT NULL`,
    `SELECT CASE WHEN NULLIF(${importedFormId}, '') IS NULL
         THEN s.id ELSE s.id || ':imported:' || ${importedFormId} END AS id,
       COALESCE(NULLIF(${importedFormTitle}, ''), NULLIF(s.name, ''), 'Formulario importado') AS name,
       s.id AS site_id, s.name AS site_name,
       CASE WHEN NULLIF(${importedFormId}, '') IS NULL THEN 'imported_site' ELSE 'imported_form' END AS kind,
       s.status, ${importUpdatedAt} AS sort_updated_at,
       CASE WHEN NULLIF(${importedFormTitle}, '') IS NOT NULL AND ${importedFormTitle} != COALESCE(s.name, '')
         THEN 'Importado de ' || COALESCE(NULLIF(s.name, ''), 'sitio') ELSE 'Formulario importado' END AS meta,
       ${importSearchDocument} AS search_document
     FROM public_site_imports i
     INNER JOIN public_sites s ON s.id = i.site_id
     CROSS JOIN ${automationFormsImportMappingSource()}
     WHERE COALESCE(s.status, 'draft') != 'archived'
       AND s.id != '${CALENDAR_DEFAULT_FORM_SITE_ID.replaceAll("'", "''")}'
       AND (NULLIF(${importedFormId}, '') IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM public_site_blocks native_block
         WHERE native_block.site_id = s.id
           AND native_block.block_type IN (${automationFormFieldBlockTypesSql})
       ))`
  ]
}

async function queryAutomationFormsCatalogBranch(baseSql, { limit, search, cursor, selectedIds }) {
  const predicates = []
  const params = []
  if (selectedIds.length) {
    predicates.push(`candidate.id IN (${selectedIds.map(() => '?').join(', ')})`)
    params.push(...selectedIds)
  } else {
    if (search) {
      predicates.push(`candidate.search_document LIKE ? ESCAPE '!'`)
      params.push(`%${escapeAutomationLikePattern(search.toLowerCase())}%`)
    }
    if (cursor) {
      predicates.push(`(candidate.sort_updated_at < ? OR (candidate.sort_updated_at = ? AND candidate.id < ?))`)
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id)
    }
  }
  params.push(limit + 1)
  const cursorProjection = usePostgres ? 'candidate.sort_updated_at::text' : 'candidate.sort_updated_at'
  return db.all(`
    SELECT candidate.*, ${cursorProjection} AS cursor_updated_at
    FROM (${baseSql}) candidate
    ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
    ORDER BY candidate.sort_updated_at DESC, candidate.id DESC
    LIMIT ?
  `, params)
}

function mapAutomationFormCatalogRow(row) {
  return mapAutomationFormOption({
    id: row.id,
    name: row.name,
    siteId: row.site_id,
    siteName: row.site_name,
    kind: row.kind,
    status: row.status,
    updatedAt: row.cursor_updated_at || row.sort_updated_at,
    meta: row.meta
  })
}

export async function listAutomationFormsCatalogPage({
  limit = DEFAULT_AUTOMATION_FORMS_CATALOG_LIMIT,
  cursor = '',
  search = '',
  selectedIds = []
} = {}) {
  const pageLimit = normalizeAutomationFormsCatalogLimit(limit)
  const normalizedSearch = cleanCatalogString(search).slice(0, 160)
  const normalizedSelectedIds = normalizeAutomationFormsSelectedIds(selectedIds)
  const scope = automationFormsCatalogCursorScope(normalizedSearch)
  const decodedCursor = normalizedSelectedIds.length ? null : decodeAutomationFormsCatalogCursor(cursor, scope)
  const branchRows = await Promise.all(buildAutomationFormsCatalogBranches().map(baseSql => (
    queryAutomationFormsCatalogBranch(baseSql, {
      limit: normalizedSelectedIds.length ? Math.min(50, normalizedSelectedIds.length) : pageLimit,
      search: normalizedSelectedIds.length ? '' : normalizedSearch,
      cursor: decodedCursor,
      selectedIds: normalizedSelectedIds
    })
  )))
  const seen = new Set()
  const rows = branchRows.flat()
    .sort((left, right) => (
      String(right.cursor_updated_at || right.sort_updated_at).localeCompare(String(left.cursor_updated_at || left.sort_updated_at)) ||
      String(right.id).localeCompare(String(left.id))
    ))
    .filter(row => {
      const id = cleanCatalogString(row.id)
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })

  if (normalizedSelectedIds.length) {
    const byId = new Map(rows.map(row => [cleanCatalogString(row.id), mapAutomationFormCatalogRow(row)]))
    return {
      items: normalizedSelectedIds.map(id => byId.get(id)).filter(Boolean),
      hasMore: false,
      nextCursor: null,
      limit: pageLimit
    }
  }

  const pageRows = rows.slice(0, pageLimit)
  const hasMore = rows.length > pageLimit || branchRows.some(items => items.length > pageLimit)
  return {
    items: pageRows.map(mapAutomationFormCatalogRow),
    hasMore,
    nextCursor: hasMore ? encodeAutomationFormsCatalogCursor(pageRows[pageRows.length - 1], scope) : null,
    limit: pageLimit
  }
}

/** Compatibilidad acotada para consumidores internos antiguos. */
export async function listAutomationFormsCatalog(options = {}) {
  return (await listAutomationFormsCatalogPage(options)).items
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
  return rows.map((row) => {
    const log = parseLog(row.log)
    return {
      id: row.id,
      contactId: row.contact_id,
      contactName: row.contact_name || 'Contacto',
      status: row.status || 'active',
      currentNodeId: row.current_node_id || null,
      log,
      executionOutcome: deriveExecutionOutcome(row.status, row.execution_outcome, log),
      lastError: row.last_error || latestExecutionError(log, { unresolvedOnly: true }),
      resumeAt: row.resume_at || null,
      waitKind: row.wait_kind || null,
      enteredAt: row.entered_at,
      updatedAt: row.updated_at
    }
  })
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
  const activeStatuses = new Set(['active', 'waiting', 'paused'])
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

export async function controlAutomationEnrollment(automationId, enrollmentId, input = {}) {
  return controlEngineEnrollment({
    automationId,
    enrollmentId,
    action: input.action,
    targetNodeId: input.targetNodeId
  })
}

export async function testAutomationRun(automationId, input = {}) {
  const automation = await getSavedAutomationForTestRun(automationId)
  const contact = await resolveTestAutomationContact(input)
  const enrollment = await enrollContactManually({
    automationId: automation.id,
    contactId: contact.id,
    source: 'test-run',
    useSavedDraftFlow: true
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
     WHERE automation_id = ? AND status IN ('active', 'waiting', 'paused')
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

export async function listAutomationWhatsAppTemplatesCatalog({
  status = 'APPROVED',
  search = '',
  cursor = '',
  limit = 50
} = {}) {
  return getWhatsAppApiTemplatesCatalogPage({
    status: cleanCatalogString(status) || 'APPROVED',
    search,
    cursor,
    limit
  })
}

// ---------------------------------------------------------------------------
// Archivos adjuntos (imágenes/videos/audios/docs de los bloques de mensaje)
// ---------------------------------------------------------------------------

export async function saveAutomationAsset({ fileBase64, filename, userId, deliveryMode = '' }) {
  const { uploadMediaAssetFromDataUrl } = await import('./mediaStorageService.js')
  const cleanDeliveryMode = cleanCatalogString(deliveryMode).toLowerCase()
  const asset = await uploadMediaAssetFromDataUrl({
    fileBase64,
    filename,
    userId,
    module: 'automations',
    isPublic: true,
    // "Audio" conserva su archivo/calidad original. Sólo "Nota de voz" debe
    // normalizarse a OGG/Opus para la semántica PTT de WhatsApp.
    skipCompression: cleanDeliveryMode === 'audio',
    metadata: cleanDeliveryMode ? { automationDeliveryMode: cleanDeliveryMode } : undefined
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
