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

function mapAutomationRow(row, { includeFlow = false } = {}) {
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
    )
  }

  if (includeFlow) {
    automation.flow = normalizeFlow(draftFlow || parseFlow(row.flow))
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
