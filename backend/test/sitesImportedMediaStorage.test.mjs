import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

const ENV_KEYS = [
  'DATABASE_URL',
  'MEDIA_STORAGE_PROVIDER',
  'MEDIA_STORAGE_REQUIRE_BUNNY',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_REGION',
  'BUNNY_STORAGE_ENDPOINT',
  'BUNNY_STORAGE_API_KEY',
  'BUNNY_CDN_BASE_URL'
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = snapshot[key]
    }
  }
}

async function makeZipBase64() {
  const zip = new JSZip()
  zip.file('index.html', '<!doctype html><html><body><img src="./image.png" alt=""></body></html>')
  zip.file('image.png', ONE_PIXEL_PNG)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  return buffer.toString('base64')
}

test('ZIP imports store binary site assets through media storage, not DB base64', async () => {
  const previousEnv = snapshotEnv()
  let db = null
  let previousSettings = null
  let siteId = ''
  let mediaAssetId = ''

  try {
    delete process.env.DATABASE_URL
    delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    delete process.env.BUNNY_STORAGE_ZONE
    delete process.env.BUNNY_STORAGE_REGION
    delete process.env.BUNNY_STORAGE_ENDPOINT
    delete process.env.BUNNY_STORAGE_API_KEY
    delete process.env.BUNNY_CDN_BASE_URL
    process.env.MEDIA_STORAGE_PROVIDER = 'bunny'

    const [{ createImportedSiteFromHtml, deleteSite }, database] = await Promise.all([
      import('../src/services/sitesService.js'),
      import('../src/config/database.js')
    ])
    db = database.db
    previousSettings = await db.get(`
      SELECT bunny_storage_zone, bunny_storage_region, bunny_cdn_base_url, bunny_stream_library_id
      FROM storage_settings
      WHERE id = 1
    `)
    await db.run(`
      UPDATE storage_settings SET
        bunny_storage_zone = NULL,
        bunny_storage_region = NULL,
        bunny_cdn_base_url = NULL,
        bunny_stream_library_id = NULL
      WHERE id = 1
    `)

    const created = await createImportedSiteFromHtml({
      filename: 'zip-media-test.zip',
      fileBase64: await makeZipBase64(),
      name: `ZIP Media Test ${Date.now()}`
    })
    siteId = created.site.id

    const imageRow = await db.get(`
      SELECT *
      FROM public_site_import_assets
      WHERE site_id = ? AND asset_path = 'image.png'
    `, [siteId])

    assert.ok(imageRow)
    assert.equal(imageRow.content_base64, '')
    assert.match(imageRow.media_asset_id, /^rstk_media_[A-Za-z0-9]{20}$/)
    assert.match(imageRow.public_url, /\/media\/assets\/rstk_media_|^https?:\/\//)
    assert.equal(imageRow.storage_provider, 'local')
    mediaAssetId = imageRow.media_asset_id

    const mediaRow = await db.get('SELECT * FROM media_assets WHERE id = ?', [mediaAssetId])
    assert.ok(mediaRow)
    assert.equal(mediaRow.module, 'sites')
    assert.equal(mediaRow.module_entity_id, siteId)
    assert.equal(mediaRow.status, 'ready')

    await deleteSite(siteId)
    siteId = ''

    const deletedMediaRow = await db.get('SELECT status, deleted_at FROM media_assets WHERE id = ?', [mediaAssetId])
    assert.equal(deletedMediaRow.status, 'deleted')
    assert.ok(deletedMediaRow.deleted_at)
  } finally {
    if (siteId) {
      const { deleteSite } = await import('../src/services/sitesService.js')
      await deleteSite(siteId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    if (db && previousSettings) {
      await db.run(`
        UPDATE storage_settings SET
          bunny_storage_zone = ?,
          bunny_storage_region = ?,
          bunny_cdn_base_url = ?,
          bunny_stream_library_id = ?
        WHERE id = 1
      `, [
        previousSettings.bunny_storage_zone,
        previousSettings.bunny_storage_region,
        previousSettings.bunny_cdn_base_url,
        previousSettings.bunny_stream_library_id
      ]).catch(() => undefined)
    }
    restoreEnv(previousEnv)
  }
})
