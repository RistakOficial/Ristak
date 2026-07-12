import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createImportedSiteFromHtml,
  deleteSite,
  getPublicSiteContentAsset,
  getSite,
  listSiteContentAssets,
  renderPublicSiteHtml,
  saveSiteContentAsset
} from '../src/services/sitesService.js'

async function insertPublicAsset(id, publicUrl, mediaType = 'image') {
  await db.run(`
    INSERT INTO media_assets (
      id, business_id, original_filename, stored_filename, public_url,
      mime_type, media_type, status, storage_provider, module,
      module_entity_id, is_public, created_at, updated_at
    ) VALUES (?, 'default', ?, ?, ?, ?, ?, 'ready', 'local', 'sites', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    `${id}.${mediaType === 'image' ? 'png' : 'bin'}`,
    id,
    publicUrl,
    mediaType === 'image' ? 'image/png' : 'application/octet-stream',
    mediaType
  ])
}

test('imported HTML resolves stable content keys and keeps them across file replacement', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const firstAssetId = `content_first_${suffix}`
  const secondAssetId = `content_second_${suffix}`
  let siteId = ''

  try {
    await insertPublicAsset(firstAssetId, 'https://cdn.example.test/hero-v1.png')
    await insertPublicAsset(secondAssetId, 'https://cdn.example.test/hero-v2.png')

    const created = await createImportedSiteFromHtml({
      filename: 'contenido-estable.html',
      name: `Contenido estable ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <img data-rstk-asset-id="hero-principal" src="https://fallback.invalid/old.png" alt="Hero">
        <section data-rstk-background-asset-id="hero-principal" style="background-image:url('https://fallback.invalid/bg.png')">Oferta</section>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id

    const binding = await saveSiteContentAsset(siteId, {
      assetKey: 'hero-principal',
      label: 'Hero principal',
      mediaAssetId: firstAssetId
    })
    assert.equal(binding.assetKey, 'hero-principal')
    assert.equal(binding.publicPath, `/api/sites/public/content-assets/${siteId}/hero-principal`)

    const site = await getSite(siteId, { includeBlocks: true })
    const firstHtml = await renderPublicSiteHtml(site, { preview: false, trackingEnabled: false })
    assert.match(firstHtml, /data-rstk-asset-id="hero-principal"[^>]*src="https:\/\/cdn\.example\.test\/hero-v1\.png"/)
    assert.match(firstHtml, /data-rstk-background-asset-id="hero-principal"[^>]*background-image: url\(&quot;https:\/\/cdn\.example\.test\/hero-v1\.png&quot;\)/)

    const replaced = await saveSiteContentAsset(siteId, {
      id: binding.id,
      mediaAssetId: secondAssetId,
      label: 'Hero principal'
    })
    assert.equal(replaced.assetKey, 'hero-principal')

    const secondHtml = await renderPublicSiteHtml(site, { preview: false, trackingEnabled: false })
    assert.doesNotMatch(secondHtml, /hero-v1\.png/)
    assert.match(secondHtml, /hero-v2\.png/)

    const listed = await listSiteContentAssets(siteId)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].mediaAssetId, secondAssetId)

    const publicBinding = await getPublicSiteContentAsset(siteId, 'hero-principal')
    assert.equal(publicBinding.mediaAsset.publicUrl, 'https://cdn.example.test/hero-v2.png')
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id IN (?, ?)', [firstAssetId, secondAssetId]).catch(() => undefined)
  }
})

test('duplicate native slot ids mount only once', async () => {
  let siteId = ''
  try {
    const created = await createImportedSiteFromHtml({
      filename: 'slots-duplicados.html',
      name: `Slots duplicados ${Date.now()}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <div data-rstk-native-element="video" data-rstk-native-id="video-principal"></div>
        <div data-rstk-native-element="video" data-rstk-native-id="video-principal"></div>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id
    const site = await getSite(siteId, { includeBlocks: true })
    const preview = await renderPublicSiteHtml(site, { preview: true, trackingEnabled: false })
    assert.equal((preview.match(/data-rstk-native-slot-id="video-principal"/g) || []).length, 2)
    assert.match(preview, /ID nativo duplicado/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})
