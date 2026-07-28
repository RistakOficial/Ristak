import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import JSZip from 'jszip'

import { db } from '../src/config/database.js'
import {
  createBlock,
  createImportedSiteFromHtml,
  deleteSite,
  getImportedSiteBySiteId,
  getSite,
  renderPublicSiteHtml,
  replaceImportedSiteFromUpload,
  updateImportedSiteFieldMapping
} from '../src/services/sitesService.js'

const fileData = value => Buffer.from(value, 'utf8').toString('base64')

async function zipData(files = {}) {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64')
}

async function deleteSites(siteIds = []) {
  for (const siteId of new Set(siteIds.filter(Boolean))) {
    await deleteSite(siteId).catch(() => undefined)
  }
}

function activeForm(imported, formId) {
  return imported?.formMappings?.find(mapping => (
    mapping.present !== false && mapping.formId === formId
  ))
}

test('reuploading the open HTML site preserves active associations and keeps removed ones dormant', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  const siteIds = []
  let siteId = ''

  const html = ({ headline, includeAssociations = true }) => `<!doctype html>
    <html>
      <head><title>Landing inteligente</title></head>
      <body>
        <main>
          <h1>${headline}</h1>
          ${includeAssociations ? `
            <div data-rstk-native-element="video" data-rstk-native-id="video-principal" data-rstk-label="Video principal"></div>
            <img data-rstk-asset-id="portada-principal" alt="Portada">
            <form data-rstk-form-id="lead-principal" data-rstk-label="Lead principal">
              <input name="email" type="email" data-rstk-field-id="correo-principal">
              <button type="submit">Enviar</button>
            </form>
          ` : ''}
        </main>
      </body>
    </html>`

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'landing.html',
      name: `Reupload HTML ${suffix}`,
      siteType: 'landing_page',
      fileBase64: fileData(html({ headline: 'Versión original' }))
    })
    siteId = created.site.id
    siteIds.push(siteId)

    const originalForm = activeForm(created.import, 'lead_principal')
    assert.ok(originalForm?.formSiteId)
    siteIds.push(originalForm.formSiteId)

    await updateImportedSiteFieldMapping(siteId, {
      pagePath: '',
      formId: 'lead_principal',
      fieldId: 'correo_principal',
      destinationType: 'standard',
      destinationKey: 'phone'
    })

    const siteWithVideo = await createBlock(siteId, {
      blockType: 'video',
      label: 'Video principal',
      settings: {
        pageId: 'page-1',
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-principal',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/video-conservado.mp4',
        videoControlsMode: 'clean'
      }
    })
    const videoBlock = siteWithVideo.blocks.find(block => (
      block.blockType === 'video' &&
      block.settings?.importedHtmlNativeSlotId === 'video-principal'
    ))
    assert.ok(videoBlock)

    await db.run(`
      INSERT INTO public_site_content_assets (
        id, site_id, asset_key, label, kind, media_asset_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      `site_content_asset_${suffix}`,
      siteId,
      'portada-principal',
      'Portada principal',
      'image',
      `media_backup_${suffix}`
    ])

    const updated = await replaceImportedSiteFromUpload(siteId, {
      filename: 'landing.html',
      fileBase64: fileData(html({ headline: 'Código actualizado' }))
    })

    assert.equal(updated.site.id, siteId)
    assert.match(updated.import.htmlSanitized, /Código actualizado/)
    assert.equal(updated.site.blocks.some(block => block.id === videoBlock.id), true)
    const updatedForm = activeForm(updated.import, 'lead_principal')
    assert.equal(updatedForm.formSiteId, originalForm.formSiteId)
    assert.equal(
      updatedForm.fields.find(field => field.fieldId === 'correo_principal')?.destinationKey,
      'phone'
    )
    assert.ok(await db.get(
      'SELECT id FROM public_site_content_assets WHERE site_id = ? AND asset_key = ?',
      [siteId, 'portada-principal']
    ))

    let rendered = await renderPublicSiteHtml(updated.site, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    assert.match(rendered, /data-rstk-native-mounted="true"/)
    assert.match(rendered, /video-conservado\.mp4/)

    const withoutAssociations = await replaceImportedSiteFromUpload(siteId, {
      filename: 'landing.html',
      fileBase64: fileData(html({
        headline: 'Versión sin elementos',
        includeAssociations: false
      }))
    })
    const dormantForm = withoutAssociations.import.formMappings.find(mapping => (
      mapping.formId === 'lead_principal'
    ))
    assert.equal(dormantForm?.present, false)
    assert.equal(
      withoutAssociations.site.blocks.some(block => block.id === videoBlock.id),
      true,
      'el bloque queda guardado como respaldo aunque no tenga slot activo'
    )
    assert.ok(await db.get(
      'SELECT id FROM public_site_content_assets WHERE site_id = ? AND asset_key = ?',
      [siteId, 'portada-principal']
    ))

    rendered = await renderPublicSiteHtml(withoutAssociations.site, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    assert.doesNotMatch(rendered, /video-conservado\.mp4/)
    assert.doesNotMatch(rendered, /data-rstk-native-slot-id="video-principal"/)

    const restored = await replaceImportedSiteFromUpload(siteId, {
      filename: 'landing.html',
      fileBase64: fileData(html({ headline: 'Elementos restaurados' }))
    })
    const restoredForm = activeForm(restored.import, 'lead_principal')
    assert.equal(restoredForm?.formSiteId, originalForm.formSiteId)
    assert.equal(
      restoredForm?.fields.find(field => field.fieldId === 'correo_principal')?.destinationKey,
      'phone'
    )
    rendered = await renderPublicSiteHtml(restored.site, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    assert.match(rendered, /video-conservado\.mp4/)
    assert.match(rendered, /data-rstk-native-slot-id="video-principal"/)
  } finally {
    await deleteSites(siteIds)
  }
})

test('reuploading an HTML site with an existing source form does not nest distributed locks', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  const siteIds = []
  const originalWithAdvisoryLock = db.withAdvisoryLock
  let restoreWithAdvisoryLock = false
  let pinnedLockDepth = 0
  const acquiredLocks = []

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'formulario-existente.html',
      name: `Reupload sin candados anidados ${suffix}`,
      siteType: 'landing_page',
      fileBase64: fileData(`<!doctype html><html><body>
        <form data-rstk-form-id="lead-principal" data-rstk-label="Lead principal">
          <input name="email" type="email" data-rstk-field-id="correo-principal">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`)
    })
    siteIds.push(created.site.id)
    siteIds.push(...created.import.formMappings.map(mapping => mapping.formSiteId))
    const sourceFormId = activeForm(created.import, 'lead_principal')?.formSiteId
    const sourceFormBefore = await getSite(sourceFormId, {
      includeBlocks: false,
      includeSubmissions: false
    })

    db.withAdvisoryLock = async (lockName, operation, options) => {
      if (pinnedLockDepth > 0) {
        throw Object.assign(
          new Error('No se puede abrir un candado distribuido dentro de otra transacción.'),
          { code: 'DATABASE_ADVISORY_LOCK_NESTED' }
        )
      }

      const pinsConnection = options?.pinConnection !== false
      if (pinsConnection) pinnedLockDepth += 1
      acquiredLocks.push({ lockName, pinConnection: options?.pinConnection })
      try {
        return await originalWithAdvisoryLock(lockName, operation, options)
      } finally {
        if (pinsConnection) pinnedLockDepth -= 1
      }
    }
    restoreWithAdvisoryLock = true

    const updated = await replaceImportedSiteFromUpload(created.site.id, {
      filename: 'formulario-existente.html',
      fileBase64: fileData(`<!doctype html><html><body>
        <h1>Código actualizado</h1>
        <form data-rstk-form-id="lead-principal" data-rstk-label="Lead principal">
          <input name="email" type="email" data-rstk-field-id="correo-principal">
          <button type="submit">Enviar</button>
        </form>
      </body></html>`)
    })

    assert.match(updated.import.htmlSanitized, /Código actualizado/)
    assert.equal(activeForm(updated.import, 'lead_principal')?.formSiteId, sourceFormId)
    assert.equal(
      (await getSite(sourceFormId, {
        includeBlocks: false,
        includeSubmissions: false
      }))?.status,
      sourceFormBefore?.status
    )
    assert.deepEqual(
      acquiredLocks.map(lock => lock.lockName),
      [
        `sites:imported-html:${created.site.id}`,
        `sites:imported-html:${sourceFormId}`
      ]
    )
    assert.equal(
      acquiredLocks.every(lock => lock.pinConnection === false),
      true,
      'site mutation locks must not pin their protected operations to the lock connection'
    )
  } finally {
    if (restoreWithAdvisoryLock) db.withAdvisoryLock = originalWithAdvisoryLock
    await deleteSites(siteIds)
  }
})

test('ZIP reuploads preserve page identity across removal, restoration and a unique folder rename', async () => {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  const siteIds = []
  let siteId = ''

  const homeHtml = version => `<!doctype html><html><head><title>Inicio</title></head><body>
    <h1>Inicio ${version}</h1><a href="pages/oferta.html">Oferta</a>
  </body></html>`
  const offerHtml = version => `<!doctype html><html><head><title>Oferta</title></head><body>
    <h1>Oferta ${version}</h1>
    <div data-rstk-native-element="video" data-rstk-native-id="video-oferta" data-rstk-label="Video oferta"></div>
  </body></html>`

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'embudo.zip',
      name: `Reupload ZIP ${suffix}`,
      siteType: 'landing_page',
      fileBase64: await zipData({
        'index.html': homeHtml('original'),
        'pages/oferta.html': offerHtml('original')
      })
    })
    siteId = created.site.id
    siteIds.push(siteId)

    const offerPage = created.site.theme.pages.find(page => (
      page.importedAssetPath === 'pages/oferta.html'
    ))
    assert.ok(offerPage)

    const siteWithVideo = await createBlock(siteId, {
      blockType: 'video',
      label: 'Video oferta',
      settings: {
        pageId: offerPage.id,
        importedHtmlNativeElement: true,
        importedHtmlNativeSlotId: 'video-oferta',
        importedHtmlNativeType: 'video',
        importedHtmlNativeRenderMode: 'ristak',
        mediaUrl: 'https://cdn.example.test/oferta-conservada.mp4'
      }
    })
    const videoBlock = siteWithVideo.blocks.find(block => (
      block.settings?.importedHtmlNativeSlotId === 'video-oferta'
    ))
    assert.ok(videoBlock)

    const removed = await replaceImportedSiteFromUpload(siteId, {
      filename: 'embudo.zip',
      fileBase64: await zipData({
        'index.html': homeHtml('sin oferta')
      })
    })
    assert.equal(removed.site.theme.pages.length, 1)
    assert.ok(
      removed.site.theme.importedPageIdentityArchive.some(entry => entry.id === offerPage.id),
      'la página retirada debe permanecer en el archivo interno de identidades'
    )
    assert.equal(removed.site.blocks.some(block => block.id === videoBlock.id), true)

    const restored = await replaceImportedSiteFromUpload(siteId, {
      filename: 'embudo.zip',
      fileBase64: await zipData({
        'index.html': homeHtml('restaurada'),
        'pages/oferta.html': offerHtml('restaurada')
      })
    })
    assert.equal(
      restored.site.theme.pages.find(page => page.importedAssetPath === 'pages/oferta.html')?.id,
      offerPage.id
    )

    const renamed = await replaceImportedSiteFromUpload(siteId, {
      filename: 'embudo.zip',
      fileBase64: await zipData({
        'index.html': homeHtml('carpeta nueva').replace('pages/oferta.html', 'dist/oferta.html'),
        'dist/oferta.html': offerHtml('carpeta nueva')
      })
    })
    const renamedOfferPage = renamed.site.theme.pages.find(page => (
      page.importedAssetPath === 'dist/oferta.html'
    ))
    assert.equal(renamedOfferPage?.id, offerPage.id)
    assert.equal(
      renamed.site.blocks.find(block => block.id === videoBlock.id)?.settings?.pageId,
      offerPage.id
    )

    const rendered = await renderPublicSiteHtml(
      await getSite(siteId, { includeBlocks: true }),
      {
        pageId: offerPage.id,
        trackingEnabled: false,
        preview: true
      }
    )
    assert.match(rendered, /Oferta carpeta nueva/)
    assert.match(rendered, /oferta-conservada\.mp4/)

    const ambiguous = await replaceImportedSiteFromUpload(siteId, {
      filename: 'embudo.zip',
      fileBase64: await zipData({
        'index.html': homeHtml('ambigua').replace('pages/oferta.html', 'a/oferta.html'),
        'a/oferta.html': offerHtml('candidata A'),
        'b/oferta.html': offerHtml('candidata B')
      })
    })
    assert.equal(
      ambiguous.site.theme.pages.some(page => page.id === offerPage.id),
      false,
      'dos basenames iguales no deben apropiarse de una asociación histórica por orden'
    )
    assert.ok(
      ambiguous.site.theme.importedPageIdentityArchive.some(entry => entry.id === offerPage.id)
    )

    const recoveredAfterAmbiguity = await replaceImportedSiteFromUpload(siteId, {
      filename: 'embudo.zip',
      fileBase64: await zipData({
        'index.html': homeHtml('recuperada').replace('pages/oferta.html', 'dist/oferta.html'),
        'dist/oferta.html': offerHtml('recuperada')
      })
    })
    assert.equal(
      recoveredAfterAmbiguity.site.theme.pages.find(page => page.importedAssetPath === 'dist/oferta.html')?.id,
      offerPage.id
    )

    const imported = await getImportedSiteBySiteId(siteId)
    assert.equal(imported.originalFilename, 'embudo.zip')
  } finally {
    await deleteSites(siteIds)
  }
})
