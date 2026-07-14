import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { db } from '../src/config/database.js'
import { getMediaAssetDownloadFile } from '../src/services/mediaStorageService.js'
import { attachmentDisposition } from '../src/utils/contentDisposition.js'
import {
  createImportedSiteFromHtml,
  deleteSite,
  getImportedSiteBySiteId,
  getPublicSiteContentAsset,
  getSite,
  listSiteContentAssets,
  renderPublicSiteHtml,
  saveSiteContentAsset,
  updateImportedSiteCodeFiles
} from '../src/services/sitesService.js'

async function insertPublicAsset(id, publicUrl, mediaType = 'image') {
  const metadataByType = {
    image: { extension: 'png', mimeType: 'image/png' },
    audio: { extension: 'mp3', mimeType: 'audio/mpeg' },
    video: { extension: 'mp4', mimeType: 'video/mp4' },
    document: { extension: 'pdf', mimeType: 'application/pdf' }
  }
  const metadata = metadataByType[mediaType] || { extension: 'bin', mimeType: 'application/octet-stream' }
  await db.run(`
    INSERT INTO media_assets (
      id, business_id, original_filename, stored_filename, public_url,
      mime_type, media_type, status, storage_provider, module,
      module_entity_id, is_public, created_at, updated_at
    ) VALUES (?, 'default', ?, ?, ?, ?, ?, 'ready', 'local', 'sites', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    `${id}.${metadata.extension}`,
    id,
    publicUrl,
    metadata.mimeType,
    mediaType
  ])
}

test('stable site downloads stream local bytes and produce an attachment-safe filename', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const assetId = `content_download_stream_${suffix}`
  const directory = await mkdtemp(join(tmpdir(), 'ristak-site-download-'))
  const localPath = join(directory, 'guia-final.pdf')
  const body = Buffer.from('archivo descargable real')

  try {
    await writeFile(localPath, body)
    await insertPublicAsset(assetId, `https://cdn.example.test/${assetId}.pdf`, 'document')
    await db.run(
      'UPDATE media_assets SET metadata_json = ?, size_processed = ? WHERE id = ?',
      [JSON.stringify({ localPath }), body.length, assetId]
    )

    const file = await getMediaAssetDownloadFile(assetId)
    const chunks = []
    for await (const chunk of file.stream) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), body)
    assert.equal(file.contentType, 'application/pdf')
    assert.equal(file.contentLength, body.length)
    assert.equal(file.statusCode, 200)
    assert.equal(file.acceptRanges, 'bytes')
    assert.equal(
      attachmentDisposition('guía "final".pdf'),
      'attachment; filename="gu_a final.pdf"; filename*=UTF-8\'\'gu%C3%ADa%20final.pdf'
    )
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

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

test('code-first content slots resolve image, audio and downloads and upsert by the exact HTML key', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const assetIds = {
    firstImage: `content_image_first_${suffix}`,
    secondImage: `content_image_second_${suffix}`,
    audio: `content_audio_${suffix}`,
    document: `content_document_${suffix}`
  }
  let siteId = ''

  try {
    await insertPublicAsset(assetIds.firstImage, 'https://cdn.example.test/code-first-image-v1.png', 'image')
    await insertPublicAsset(assetIds.secondImage, 'https://cdn.example.test/code-first-image-v2.png', 'image')
    await insertPublicAsset(assetIds.audio, 'https://cdn.example.test/code-first-audio.mp3', 'audio')
    await insertPublicAsset(assetIds.document, 'https://cdn.example.test/code-first-guide.pdf', 'document')

    const created = await createImportedSiteFromHtml({
      filename: 'contenido-code-first.html',
      name: `Contenido code-first ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <img data-rstk-asset-id="inicio-imagen-01" data-rstk-label="Imagen principal" alt="Principal">
        <img data-rstk-asset-id="inicio-imagen-race" data-rstk-label="Imagen concurrente" alt="Concurrente">
        <audio data-rstk-asset-id="inicio-audio-01" data-rstk-label="Audio principal" controls></audio>
        <a data-rstk-asset-id="inicio-descarga-01" data-rstk-label="PDF informativo" download>Descargar guía</a>
        <a data-rstk-asset-id="inicio-descarga-imagen" data-rstk-label="Imagen descargable" download>Descargar imagen</a>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id

    const firstImageBinding = await saveSiteContentAsset(siteId, {
      assetKey: 'inicio-imagen-01',
      label: 'Imagen principal',
      mediaAssetId: assetIds.firstImage
    })
    await saveSiteContentAsset(siteId, {
      assetKey: 'inicio-audio-01',
      label: 'Audio principal',
      mediaAssetId: assetIds.audio
    })
    await saveSiteContentAsset(siteId, {
      assetKey: 'inicio-descarga-01',
      label: 'PDF informativo',
      mediaAssetId: assetIds.document
    })
    await saveSiteContentAsset(siteId, {
      assetKey: 'inicio-descarga-imagen',
      label: 'Imagen descargable',
      mediaAssetId: assetIds.firstImage
    })

    const concurrentBindings = await Promise.all([
      saveSiteContentAsset(siteId, {
        assetKey: 'inicio-imagen-race',
        label: 'Imagen concurrente',
        mediaAssetId: assetIds.firstImage
      }),
      saveSiteContentAsset(siteId, {
        assetKey: 'inicio-imagen-race',
        label: 'Imagen concurrente',
        mediaAssetId: assetIds.secondImage
      })
    ])
    assert.equal(concurrentBindings[0].id, concurrentBindings[1].id)
    concurrentBindings.forEach(binding => {
      assert.equal(binding.mediaAssetId, binding.mediaAsset.id)
    })

    const replacedWithoutBindingId = await saveSiteContentAsset(siteId, {
      assetKey: 'inicio-imagen-01',
      label: 'Imagen principal',
      mediaAssetId: assetIds.secondImage
    })
    assert.equal(replacedWithoutBindingId.id, firstImageBinding.id)
    assert.equal(replacedWithoutBindingId.assetKey, 'inicio-imagen-01')

    const listed = await listSiteContentAssets(siteId)
    assert.equal(listed.length, 5)
    assert.equal(listed.filter(asset => asset.assetKey === 'inicio-imagen-01').length, 1)
    assert.equal(listed.some(asset => asset.assetKey === 'inicio-imagen-01-2'), false)
    assert.equal(listed.filter(asset => asset.assetKey === 'inicio-imagen-race').length, 1)
    assert.equal(listed.some(asset => asset.assetKey === 'inicio-imagen-race-2'), false)

    const site = await getSite(siteId, { includeBlocks: true })
    const html = await renderPublicSiteHtml(site, { preview: false, trackingEnabled: false })
    assert.match(html, /data-rstk-asset-id="inicio-imagen-01"[^>]*src="https:\/\/cdn\.example\.test\/code-first-image-v2\.png"/)
    assert.match(html, /data-rstk-asset-id="inicio-audio-01"[^>]*src="https:\/\/cdn\.example\.test\/code-first-audio\.mp3"/)
    assert.match(html, new RegExp(`data-rstk-asset-id="inicio-descarga-01"[^>]*href="/api/sites/public/content-assets/${siteId}/inicio-descarga-01\\?download=1"[^>]*download="${assetIds.document}\\.pdf"`))
    assert.match(html, new RegExp(`data-rstk-asset-id="inicio-descarga-imagen"[^>]*href="/api/sites/public/content-assets/${siteId}/inicio-descarga-imagen\\?download=1"[^>]*download="${assetIds.firstImage}\\.png"`))
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id IN (?, ?, ?, ?)', Object.values(assetIds)).catch(() => undefined)
  }
})

test('legacy managed iframe without src survives sanitization and resolves its video binding', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const videoAssetId = `content_legacy_iframe_${suffix}`
  let siteId = ''

  try {
    await insertPublicAsset(
      videoAssetId,
      'https://player.vimeo.com/video/12345',
      'video'
    )
    const created = await createImportedSiteFromHtml({
      filename: 'contenido-iframe-legacy.html',
      name: `Contenido iframe legacy ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from(`<!doctype html><html><body>
        <iframe data-rstk-asset-id="video-legacy" title="Video anterior"></iframe>
        <iframe src="javascript:alert('no')"></iframe>
      </body></html>`, 'utf8').toString('base64')
    })
    siteId = created.site.id

    const importedSite = await getImportedSiteBySiteId(siteId)
    assert.match(importedSite.htmlSanitized, /<iframe[^>]*data-rstk-asset-id="video-legacy"[^>]*><\/iframe>/)
    assert.doesNotMatch(importedSite.htmlSanitized, /javascript:alert/)

    await saveSiteContentAsset(siteId, {
      assetKey: 'video-legacy',
      label: 'Video anterior',
      mediaAssetId: videoAssetId
    })

    const site = await getSite(siteId, { includeBlocks: true })
    const html = await renderPublicSiteHtml(site, { preview: false, trackingEnabled: false })
    assert.match(html, /data-rstk-asset-id="video-legacy"[^>]*src="https:\/\/player\.vimeo\.com\/video\/12345"/)
    assert.doesNotMatch(html, /javascript:alert/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id = ?', [videoAssetId]).catch(() => undefined)
  }
})

test('code-first content association rejects undeclared keys and incompatible media types', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const audioAssetId = `content_wrong_audio_${suffix}`
  const imageAssetId = `content_undeclared_image_${suffix}`
  let siteId = ''

  try {
    await insertPublicAsset(audioAssetId, 'https://cdn.example.test/wrong-audio.mp3', 'audio')
    await insertPublicAsset(imageAssetId, 'https://cdn.example.test/undeclared-image.png', 'image')
    const created = await createImportedSiteFromHtml({
      filename: 'contenido-validado.html',
      name: `Contenido validado ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from('<!doctype html><html><body><img data-rstk-asset-id="imagen-principal" alt="Principal"><div data-rstk-asset-id="zona-no-resoluble"></div></body></html>', 'utf8').toString('base64')
    })
    siteId = created.site.id

    await assert.rejects(
      () => saveSiteContentAsset(siteId, {
        assetKey: 'imagen-principal',
        mediaAssetId: audioAssetId
      }),
      /espera una imagen/
    )
    await assert.rejects(
      () => saveSiteContentAsset(siteId, {
        assetKey: 'imagen-que-no-existe',
        mediaAssetId: imageAssetId
      }),
      /no declara ninguna zona de contenido/
    )
    await assert.rejects(
      () => saveSiteContentAsset(siteId, {
        assetKey: 'zona-no-resoluble',
        mediaAssetId: imageAssetId
      }),
      /no declara ninguna zona de contenido/
    )
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id IN (?, ?)', [audioAssetId, imageAssetId]).catch(() => undefined)
  }
})

test('changing a declared slot type keeps an old incompatible binding out of the render until it is replaced', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const imageAssetId = `content_stale_image_${suffix}`
  const audioAssetId = `content_stale_audio_${suffix}`
  let siteId = ''

  try {
    await insertPublicAsset(imageAssetId, 'https://cdn.example.test/stale-image.png', 'image')
    await insertPublicAsset(audioAssetId, 'https://cdn.example.test/replacement-audio.mp3', 'audio')
    const created = await createImportedSiteFromHtml({
      filename: 'contenido-cambia-tipo.html',
      name: `Contenido cambia tipo ${suffix}`,
      siteType: 'landing_page',
      fileBase64: Buffer.from('<!doctype html><html><body><img data-rstk-asset-id="contenido-principal" alt="Principal"></body></html>', 'utf8').toString('base64')
    })
    siteId = created.site.id

    await saveSiteContentAsset(siteId, {
      assetKey: 'contenido-principal',
      mediaAssetId: imageAssetId
    })
    await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: '',
        content: '<!doctype html><html><body><audio data-rstk-asset-id="contenido-principal" controls></audio></body></html>'
      }]
    })

    const changedSite = await getSite(siteId, { includeBlocks: true })
    const incompatibleHtml = await renderPublicSiteHtml(changedSite, { preview: false, trackingEnabled: false })
    assert.doesNotMatch(incompatibleHtml, /stale-image\.png/)

    await saveSiteContentAsset(siteId, {
      assetKey: 'contenido-principal',
      mediaAssetId: audioAssetId
    })
    const compatibleHtml = await renderPublicSiteHtml(changedSite, { preview: false, trackingEnabled: false })
    assert.match(compatibleHtml, /data-rstk-asset-id="contenido-principal"[^>]*src="https:\/\/cdn\.example\.test\/replacement-audio\.mp3"/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id IN (?, ?)', [imageAssetId, audioAssetId]).catch(() => undefined)
  }
})
