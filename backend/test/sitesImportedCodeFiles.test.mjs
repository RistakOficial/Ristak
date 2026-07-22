import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('imported HTML code files are listed and saved through the code editor endpoint', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml,
    updateImportedSiteCodeFiles
  } = await import('../src/services/sitesService.js')

  let siteId = ''

  try {
    const html = '<!doctype html><html><head><title>Code file test</title></head><body><main><h1>Original heading</h1><p>Original copy</p></main></body></html>'
    const created = await createImportedSiteFromHtml({
      filename: 'code-file-test.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Code File Test ${Date.now()}`
    })
    siteId = created.site.id

    assert.equal(created.import.codeFiles.length, 1)
    assert.equal(created.import.codeFiles[0].path, '')
    assert.equal(created.import.codeFiles[0].language, 'html')
    assert.match(created.import.codeFiles[0].content, /Original heading/)
    assert.match(created.import.codeFiles[0].content, /<h1[^>]*data-rstk-video-action-target="titulo"/)
    assert.match(created.import.codeFiles[0].content, /<p[^>]*data-rstk-video-action-target="texto"/)

    const updatedContent = created.import.codeFiles[0].content.replace('>Original heading<', '>Edited from code<')
    const updated = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: updatedContent }]
    })

    assert.match(updated.import.codeFiles[0].content, /Edited from code/)

    const previewSite = await getSitePreview(siteId)
    const rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /Edited from code/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('removing the last HTML form keeps its stable mapping dormant for a future reappearance', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml,
    updateImportedSiteCodeFiles
  } = await import('../src/services/sitesService.js')

  let siteId = ''
  try {
    const created = await createImportedSiteFromHtml({
      filename: 'remove-form.html',
      siteType: 'landing_page',
      name: `Remove Form ${Date.now()}`,
      fileBase64: Buffer.from('<!doctype html><html><body><form data-rstk-form="lead_capture"><label for="email">Correo</label><input id="email" name="email" type="email"></form></body></html>', 'utf8').toString('base64')
    })
    siteId = created.site.id
    assert.equal(created.import.detectedForms.length, 1)
    assert.equal(created.import.formMappings.length, 1)

    const updated = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: '', content: '<!doctype html><html><body><main><h1>Sin formulario</h1></main></body></html>' }]
    })
    assert.deepEqual(updated.import.detectedForms, [])
    assert.equal(updated.import.formMappings.length, 1)
    assert.equal(updated.import.formMappings[0].formId, 'lead_capture')
    assert.equal(updated.import.formMappings[0].present, false)
    assert.ok(updated.import.formMappings[0].fields.length > 0)
    assert.ok(updated.import.formMappings[0].fields.every(field => field.present === false))

    const rendered = await renderPublicSiteHtml(await getSitePreview(siteId), {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    assert.doesNotMatch(rendered, /"formId":"lead_capture"/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('AI HTML draft edit never saves code when the full-page assistant cannot produce a draft', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getImportedSiteBySiteId,
    updateImportedSiteHtmlWithAI
  } = await import('../src/services/sitesService.js')

  let siteId = ''

  try {
    const html = '<!doctype html><html><head><title>AI draft test</title></head><body><main><h1 id="hero-title">Original heading</h1><button id="hero-cta">Original CTA</button></main></body></html>'
    const created = await createImportedSiteFromHtml({
      filename: 'ai-draft-test.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `AI Draft Test ${Date.now()}`
    })
    siteId = created.site.id

    const storedHtml = created.import.codeFiles[0].content
    const currentDraftHtml = storedHtml.replace('Original heading', 'Draft heading from editor')
    const prompt = [
      'Solicitud del usuario:',
      'cambia el título a "AI assistant heading"',
      '',
      'Reglas para esta edición:',
      '- Devuelve el HTML completo actualizado.'
    ].join('\n')

    await assert.rejects(
      () => updateImportedSiteHtmlWithAI(siteId, {
        siteKind: 'landing',
        pageId: 'page-1',
        draftOnly: true,
        currentHtml: currentDraftHtml,
        aiRegionRequest: 'cambia el título a "AI assistant heading"',
        messages: [{ role: 'user', content: prompt }]
      }),
      error => error?.code === 'OPENAI_CREDENTIAL_REQUIRED'
    )

    const storedAfterDraft = await getImportedSiteBySiteId(siteId)
    assert.match(storedAfterDraft.htmlSanitized, /Original heading/)
    assert.doesNotMatch(storedAfterDraft.htmlSanitized, /AI assistant heading/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML code editor saves popup code as site popup HTML', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml,
    updateImportedSiteCodeFiles
  } = await import('../src/services/sitesService.js')

  let siteId = ''

  try {
    const html = '<!doctype html><html><head><title>Popup code test</title></head><body><main><h1>Página principal</h1><button data-rstk-button-action="open_popup">Abrir</button></main></body></html>'
    const created = await createImportedSiteFromHtml({
      filename: 'popup-code-test.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Popup Code Test ${Date.now()}`
    })
    siteId = created.site.id

    const popupHtml = [
      '<!doctype html>',
      '<html><head><style>.popup-code-title{color:#111827}</style></head>',
      '<body><section><h2 class="popup-code-title">Popup editado con código</h2><p>Contenido propio del pop up.</p></section></body></html>'
    ].join('')
    const updated = await updateImportedSiteCodeFiles(siteId, {
      files: [{ path: 'ristak-popup.html', content: popupHtml }]
    })

    const popupCodeFile = updated.import.codeFiles.find(file => file.path === 'ristak-popup.html')
    assert.ok(popupCodeFile)
    assert.equal(popupCodeFile.role, 'popup')
    assert.match(popupCodeFile.content, /Popup editado con código/)
    assert.match(updated.site.theme.importedPopupHtml, /Popup editado con código/)

    const previewSite = await getSitePreview(siteId)
    const rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /rstk-site-popup/)
    assert.match(rendered, /Popup editado con código/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML internal page links stay inside the site preview flow', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml,
    updateImportedSiteCodeFiles
  } = await import('../src/services/sitesService.js')
  const { db } = await import('../src/config/database.js')

  let siteId = ''

  try {
    const created = await createImportedSiteFromHtml({
      filename: 'inicio.html',
      siteType: 'landing_page',
      name: `Multi Page Links ${Date.now()}`,
      pages: [
        {
          id: 'page-1',
          title: 'Inicio',
          filename: 'inicio.html',
          html: '<!doctype html><html><head><title>Inicio</title></head><body><main><a id="next" href="gracias.html#detalle">Ir a gracias</a></main></body></html>'
        },
        {
          id: 'page-2',
          title: 'Gracias',
          filename: 'gracias.html',
          html: '<!doctype html><html><head><title>Gracias</title></head><body><main id="detalle"><h1>Gracias</h1><a href="inicio.html">Volver</a></main></body></html>'
        }
      ]
    })
    siteId = created.site.id

    let previewSite = await getSitePreview(siteId)
    let rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /href="\?page=page-2#detalle"/)
    assert.doesNotMatch(rendered, /href="\/api\/sites\/public\/imported-assets\/[^"]*gracias\.html/)

    const legacyHtml = `<!doctype html><html><head><title>Inicio</title></head><body><main><a id="next" href="/api/sites/public/imported-assets/${encodeURIComponent(siteId)}/gracias.html?legacy=1#detalle">Ir a gracias</a></main></body></html>`
    await db.run(`
      UPDATE public_site_import_assets
      SET content_base64 = ?, size_bytes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE site_id = ? AND asset_path = ?
    `, [
      Buffer.from(legacyHtml, 'utf8').toString('base64'),
      Buffer.byteLength(legacyHtml, 'utf8'),
      siteId,
      'inicio.html'
    ])

    previewSite = await getSitePreview(siteId)
    rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /href="\?page=page-2&amp;legacy=1#detalle"|href="\?page=page-2&legacy=1#detalle"/)
    assert.doesNotMatch(rendered, /href="\/api\/sites\/public\/imported-assets\/[^"]*gracias\.html/)

    await updateImportedSiteCodeFiles(siteId, {
      files: [{
        path: 'inicio.html',
        content: '<!doctype html><html><head><title>Inicio</title></head><body><main><a id="next" href="./gracias.html?src=cta#detalle">Ir a gracias</a></main></body></html>'
      }]
    })

    previewSite = await getSitePreview(siteId)
    rendered = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(rendered, /href="\?page=page-2&amp;src=cta#detalle"|href="\?page=page-2&src=cta#detalle"/)
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
  }
})

test('imported HTML preview rewrites Bunny Stream embeds to storage video', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml
  } = await import('../src/services/sitesService.js')
  const { db } = await import('../src/config/database.js')

  const assetId = `imported_stream_asset_${Date.now()}`
  const storageUrl = `https://cdn.example.com/imported/${assetId}.mp4`
  const streamVideoId = `stream-${assetId}`
  let siteId = ''

  try {
    await db.run(
      `INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, bunny_path,
        public_url, mime_type, media_type, extension,
        size_original, size_processed, quota_size, status,
        storage_provider, module, module_entity_id, is_public, metadata_json,
        stream_video_id
      ) VALUES (?, 'default', 'video.mp4', 'video.mp4', ?, ?, 'video/mp4', 'video', 'mp4', 128, 128, 128, 'ready', 'bunny', 'sites', ?, 1, ?, ?)`,
      [
        assetId,
        `imported/${assetId}.mp4`,
        storageUrl,
        'imported-video-site',
        JSON.stringify({
          stream: {
            provider: 'bunny_stream',
            syncStatus: 'uploaded',
            libraryId: '123456',
            videoId: streamVideoId
          }
        }),
        streamVideoId
      ]
    )

    const html = `<!doctype html><html><head><title>Imported Bunny</title></head><body><main><iframe src="https://player.mediadelivery.net/embed/123456/${streamVideoId}" title="Stream"></iframe></main></body></html>`
    const created = await createImportedSiteFromHtml({
      filename: 'imported-bunny.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Imported Bunny ${Date.now()}`
    })
    siteId = created.site.id

    const previewSite = await getSitePreview(siteId)
    const previewHtml = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    const escapedStorageUrl = storageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(previewHtml, new RegExp(`src="${escapedStorageUrl}"`))
    assert.doesNotMatch(previewHtml, /no_track=1/)
    assert.doesNotMatch(previewHtml, /player\.mediadelivery\.net\/embed/)

    const liveHtml = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(liveHtml, new RegExp(`src="https://player\\.mediadelivery\\.net/embed/123456/${streamVideoId}"`))
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('imported HTML preview disables direct Bunny Stream assets until Storage exists', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml
  } = await import('../src/services/sitesService.js')
  const { db } = await import('../src/config/database.js')

  const assetId = `imported_direct_stream_${Date.now()}`
  const streamVideoId = `stream-${assetId}`
  const embedUrl = `https://iframe.mediadelivery.net/embed/123456/${streamVideoId}`
  let siteId = ''

  try {
    await db.run(
      `INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, bunny_path,
        public_url, mime_type, media_type, extension,
        size_original, size_processed, quota_size, status,
        storage_provider, module, module_entity_id, is_public, metadata_json
      ) VALUES (?, 'default', 'recording.mov', 'recording.mov', ?, ?, 'video/quicktime', 'video', 'mov', 128, 128, 128, 'ready', 'bunny_stream', 'sites', ?, 1, ?)`,
      [
        assetId,
        `stream/${streamVideoId}`,
        embedUrl,
        'imported-direct-video-site',
        JSON.stringify({
          stream: {
            provider: 'bunny_stream',
            syncStatus: 'uploaded',
            libraryId: '123456',
            videoId: streamVideoId
          }
        })
      ]
    )

    const html = `<!doctype html><html><head><title>Imported Bunny</title></head><body><main><iframe src="${embedUrl}" title="Stream"></iframe></main></body></html>`
    const created = await createImportedSiteFromHtml({
      filename: 'imported-direct-bunny.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Imported direct Bunny ${Date.now()}`
    })
    siteId = created.site.id

    const previewSite = await getSitePreview(siteId)
    const previewHtml = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(previewHtml, /data-rstk-preview-stream-disabled="true"/)
    assert.match(previewHtml, /Preparando vista previa del video/)
    assert.doesNotMatch(previewHtml, new RegExp(`<iframe[^>]+src="${escapeRegExp(embedUrl)}"`))
    assert.doesNotMatch(previewHtml, new RegExp(`<video[^>]+src="${escapeRegExp(embedUrl)}"`))
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('imported Media video bindings disable Stream in preview and keep its iframe live', async () => {
  const {
    createImportedSiteFromHtml,
    deleteSite,
    getSitePreview,
    renderPublicSiteHtml
  } = await import('../src/services/sitesService.js')
  const { db } = await import('../src/config/database.js')

  const assetId = `bound_direct_stream_${Date.now()}`
  const streamVideoId = `stream-${assetId}`
  const embedUrl = `https://iframe.mediadelivery.net/embed/123456/${streamVideoId}`
  const assetKey = 'video-principal'
  let siteId = ''

  try {
    await db.run(
      `INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, bunny_path,
        public_url, mime_type, media_type, extension,
        size_original, size_processed, quota_size, status,
        storage_provider, module, module_entity_id, is_public, metadata_json
      ) VALUES (?, 'default', 'recording.mov', 'recording.mov', ?, ?, 'video/quicktime', 'video', 'mov', 128, 128, 128, 'ready', 'bunny_stream', 'sites', ?, 1, ?)`,
      [
        assetId,
        `stream/${streamVideoId}`,
        embedUrl,
        'imported-bound-video-site',
        JSON.stringify({
          stream: {
            provider: 'bunny_stream',
            syncStatus: 'uploaded',
            libraryId: '123456',
            videoId: streamVideoId
          }
        })
      ]
    )

    const html = `<!doctype html><html><head><title>Bound Bunny</title></head><body><main><video data-rstk-asset-id="${assetKey}" controls playsinline></video></main></body></html>`
    const created = await createImportedSiteFromHtml({
      filename: 'bound-direct-bunny.html',
      fileBase64: Buffer.from(html, 'utf8').toString('base64'),
      siteType: 'landing_page',
      name: `Bound direct Bunny ${Date.now()}`
    })
    siteId = created.site.id

    await db.run(
      `INSERT INTO public_site_content_assets (
        id, site_id, asset_key, label, kind, media_asset_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'Video principal', 'video', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`site_asset_${Date.now()}`, siteId, assetKey, assetId]
    )

    const previewSite = await getSitePreview(siteId)
    const previewHtml = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    const liveHtml = await renderPublicSiteHtml(previewSite, {
      pageId: 'page-1',
      trackingEnabled: true,
      preview: false
    })

    assert.match(previewHtml, /data-rstk-preview-stream-disabled="true"/)
    assert.doesNotMatch(previewHtml, new RegExp(`<iframe[^>]+src="${escapeRegExp(embedUrl)}"`))
    assert.match(liveHtml, new RegExp(`<iframe[^>]+data-rstk-asset-id="${assetKey}"[^>]+src="${escapeRegExp(embedUrl)}"`))
    assert.doesNotMatch(liveHtml, new RegExp(`<video[^>]+src="${escapeRegExp(embedUrl)}"`))
  } finally {
    if (siteId) await deleteSite(siteId).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
  }
})

test('AI HTML editor instructions stay scoped to active code only', async () => {
  const { buildSitesAIHtmlInstructions } = await import('../src/services/sitesService.js')

  const instructions = buildSitesAIHtmlInstructions({
    siteKind: 'landing',
    editMode: true,
    agentConfig: {
      business_context: 'Clinica secreta del negocio',
      market_context: 'Mercado privado guardado',
      ideal_customer: 'Cliente ideal guardado',
      brand_voice: 'Voz de marca del chatbot'
    }
  })

  assert.match(instructions, /Alcance privado del editor HTML/)
  assert.match(instructions, /Solo puedes usar el HTML\/CSS\/JS activo/)
  assert.match(instructions, /No tienes acceso al contexto del negocio/)
  assert.match(instructions, /Esta prohibido responderle al usuario dentro del HTML/)
  assert.match(instructions, /Aplica cambios en silencio/)
  assert.match(instructions, /El HTML es el resultado final/)
  assert.match(instructions, /data-rstk-asset-id="inicio-imagen-01"/)
  assert.match(instructions, /data-rstk-background-asset-id="inicio-fondo-01"/)
  assert.match(instructions, /data-rstk-asset-id="inicio-audio-01"/)
  assert.match(instructions, /data-rstk-asset-id="inicio-descarga-01"/)
  assert.match(instructions, /claves multimedia son globales al sitio/)
  assert.match(instructions, /primero declara la zona en el HTML/)
  assert.match(instructions, /data-rstk-native-element="video"/)
  assert.match(instructions, /data-rstk-native-element="social-profile"/)
  assert.match(instructions, /data-rstk-native-render="custom"/)
  assert.match(instructions, /data-rstk-social-avatar/)
  assert.match(instructions, /data-rstk-social-name/)
  assert.match(instructions, /data-rstk-social-followers/)
  assert.match(instructions, /data-rstk-social-verified/)
  assert.match(instructions, /contenedor raíz del perfil debe medir únicamente lo que ocupa su contenido/)
  assert.match(instructions, /No le pongas height, min-height, max-height, block-size/)
  assert.match(instructions, /unidades de viewport como vh\/svh\/dvh/)
  assert.match(instructions, /Cierra el contenedor raíz inmediatamente después del diseño visual del perfil/)
  assert.match(instructions, /sin un bloque vacío ni una altura de pantalla completa/)
  assert.match(instructions, /No inventes .*seguidores.*no llames Meta desde el navegador/i)
  assert.match(instructions, /Un video HTML propio queda opaco/)
  assert.match(instructions, /El slot nativo de video NO define la geometria del reproductor/)
  assert.match(instructions, /padding porcentual/)
  assert.match(instructions, /data-rstk-video-rules/)
  assert.match(instructions, /timeline_reached/)
  assert.match(instructions, /playback_seconds/)
  assert.match(instructions, /unique_watched_percent/)
  assert.match(instructions, /adelantar la barra sí cuenta/)
  assert.match(instructions, /3 minutos = 180/)
  assert.match(instructions, /data-rstk-video-action-target/)
  assert.match(instructions, /"deleted":true/)
  assert.match(instructions, /No escribas JavaScript para escuchar el video/)
  assert.match(instructions, /elemento <form> real/)
  assert.match(instructions, /REQUISITO OBLIGATORIO DE ENTREGA/)
  assert.match(instructions, /no termines ni respondas status="ready"/)
  assert.match(instructions, /name, id, data-rstk-field y los atributos data-rstk-calendar-\* NO sustituyen/)
  assert.match(instructions, /data-rstk-form-id semantico, estable y unico en TODO el sitio/)
  assert.match(instructions, /data-rstk-field-id estable y unico dentro de su formulario/)
  assert.match(instructions, /<form data-rstk-calendar-book-form>/)
  assert.match(instructions, /NO es un formulario independiente de captación/)
  assert.match(instructions, /data-rstk-calendar-name required/)
  assert.doesNotMatch(instructions, /data-rstk-calendar-name data-rstk-field-id="agenda-nombre"/)
  assert.match(instructions, /experiencia completa tipo Calendly/)
  assert.match(instructions, /data-rstk-calendar-step="date"/)
  assert.match(instructions, /data-rstk-calendar-month-label/)
  assert.match(instructions, /data-rstk-calendar-days/)
  assert.match(instructions, /data-rstk-calendar-slots/)
  assert.match(instructions, /data-rstk-calendar-step="success"/)
  assert.match(instructions, /no hardcodees fechas ni decidas disponibilidad en HTML/)
  assert.doesNotMatch(instructions, /Dentro agrega input date con data-rstk-calendar-date/)
  assert.match(instructions, /<fieldset><legend>Pregunta<\/legend>/)
  assert.match(instructions, /Cambiar copy, clases, estilos, orden o name\/id NO cambia data-rstk-form-id ni data-rstk-field-id/)
  assert.doesNotMatch(instructions, /data-rstk-editable="true"/)
  assert.match(instructions, /action="disqualify"/)
  assert.match(instructions, /disqualifyOutcome="specific_page"/)
  assert.match(instructions, /data-rstk-conversion-condition="qualified_only"/)
  assert.match(instructions, /solo manda Pixel\/CAPI cuando el resultado sea calificado/)
  assert.match(instructions, /@media \(max-width: 640px\)/)
  assert.match(instructions, /viewport de 390px/)
  assert.match(instructions, /no debe existir scroll horizontal/)
  assert.match(instructions, /al menos 44px de alto/)
  assert.match(instructions, /font-size de al menos 16px/)
  assert.match(instructions, /No simules móvil con zoom, transform: scale/)
  assert.doesNotMatch(instructions, /no agregues acciones para descalificar/i)
  assert.doesNotMatch(instructions, /Clinica secreta del negocio/)
  assert.doesNotMatch(instructions, /Mercado privado guardado/)
  assert.doesNotMatch(instructions, /Cliente ideal guardado/)
  assert.doesNotMatch(instructions, /Voz de marca del chatbot/)
  assert.doesNotMatch(instructions, /Contexto del negocio configurado en Ristak/)
})

test('external AI compatibility instructions reject forms without stable Ristak IDs', async () => {
  const {
    buildImportedHtmlCustomCalendarRulesText,
    buildImportedHtmlCustomSocialProfileRulesText,
    buildImportedHtmlVideoActionTargetRulesText,
    ensureImportedHtmlVideoActionTargets
  } = await import('../../shared/sites/importedHtmlContract.js')
  const source = await readFile(new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url), 'utf8')
  const guideMatch = source.match(/const IMPORTED_HTML_AI_GUIDE = `[\s\S]*?const IMPORTED_HTML_MOBILE_PREVIEW_STYLE/)
  const builderMatch = source.match(/const buildExternalAICompatibilityText[\s\S]*?\nconst copyTextToClipboard/)

  assert.ok(guideMatch, 'No se encontró la guía del editor HTML')
  assert.ok(builderMatch, 'No se encontró el bloque copiable para IA externa')

  const guide = guideMatch[0]
  const builder = builderMatch[0]
  const calendarGuide = buildImportedHtmlCustomCalendarRulesText()
  const socialProfileGuide = buildImportedHtmlCustomSocialProfileRulesText()
  const videoTargetGuide = buildImportedHtmlVideoActionTargetRulesText()

  assert.match(guide, /REQUISITO OBLIGATORIO DE ENTREGA/)
  assert.match(guide, /La única excepción es el <form data-rstk-calendar-book-form>/)
  assert.match(guide, /buildImportedHtmlCustomCalendarRulesText/)
  assert.match(guide, /El slot nativo de video no controla la geometría/)
  assert.match(guide, /Ristak detecta la orientación real del archivo/)
  assert.match(guide, /ocupa todo el ancho disponible en móvil conservando 9:16/)
  assert.match(guide, /No fabriques franjas laterales, marcos negros/)
  assert.match(guide, /buildImportedHtmlCustomSocialProfileRulesText/)
  assert.match(guide, /buildImportedHtmlVideoActionTargetRulesText/)
  assert.match(socialProfileGuide, /data-rstk-native-element="social-profile"/)
  assert.match(socialProfileGuide, /data-rstk-social-avatar/)
  assert.match(socialProfileGuide, /data-rstk-social-verified/)
  assert.match(socialProfileGuide, /altura de pantalla completa/)
  assert.match(videoTargetGuide, /aunque todavía no exista ninguna regla/)
  assert.match(videoTargetGuide, /Cada CTA, botón, enlace, formulario, sección, bloque de texto, título, imagen, figura y slot nativo/)
  assert.match(videoTargetGuide, /data-rstk-video-action-target semántico, estable y único/)
  assert.match(videoTargetGuide, /no agregues targets a sus controles internos/)
  assert.match(builder, /No entregues el HTML si falta uno solo/)
  assert.match(calendarGuide, /No le agregues data-rstk-form-id, data-rstk-field-id, data-rstk-conversion-event ni data-rstk-conversion-type/)
  assert.match(builder, /buildImportedHtmlCustomCalendarRulesText\('Calendario:'\)/)
  assert.match(builder, /El formulario interno de un calendario custom queda fuera de esta comprobación/)
  assert.match(builder, /No pongas width\/max-width, height\/min-height\/max-height, aspect-ratio/)
  assert.match(builder, /No dibujes franjas laterales ni un marco negro falso/)
  assert.match(builder, /ancho completo y ancho manual por vista se configuran en el panel/)
  assert.match(builder, /Perfil de red social:/)
  assert.match(builder, /ChatGPT, Claude o Codex diseñarán el perfil/)
  assert.match(builder, /buildImportedHtmlCustomSocialProfileRulesText\('Reglas del perfil custom:'\)/)
  assert.match(socialProfileGuide, /No inventes .*seguidores.*verificado/)
  assert.match(source, /invalidSocialProfileDeclarations/)
  assert.match(source, /Perfiles sociales incompletos/)
  assert.match(calendarGuide, /experiencia completa tipo Calendly/)
  assert.match(calendarGuide, /data-rstk-calendar-prev-month/)
  assert.match(calendarGuide, /data-rstk-calendar-month-label/)
  assert.match(calendarGuide, /data-rstk-calendar-days/)
  assert.match(calendarGuide, /data-state="available"/)
  assert.match(calendarGuide, /data-rstk-calendar-slots/)
  assert.match(calendarGuide, /data-rstk-calendar-selected-datetime/)
  assert.match(calendarGuide, /data-rstk-calendar-success/)
  assert.match(calendarGuide, /Ristak vuelve a validar el horario al reservar/)
  assert.doesNotMatch(calendarGuide, /data-rstk-calendar-date/)

  const legacyHtml = '<!doctype html><html><body><main><h1>Oferta</h1><section data-rstk-native-element="calendar" data-rstk-native-id="agenda"><button type="button">Mes siguiente</button><p>Texto interno</p></section><a class="button" data-rstk-button-actions=\'[{"id":"aplicar-ahora","action":"next_page"}]\' href="?page=2">Aplicar</a></main></body></html>'
  const normalizedLegacyHtml = ensureImportedHtmlVideoActionTargets(legacyHtml)
  assert.match(normalizedLegacyHtml, /<h1[^>]*data-rstk-video-action-target="titulo"/)
  assert.match(normalizedLegacyHtml, /data-rstk-native-id="agenda"[^>]*data-rstk-video-action-target="agenda"/)
  assert.match(normalizedLegacyHtml, /<a[^>]*data-rstk-video-action-target="aplicar-ahora"/)
  assert.doesNotMatch(normalizedLegacyHtml, /<button[^>]*data-rstk-video-action-target/)
  assert.doesNotMatch(normalizedLegacyHtml, /<p[^>]*data-rstk-video-action-target[^>]*>Texto interno/)
  assert.equal(ensureImportedHtmlVideoActionTargets(normalizedLegacyHtml), normalizedLegacyHtml)
})

test('video design panel exposes responsive portrait sizing without storing the mode in a device override', async () => {
  const source = await readFile(new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url), 'utf8')

  assert.match(source, /Automático · completo en móvil/)
  assert.match(source, /Completo · todas las vistas/)
  assert.match(source, /Manual · ancho por vista/)
  assert.match(source, /Ancho video · \$\{device === 'desktop' \? 'computadora' : device === 'mobile' \? 'móvil' : 'tablet'\}/)
  assert.match(source, /value=\{getVideoPortraitWidthMode\(rawSettings\)\}/)
  assert.match(source, /onPatchSettingsProp\(\{ videoPortraitWidthMode: next \}\)/)
  assert.match(source, /En automático, un video vertical usa todo el ancho en móvil/)
})

test('HTML mobile rules are shared by every creation path and the code preview uses a real phone viewport', async () => {
  const {
    IMPORTED_HTML_MOBILE_BREAKPOINT_PX,
    IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX,
    IMPORTED_HTML_MOBILE_RULES,
    areImportedNativeResponsiveVariants,
    resolveVisibleImportedNativeElementSelection,
    buildImportedHtmlMobileRulesText
  } = await import('../../shared/sites/importedHtmlContract.js')
  const source = await readFile(new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../../frontend/src/pages/Sites/Sites.module.css', import.meta.url), 'utf8')

  assert.equal(IMPORTED_HTML_MOBILE_BREAKPOINT_PX, 640)
  assert.equal(IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX, 390)
  assert.ok(IMPORTED_HTML_MOBILE_RULES.length >= 8)

  const mobileGuide = buildImportedHtmlMobileRulesText()
  assert.match(mobileGuide, /@media \(max-width: 640px\)/)
  assert.match(mobileGuide, /viewport de 390px/)
  assert.match(mobileGuide, /scroll horizontal/)
  assert.match(mobileGuide, /al menos 44px/)
  assert.match(mobileGuide, /al menos 16px/)
  assert.match(mobileGuide, /No simules móvil con zoom, transform: scale/)
  assert.match(mobileGuide, /video-presentacion-desktop/)
  assert.equal(areImportedNativeResponsiveVariants('video-presentacion-escritorio', 'video-presentacion-movil'), true)
  assert.equal(areImportedNativeResponsiveVariants('video-testimonio-escritorio', 'video-presentacion-movil'), false)
  assert.equal(resolveVisibleImportedNativeElementSelection({
    slots: [
      { id: 'video-presentacion-escritorio', key: 'video:video-presentacion-escritorio', type: 'video' },
      { id: 'video-presentacion-movil', key: 'video:video-presentacion-movil', type: 'video' },
      { id: 'video-testimonio-movil', key: 'video:video-testimonio-movil', type: 'video' }
    ],
    currentKey: 'video:video-presentacion-escritorio',
    visibleKeys: ['video:video-presentacion-movil', 'video:video-testimonio-movil']
  }), 'video:video-presentacion-movil')

  const sharedPromptUses = source.match(/buildImportedHtmlMobileRulesText\(/g) || []
  assert.ok(sharedPromptUses.length >= 5, 'La guía móvil debe llegar a creación, edición y asistentes HTML')
  assert.match(source, /\.\.\.IMPORTED_HTML_MOBILE_RULES\.map/)
  assert.match(source, /<details className=\{styles\.importedCodeGuide\}>/)
  assert.match(source, /title="Mostrar u ocultar las reglas completas para HTML y móvil"/)
  assert.match(source, /data-preview-device=\{device\}/)
  assert.match(source, /onLoad=\{\(event\) => syncImportedNativeElementSelectionForFrame\(event\.currentTarget\)\}/)

  assert.match(styles, /\.importedCodePreviewStageMobile \.importedCodePreviewFrame[\s\S]*?width: min\(var\(--imported-html-mobile-preview-width, 390px\), 100%\)/)
  assert.doesNotMatch(styles, /\.importedCodePreviewStageMobile \.importedCodePreviewFrame\s*\{\s*width:\s*100%/)
  const nativeControlsStyles = styles.match(/\.importedNativeElementControls\s*\{([^}]*)\}/)?.[1] || ''
  assert.doesNotMatch(nativeControlsStyles, /border-top|padding-top/)
})

test('AI HTML editor sends uploaded references as multimodal input parts', async () => {
  const {
    buildSitesAIResponsesInput,
    normalizeSitesAIReferenceAttachments
  } = await import('../src/services/sitesService.js')

  const attachments = normalizeSitesAIReferenceAttachments([
    {
      name: 'referencia.png',
      size: 12,
      mimeType: 'image/png',
      kind: 'image',
      dataUrl: 'data:image/png;base64,aGVsbG8='
    },
    {
      name: 'brief.pdf',
      size: 16,
      mimeType: 'application/pdf',
      kind: 'pdf',
      dataUrl: 'data:application/pdf;base64,aGVsbG8='
    },
    {
      name: 'copy.md',
      size: 20,
      mimeType: 'text/markdown',
      kind: 'text',
      text: 'Usa este tono para el hero.'
    }
  ])

  assert.equal(attachments.length, 3)
  assert.equal(attachments[0].kind, 'image')
  assert.equal(attachments[1].kind, 'pdf')
  assert.equal(attachments[2].text, 'Usa este tono para el hero.')

  const input = buildSitesAIResponsesInput({
    currentHtml: '<!doctype html><html><body><h1>Demo</h1></body></html>',
    attachments
  })

  assert.equal(Array.isArray(input), true)
  const content = input[0].content
  assert.equal(content.some(part => part.type === 'input_image' && part.image_url === 'data:image/png;base64,aGVsbG8='), true)
  assert.equal(content.some(part => part.type === 'input_file' && part.filename === 'brief.pdf'), true)
  assert.equal(content.some(part => part.type === 'input_text' && /Contenido del archivo copy\.md/.test(part.text)), true)
  assert.equal(/data:image\/png;base64,aGVsbG8=/.test(content[0].text), false)
  assert.match(content[0].text, /contenido adjunto enviado como input_image\/input_file/)
})

test('AI HTML editor blocks assistant replies and prompt echoes inside page HTML', async () => {
  const { getSitesAIEditorReplyContaminationReason } = await import('../src/services/sitesService.js')

  const promptEchoPage = {
    html: '<!doctype html><html><body><main><h1>Hazme un sitio web sobre perros</h1><p>Servicios para mascotas.</p></main></body></html>'
  }
  assert.equal(
    getSitesAIEditorReplyContaminationReason(promptEchoPage, {
      aiRegionRequest: 'Hazme un sitio web sobre perros'
    }),
    'prompt_echo'
  )

  const assistantReplyPage = {
    html: '<!doctype html><html><body><main><p>Claro, aqui tienes el sitio web actualizado.</p><h1>Veterinaria Luna</h1></main></body></html>'
  }
  assert.equal(
    getSitesAIEditorReplyContaminationReason(assistantReplyPage, {
      aiRegionRequest: 'cambia el titulo'
    }),
    'assistant_reply_copy'
  )

  const cleanPage = {
    html: '<!doctype html><html><body><main><h1>Veterinaria Luna</h1><p>Cuidado moderno para perros y gatos.</p></main></body></html>'
  }
  assert.equal(
    getSitesAIEditorReplyContaminationReason(cleanPage, {
      aiRegionRequest: 'Hazme un sitio web sobre perros'
    }),
    ''
  )
})
