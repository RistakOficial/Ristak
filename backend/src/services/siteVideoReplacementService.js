import { databaseDialect, db } from '../config/database.js'
import { createRistakId } from '../utils/idGenerator.js'
import { transitionSiteVideoPlacement } from './siteVideoPlacementService.js'

export const SITE_VIDEO_METRICS_MODES = Object.freeze(['preserve', 'reset'])

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

function fail(message, status = 400, code = 'site_video_replacement_invalid') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function normalizeMetricsMode(value) {
  const mode = clean(value).toLowerCase()
  if (!SITE_VIDEO_METRICS_MODES.includes(mode)) {
    throw fail(
      'Elige si quieres conservar las métricas anteriores o empezar desde cero.',
      400,
      'site_video_metrics_mode_required'
    )
  }
  return mode
}

function finiteDuration(value) {
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.round(duration * 100) / 100
}

async function upsertMetricLineage(transaction, siteId, blockId, assetId, canonicalAssetId) {
  await transaction.run(`
    INSERT INTO site_video_metric_lineage (
      site_id, block_id, asset_id, canonical_asset_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(site_id, block_id, asset_id) DO UPDATE SET
      canonical_asset_id = excluded.canonical_asset_id,
      updated_at = CURRENT_TIMESTAMP
  `, [siteId, blockId, assetId, canonicalAssetId])
}

async function resolveCurrentAssetId(transaction, settings, blockContent) {
  const explicitAssetId = clean(settings.mediaAssetId || settings.media_asset_id)
  if (explicitAssetId) return explicitAssetId

  const currentUrl = clean(settings.mediaUrl || settings.media_url || blockContent)
  if (!currentUrl) return ''
  const row = await transaction.get(`
    SELECT id
    FROM media_assets
    WHERE public_url = ?
      AND media_type = 'video'
    ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `, [currentUrl])
  return clean(row?.id)
}

/**
 * Reemplaza el archivo de un bloque de video y registra, dentro de la misma
 * transacción, si el ledger histórico debe seguir al asset nuevo o quedar
 * separado. Nunca reescribe ni elimina eventos de reproducción.
 */
export async function replaceSiteVideo({
  siteId,
  blockId,
  replacementMediaAssetId,
  metricsMode,
  requestedByUserId = ''
} = {}) {
  const normalizedSiteId = clean(siteId)
  const normalizedBlockId = clean(blockId)
  const replacementAssetId = clean(replacementMediaAssetId)
  const mode = normalizeMetricsMode(metricsMode)

  if (!normalizedSiteId) throw fail('Falta el Site que contiene el video.', 400, 'site_id_required')
  if (!normalizedBlockId) throw fail('Falta el bloque de video que se va a reemplazar.', 400, 'site_video_block_id_required')
  if (!replacementAssetId) throw fail('Falta el video nuevo de Media.', 400, 'replacement_media_asset_id_required')

  return db.transaction(async transaction => {
    const lock = databaseDialect === 'postgres' ? ' FOR UPDATE' : ''
    const site = await transaction.get(
      `SELECT id FROM public_sites WHERE id = ?${lock}`,
      [normalizedSiteId]
    )
    if (!site) throw fail('El Site ya no existe.', 404, 'site_not_found')

    const block = await transaction.get(`
      SELECT id, site_id, block_type, label, content, settings_json, created_at
      FROM public_site_blocks
      WHERE id = ? AND site_id = ?${lock}
    `, [normalizedBlockId, normalizedSiteId])
    if (!block) throw fail('El bloque de video ya no existe en este Site.', 404, 'site_video_block_not_found')
    if (clean(block.block_type) !== 'video') {
      throw fail('El elemento seleccionado no es un bloque de video.', 409, 'site_block_is_not_video')
    }

    const replacementAsset = await transaction.get(`
      SELECT id, public_url, duration, original_filename, media_type
      FROM media_assets
      WHERE id = ?
        AND media_type = 'video'
        AND status = 'ready'
        AND deleted_at IS NULL
        AND is_public = 1${lock}
    `, [replacementAssetId])
    if (!replacementAsset) {
      throw fail(
        'El video nuevo no está listo o no es un archivo público de Media.',
        409,
        'replacement_video_not_ready'
      )
    }
    if (!clean(replacementAsset.public_url)) {
      throw fail('El video nuevo todavía no tiene una URL pública.', 409, 'replacement_video_url_missing')
    }

    const settings = parseObject(block.settings_json)
    const currentUrl = clean(settings.mediaUrl || settings.media_url || block.content)
    const currentAssetId = await resolveCurrentAssetId(transaction, settings, block.content)
    if (!currentUrl && !currentAssetId) {
      throw fail('Este bloque todavía no tiene un video para reemplazar.', 409, 'site_video_missing_current_asset')
    }
    if (currentAssetId && currentAssetId === replacementAssetId) {
      throw fail('Selecciona un video diferente al que ya está puesto.', 409, 'site_video_replacement_is_same_asset')
    }
    if (mode === 'preserve' && !currentAssetId) {
      throw fail(
        'Ristak no puede conservar las métricas porque el video actual no pertenece a Media. Elige empezar desde cero.',
        409,
        'site_video_current_asset_unresolved'
      )
    }

    const canonicalAssetId = replacementAssetId
    if (mode === 'preserve') {
      const currentLineage = await transaction.get(
        `SELECT canonical_asset_id FROM site_video_metric_lineage
         WHERE site_id = ? AND block_id = ? AND asset_id = ?`,
        [normalizedSiteId, normalizedBlockId, currentAssetId]
      )
      const replacementLineage = await transaction.get(
        `SELECT canonical_asset_id FROM site_video_metric_lineage
         WHERE site_id = ? AND block_id = ? AND asset_id = ?`,
        [normalizedSiteId, normalizedBlockId, replacementAssetId]
      )
      const currentCanonicalAssetId = clean(currentLineage?.canonical_asset_id) || currentAssetId
      const replacementCanonicalAssetId = clean(replacementLineage?.canonical_asset_id) || replacementAssetId

      await transaction.run(`
        UPDATE site_video_metric_lineage
        SET canonical_asset_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE site_id = ? AND block_id = ?
          AND canonical_asset_id IN (?, ?)
      `, [
        replacementAssetId,
        normalizedSiteId,
        normalizedBlockId,
        currentCanonicalAssetId,
        replacementCanonicalAssetId
      ])
      await upsertMetricLineage(transaction, normalizedSiteId, normalizedBlockId, currentCanonicalAssetId, replacementAssetId)
      await upsertMetricLineage(transaction, normalizedSiteId, normalizedBlockId, currentAssetId, replacementAssetId)
      await upsertMetricLineage(transaction, normalizedSiteId, normalizedBlockId, replacementCanonicalAssetId, replacementAssetId)
      await transaction.run(`
        UPDATE site_video_placements
        SET canonical_asset_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE site_id = ? AND block_id = ?
          AND (
            canonical_asset_id IN (?, ?)
            OR media_asset_id IN (?, ?)
          )
      `, [
        replacementAssetId,
        normalizedSiteId,
        normalizedBlockId,
        currentCanonicalAssetId,
        replacementCanonicalAssetId,
        currentAssetId,
        replacementAssetId
      ])
    }
    await upsertMetricLineage(transaction, normalizedSiteId, normalizedBlockId, replacementAssetId, canonicalAssetId)

    const replacementUrl = clean(replacementAsset.public_url)
    const nextSettings = {
      ...settings,
      mediaUrl: replacementUrl,
      mediaAssetId: replacementAssetId,
      videoDurationSource: replacementUrl,
      videoDurationSeconds: finiteDuration(replacementAsset.duration)
    }
    delete nextSettings.media_url
    delete nextSettings.media_asset_id

    const shouldReplaceContent = Boolean(currentUrl) && clean(block.content) === currentUrl
    const nextContent = shouldReplaceContent ? replacementUrl : block.content
    await transaction.run(`
      UPDATE public_site_blocks
      SET content = ?, settings_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND site_id = ?
    `, [nextContent, JSON.stringify(nextSettings), normalizedBlockId, normalizedSiteId])
    const updatedBlock = await transaction.get(`
      SELECT id, site_id, block_type, label, content, settings_json, created_at
      FROM public_site_blocks
      WHERE id = ? AND site_id = ?
    `, [normalizedBlockId, normalizedSiteId])
    await transitionSiteVideoPlacement({
      transaction,
      siteId: normalizedSiteId,
      previousBlock: block,
      nextBlock: updatedBlock,
      deactivationReason: mode === 'preserve' ? 'video_replaced_preserve' : 'video_replaced_reset',
      previousCanonicalAssetId: mode === 'preserve' ? replacementAssetId : '',
      nextCanonicalAssetId: replacementAssetId
    })

    const replacementId = createRistakId('site_video_replacement')
    await transaction.run(`
      INSERT INTO site_video_replacements (
        id, site_id, block_id, previous_asset_id, replacement_asset_id,
        metrics_mode, canonical_asset_id, requested_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      replacementId,
      normalizedSiteId,
      normalizedBlockId,
      currentAssetId || null,
      replacementAssetId,
      mode,
      canonicalAssetId,
      clean(requestedByUserId) || null
    ])

    return {
      id: replacementId,
      siteId: normalizedSiteId,
      blockId: normalizedBlockId,
      previousMediaAssetId: currentAssetId || null,
      replacementMediaAssetId: replacementAssetId,
      replacementUrl,
      replacementFilename: clean(replacementAsset.original_filename),
      metricsMode: mode,
      historicalMetricsPreserved: mode === 'preserve',
      canonicalMediaAssetId: canonicalAssetId,
      settings: nextSettings
    }
  })
}
