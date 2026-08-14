import { db } from '../config/database.js'
import { createRistakId } from '../utils/idGenerator.js'

const DEFAULT_PAGE_ID = 'page-1'

function clean(value) {
  return String(value || '').trim()
}

function parseObject(value) {
  if (!value) return {}
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value }
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parsePages(site = {}) {
  const theme = parseObject(site.theme_json || site.theme)
  const rawPages = Array.isArray(theme.pages) ? theme.pages : []
  const pages = rawPages
    .map((page, index) => ({
      id: clean(page?.id || page?.pageId || page?.page_id) || (index === 0 ? DEFAULT_PAGE_ID : `page-${index + 1}`),
      title: clean(page?.title || page?.name) || `Página ${index + 1}`,
      slug: clean(page?.slug),
      parentPageId: clean(page?.parentPageId || page?.parent_page_id),
      sortOrder: Number(page?.sortOrder ?? page?.sort_order ?? index)
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder)

  return pages.length
    ? pages
    : [{ id: DEFAULT_PAGE_ID, title: 'Página 1', slug: '', parentPageId: '', sortOrder: 0 }]
}

function slugifyPageSegment(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function pagePath(pages, pageId) {
  const byId = new Map(pages.map(page => [page.id, page]))
  const segments = []
  const seen = new Set()
  let current = byId.get(pageId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const segment = slugifyPageSegment(current.slug || current.title)
    if (segment) segments.unshift(segment)
    current = current.parentPageId ? byId.get(current.parentPageId) : null
  }
  return segments.length ? `/${segments.join('/')}` : '/'
}

function blockSettings(block = {}) {
  return parseObject(block.settings_json || block.settings)
}

function blockType(block = {}) {
  return clean(block.block_type || block.blockType)
}

function blockId(block = {}) {
  return clean(block.id || block.block_id || block.blockId)
}

async function resolveVideoAsset(database, block = {}) {
  if (blockType(block) !== 'video') return null
  const settings = blockSettings(block)
  const explicitAssetId = clean(settings.mediaAssetId || settings.media_asset_id)
  if (explicitAssetId) {
    return database.get(`
      SELECT id, original_filename, stored_filename, public_url, stream_video_id, created_at
      FROM media_assets
      WHERE id = ? AND media_type = 'video'
      LIMIT 1
    `, [explicitAssetId])
  }

  const mediaUrl = clean(settings.mediaUrl || settings.media_url || block.content)
  if (!mediaUrl) return null
  return database.get(`
    SELECT id, original_filename, stored_filename, public_url, stream_video_id, created_at
    FROM media_assets
    WHERE public_url = ? AND media_type = 'video'
    ORDER BY CASE WHEN deleted_at IS NULL AND status != 'deleted' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `, [mediaUrl])
}

async function resolveCanonicalAssetId(database, siteId, placementBlockId, mediaAssetId, override = '') {
  const explicit = clean(override)
  if (explicit) return explicit
  const row = await database.get(`
    SELECT canonical_asset_id
    FROM site_video_metric_lineage
    WHERE site_id = ? AND block_id = ? AND asset_id = ?
    LIMIT 1
  `, [siteId, placementBlockId, mediaAssetId])
  return clean(row?.canonical_asset_id) || mediaAssetId
}

async function buildPlacementSnapshot(database, site, block, canonicalAssetIdOverride = '') {
  const placementBlockId = blockId(block)
  if (!placementBlockId) return null
  const asset = await resolveVideoAsset(database, block)
  if (!asset?.id) return null

  const settings = blockSettings(block)
  const pages = parsePages(site)
  const requestedPageId = clean(
    settings.pageId || settings.page_id || settings.analyticsPageId || settings.analytics_page_id
  )
  const page = pages.find(item => item.id === requestedPageId) || pages[0]
  const resolvedPageId = clean(page?.id) || requestedPageId || DEFAULT_PAGE_ID
  const resolvedPageTitle = clean(
    settings.analyticsPageTitle || settings.analytics_page_title || page?.title
  ) || 'Página 1'

  return {
    siteId: clean(site.id),
    blockId: placementBlockId,
    mediaAssetId: clean(asset.id),
    canonicalAssetId: await resolveCanonicalAssetId(
      database,
      clean(site.id),
      placementBlockId,
      clean(asset.id),
      canonicalAssetIdOverride
    ),
    publicPageId: resolvedPageId,
    pageTitle: resolvedPageTitle,
    pagePath: clean(settings.analyticsPagePath || settings.analytics_page_path) || pagePath(pages, resolvedPageId),
    assetName: clean(asset.original_filename || asset.stored_filename || block.label) || 'Video',
    assetPublicUrl: clean(asset.public_url),
    streamVideoId: clean(asset.stream_video_id),
    activatedAt: block.created_at || block.createdAt || asset.created_at || null
  }
}

function samePlacement(row = {}, snapshot = {}) {
  return clean(row.media_asset_id) === snapshot.mediaAssetId &&
    clean(row.canonical_asset_id) === snapshot.canonicalAssetId &&
    clean(row.public_page_id) === snapshot.publicPageId
}

async function insertActivePlacement(database, snapshot) {
  const id = createRistakId('site_video_placement')
  await database.run(`
    INSERT INTO site_video_placements (
      id, site_id, block_id, media_asset_id, canonical_asset_id,
      public_page_id, page_title, page_path, asset_name, asset_public_url,
      stream_video_id, activated_at, deactivated_at, deactivation_reason,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP),
      NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `, [
    id,
    snapshot.siteId,
    snapshot.blockId,
    snapshot.mediaAssetId,
    snapshot.canonicalAssetId,
    snapshot.publicPageId || null,
    snapshot.pageTitle || null,
    snapshot.pagePath || null,
    snapshot.assetName || null,
    snapshot.assetPublicUrl || null,
    snapshot.streamVideoId || null,
    snapshot.activatedAt
  ])
  return id
}

async function refreshActivePlacement(database, rowId, snapshot) {
  await database.run(`
    UPDATE site_video_placements
    SET canonical_asset_id = ?, public_page_id = ?, page_title = ?, page_path = ?,
        asset_name = ?, asset_public_url = ?, stream_video_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    snapshot.canonicalAssetId,
    snapshot.publicPageId || null,
    snapshot.pageTitle || null,
    snapshot.pagePath || null,
    snapshot.assetName || null,
    snapshot.assetPublicUrl || null,
    snapshot.streamVideoId || null,
    rowId
  ])
}

async function closeActivePlacements(database, siteId, placementBlockId, reason) {
  await database.run(`
    UPDATE site_video_placements
    SET deactivated_at = CURRENT_TIMESTAMP,
        deactivation_reason = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE site_id = ? AND block_id = ? AND deactivated_at IS NULL
  `, [clean(reason) || 'block_updated', siteId, placementBlockId])
}

/**
 * Mantiene una bitácora por intervalo de cada video colocado en un bloque.
 * La transición y la mutación del bloque deben compartir la misma transacción
 * cuando el llamador ya dispone de una.
 */
export async function transitionSiteVideoPlacement({
  transaction = db,
  siteId = '',
  previousBlock = null,
  nextBlock = null,
  deactivationReason = 'block_updated',
  previousCanonicalAssetId = '',
  nextCanonicalAssetId = ''
} = {}) {
  const normalizedSiteId = clean(siteId || previousBlock?.site_id || previousBlock?.siteId || nextBlock?.site_id || nextBlock?.siteId)
  const placementBlockId = blockId(nextBlock || previousBlock || {})
  if (!normalizedSiteId || !placementBlockId) return null

  const site = await transaction.get(`
    SELECT id, name, site_type, theme_json
    FROM public_sites
    WHERE id = ?
    LIMIT 1
  `, [normalizedSiteId])
  if (!site) return null

  const previousSnapshot = previousBlock
    ? await buildPlacementSnapshot(transaction, site, previousBlock, previousCanonicalAssetId)
    : null
  const nextSnapshot = nextBlock
    ? await buildPlacementSnapshot(transaction, site, nextBlock, nextCanonicalAssetId)
    : null
  let activeRows = await transaction.all(`
    SELECT *
    FROM site_video_placements
    WHERE site_id = ? AND block_id = ? AND deactivated_at IS NULL
    ORDER BY activated_at DESC, id DESC
  `, [normalizedSiteId, placementBlockId])

  if (!activeRows.length && previousSnapshot) {
    await insertActivePlacement(transaction, previousSnapshot)
    activeRows = await transaction.all(`
      SELECT *
      FROM site_video_placements
      WHERE site_id = ? AND block_id = ? AND deactivated_at IS NULL
      ORDER BY activated_at DESC, id DESC
    `, [normalizedSiteId, placementBlockId])
  }

  // Las filas precargadas por migración pueden conocer el asset y la página,
  // pero no el título/ruta calculados desde el theme. Antes de cerrar ese
  // intervalo congelamos el snapshot completo para que un rename posterior de
  // la página no reescriba el pasado en Analíticas.
  const matchingPrevious = previousSnapshot
    ? activeRows.find(row => samePlacement(row, previousSnapshot)) || null
    : null
  if (matchingPrevious) {
    await refreshActivePlacement(transaction, matchingPrevious.id, previousSnapshot)
  }

  const matchingNext = nextSnapshot
    ? activeRows.find(row => samePlacement(row, nextSnapshot)) || null
    : null
  if (matchingNext) {
    await refreshActivePlacement(transaction, matchingNext.id, nextSnapshot)
    if (activeRows.length > 1) {
      await transaction.run(`
        UPDATE site_video_placements
        SET deactivated_at = CURRENT_TIMESTAMP,
            deactivation_reason = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE site_id = ? AND block_id = ? AND deactivated_at IS NULL AND id != ?
      `, [clean(deactivationReason) || 'block_updated', normalizedSiteId, placementBlockId, matchingNext.id])
    }
    return matchingNext.id
  }

  if (activeRows.length) {
    await closeActivePlacements(transaction, normalizedSiteId, placementBlockId, deactivationReason)
  }
  // `created_at` del bloque describe cuándo nació el bloque, no cuándo empezó
  // esta nueva colocación. En reemplazos, movimientos y restauraciones el nuevo
  // intervalo debe arrancar ahora; sólo el snapshot histórico anterior conserva
  // el `created_at` original cuando se reconstruye por primera vez.
  return nextSnapshot
    ? insertActivePlacement(transaction, { ...nextSnapshot, activatedAt: null })
    : null
}

export async function deactivateAllSiteVideoPlacements({
  transaction = db,
  siteId = '',
  reason = 'site_deleted'
} = {}) {
  const normalizedSiteId = clean(siteId)
  if (!normalizedSiteId) return
  await transaction.run(`
    UPDATE site_video_placements
    SET deactivated_at = CURRENT_TIMESTAMP,
        deactivation_reason = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE site_id = ? AND deactivated_at IS NULL
  `, [clean(reason) || 'site_deleted', normalizedSiteId])
}
