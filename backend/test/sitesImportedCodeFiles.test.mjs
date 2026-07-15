import test from 'node:test'
import assert from 'node:assert/strict'

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
  assert.match(instructions, /Un video HTML propio queda opaco/)
  assert.match(instructions, /elemento <form> real/)
  assert.match(instructions, /data-rstk-form-id semantico, estable y unico en TODO el sitio/)
  assert.match(instructions, /data-rstk-field-id estable y unico dentro de su formulario/)
  assert.match(instructions, /<fieldset><legend>Pregunta<\/legend>/)
  assert.match(instructions, /Cambiar copy, clases, estilos, orden o name\/id NO cambia data-rstk-form-id ni data-rstk-field-id/)
  assert.doesNotMatch(instructions, /data-rstk-editable="true"/)
  assert.match(instructions, /action="disqualify"/)
  assert.match(instructions, /disqualifyOutcome="specific_page"/)
  assert.match(instructions, /data-rstk-conversion-condition="qualified_only"/)
  assert.match(instructions, /solo manda Pixel\/CAPI cuando el resultado sea calificado/)
  assert.doesNotMatch(instructions, /no agregues acciones para descalificar/i)
  assert.doesNotMatch(instructions, /Clinica secreta del negocio/)
  assert.doesNotMatch(instructions, /Mercado privado guardado/)
  assert.doesNotMatch(instructions, /Cliente ideal guardado/)
  assert.doesNotMatch(instructions, /Voz de marca del chatbot/)
  assert.doesNotMatch(instructions, /Contexto del negocio configurado en Ristak/)
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
