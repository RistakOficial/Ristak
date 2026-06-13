import 'dotenv/config'
import { db } from '../src/config/database.js'
import { uploadMediaAsset } from '../src/services/mediaStorageService.js'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const includeSiteImportAssets = args.has('--include-site-import-assets')
const limitArg = process.argv.find(arg => arg.startsWith('--limit='))
const limit = Math.max(1, Number(limitArg?.split('=')[1] || 500) || 500)

function isTextSiteAsset(contentType = '') {
  return /^(text\/html|text\/css|application\/javascript|text\/javascript|application\/json)\b/i.test(String(contentType || ''))
}

async function alreadyMigrated(legacyType, legacyId) {
  const row = await db.get(
    `SELECT id FROM media_assets
     WHERE metadata_json LIKE ?
       AND deleted_at IS NULL
     LIMIT 1`,
    [`%"legacyType":"${legacyType}"%"legacyId":"${legacyId}"%`]
  )
  return row?.id || ''
}

async function migrateAutomationAssets() {
  const rows = await db.all(
    `SELECT * FROM automation_assets
     ORDER BY created_at ASC
     LIMIT ?`,
    [limit]
  )
  const results = []

  for (const row of rows) {
    const existingId = await alreadyMigrated('automation_assets', row.id)
    if (existingId) {
      results.push({ legacyType: 'automation_assets', legacyId: row.id, status: 'already_migrated', mediaAssetId: existingId })
      continue
    }

    const sizeBytes = Number(row.size_bytes || 0)
    const item = {
      legacyType: 'automation_assets',
      legacyId: row.id,
      filename: row.filename || row.id,
      contentType: row.content_type,
      sizeBytes,
      status: apply ? 'pending' : 'dry_run'
    }

    if (apply) {
      const asset = await uploadMediaAsset({
        buffer: Buffer.from(row.content_base64 || '', 'base64'),
        mimeType: row.content_type,
        filename: row.filename || `${row.id}`,
        module: 'automations',
        moduleEntityId: row.id,
        isPublic: true,
        metadata: {
          legacyType: 'automation_assets',
          legacyId: row.id
        }
      })
      item.status = 'migrated'
      item.mediaAssetId = asset.id
      item.publicUrl = asset.publicUrl
    }

    results.push(item)
  }

  return results
}

async function migrateSiteImportAssets() {
  if (!includeSiteImportAssets) return []

  const rows = await db.all(
    `SELECT * FROM public_site_import_assets
     ORDER BY created_at ASC
     LIMIT ?`,
    [limit]
  )
  const results = []

  for (const row of rows) {
    if (isTextSiteAsset(row.content_type)) {
      results.push({ legacyType: 'public_site_import_assets', legacyId: row.id, assetPath: row.asset_path, status: 'skipped_text_asset' })
      continue
    }

    const existingId = await alreadyMigrated('public_site_import_assets', row.id)
    if (existingId) {
      results.push({ legacyType: 'public_site_import_assets', legacyId: row.id, status: 'already_migrated', mediaAssetId: existingId })
      continue
    }

    const item = {
      legacyType: 'public_site_import_assets',
      legacyId: row.id,
      siteId: row.site_id,
      assetPath: row.asset_path,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes || 0),
      status: apply ? 'pending' : 'dry_run'
    }

    if (apply) {
      const asset = await uploadMediaAsset({
        buffer: Buffer.from(row.content_base64 || '', 'base64'),
        mimeType: row.content_type,
        filename: row.asset_path || row.id,
        module: 'sites',
        moduleEntityId: row.site_id,
        isPublic: true,
        metadata: {
          legacyType: 'public_site_import_assets',
          legacyId: row.id,
          legacyAssetPath: row.asset_path
        }
      })
      item.status = 'migrated'
      item.mediaAssetId = asset.id
      item.publicUrl = asset.publicUrl
    }

    results.push(item)
  }

  return results
}

const startedAt = new Date().toISOString()
const automationResults = await migrateAutomationAssets()
const siteResults = await migrateSiteImportAssets()
const results = [...automationResults, ...siteResults]

console.log(JSON.stringify({
  apply,
  includeSiteImportAssets,
  limit,
  startedAt,
  finishedAt: new Date().toISOString(),
  total: results.length,
  migrated: results.filter(item => item.status === 'migrated').length,
  dryRun: results.filter(item => item.status === 'dry_run').length,
  skipped: results.filter(item => String(item.status).startsWith('skipped')).length,
  alreadyMigrated: results.filter(item => item.status === 'already_migrated').length,
  results
}, null, 2))

