import crypto from 'crypto'
import { db } from '../config/database.js'
import { normalizeFlow, validateFlowForPublish, START_NODE_TYPE } from './automationFlowValidation.js'

const usePostgres = !!process.env.DATABASE_URL
const flowPlaceholder = usePostgres ? '?::jsonb' : '?'

export const AUTOMATION_STATUSES = ['draft', 'published', 'paused', 'archived']

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function notFound(message) {
  const error = new Error(message)
  error.status = 404
  return error
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

function mapAutomationRow(row, { includeFlow = false } = {}) {
  const automation = {
    id: row.id,
    folderId: row.folder_id || null,
    name: row.name,
    description: row.description || '',
    status: row.status || 'draft',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null
  }

  if (includeFlow) {
    automation.flow = normalizeFlow(parseFlow(row.flow))
  }

  return automation
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
    `SELECT id, folder_id, name, description, status, created_at, updated_at, published_at
     FROM automations
     ORDER BY updated_at DESC, created_at DESC`
  )
  return rows.map((row) => mapAutomationRow(row))
}

export async function getAutomation(automationId) {
  const row = await db.get('SELECT * FROM automations WHERE id = ?', [automationId])
  if (!row) throw notFound('Automatización no encontrada')
  return mapAutomationRow(row, { includeFlow: true })
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
  if (input.status !== undefined) {
    if (!AUTOMATION_STATUSES.includes(input.status)) {
      throw badRequest('Estado de automatización inválido')
    }
    status = input.status

    if (status === 'published' && current.status !== 'published') {
      const errors = validateFlowForPublish(flow)
      if (errors.length > 0) {
        const error = badRequest(errors.join('. '))
        error.validationErrors = errors
        throw error
      }
      publishedAt = new Date().toISOString()
    }
  }

  await db.run(
    `UPDATE automations
     SET name = ?, description = ?, folder_id = ?, status = ?, flow = ${flowPlaceholder},
         published_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [name, description, folderId, status, JSON.stringify(flow), publishedAt, automationId]
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

export async function getAutomationsOverview() {
  const [folders, automations] = await Promise.all([listFolders(), listAutomations()])
  return { folders, automations }
}

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
